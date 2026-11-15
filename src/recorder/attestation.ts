import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { ReceiptBundle } from "./bundle";
import { fingerprintOf } from "./signing";

/**
 * Standard supply-chain attestations for Work Receipts: an in-toto Statement v1
 * whose subject is the git tree the checks ran against, wrapped in a DSSE
 * envelope signed with the user's Ed25519 receipt key. Any tool that reads
 * in-toto/DSSE can parse it; `verifyAttestation` checks it without this plugin's
 * receipt format.
 *
 * Specs: https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
 *        https://github.com/secure-systems-lab/dsse/blob/master/protocol.md
 */

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
/** Identifier for this predicate. Change only together with the predicate's shape. */
export const PREDICATE_TYPE = "https://github.com/iamGodofall/work-receipts/blob/main/docs/ATTESTATION.md#v0.2";
const MAX_SIGNATURES = 16;

export type WorkReceiptPredicate = {
  verdict: string;
  verdictReason: string;
  recorderVersion: string;
  sessionId: string;
  generatedAt: string;
  goal: string | null;
  contractDigest: string | null;
  eventLog: { intact: boolean; events: number; headHash: string | null };
  checks: { id: string; command: string; status: string; exitCode: number | null; outputDigest: string; checkedAt: string }[];
  scope: { filesChanged: number | null; outOfScope: string[]; checkInputsChanged: string[] };
  /** Ties the attestation to the full evidence bundle (receipt.json / receipt.html). */
  receiptBundleDigest: string;
  headCommit: string | null;
  /** Added lines written by agent file tools versus elsewhere; null when not measured. */
  authorship: { agentLines: number; otherLines: number } | null;
  signer: { algorithm: "ed25519"; publicKey: string; fingerprint: string };
};

export type InTotoStatement = {
  _type: typeof STATEMENT_TYPE;
  subject: { name: string; digest: Record<string, string> }[];
  predicateType: typeof PREDICATE_TYPE;
  predicate: WorkReceiptPredicate;
};

export type DsseEnvelope = {
  payloadType: string;
  payload: string;
  signatures: { keyid: string; sig: string }[];
};

/** DSSE pre-authentication encoding: binds the payload type to the signed bytes. */
export function pae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from("DSSEv1 " + type.length + " ", "utf8"),
    type,
    Buffer.from(" " + payload.length + " ", "utf8"),
    payload,
  ]);
}

export function buildStatement(bundle: ReceiptBundle, publicKeyPem: string): InTotoStatement {
  const receipt = bundle.receipt;
  if (!receipt.code?.available) throw new Error("The receipt does not identify its code, so there is no attestation subject.");
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: "work-tree", digest: { gitTree: receipt.code.tree } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      verdict: receipt.verdict,
      verdictReason: receipt.verdictReason,
      recorderVersion: receipt.recorderVersion,
      sessionId: receipt.sessionId,
      generatedAt: receipt.generatedAt,
      goal: receipt.contract.goal,
      contractDigest: receipt.contract.digest,
      eventLog: { intact: receipt.chain.valid, events: receipt.chain.checkedEvents, headHash: receipt.chain.headHash },
      checks: receipt.checks.map((check) => ({
        id: check.id, command: check.command, status: check.status, exitCode: check.exitCode,
        outputDigest: check.outputDigest, checkedAt: check.checkedAt,
      })),
      scope: {
        filesChanged: receipt.workingTree.available ? receipt.workingTree.changed.length : null,
        outOfScope: receipt.workingTree.outOfScope,
        checkInputsChanged: receipt.checkInputsChanged,
      },
      receiptBundleDigest: bundle.bundleDigest,
      headCommit: receipt.code.head,
      authorship: receipt.attribution?.available
        ? { agentLines: receipt.attribution.agentLines, otherLines: receipt.attribution.otherLines }
        : null,
      signer: { algorithm: "ed25519", publicKey: publicKeyPem, fingerprint: fingerprintOf(publicKeyPem) },
    },
  };
}

export function signStatement(statement: InTotoStatement, keys: { privateKeyPem: string; publicKeyPem: string }): DsseEnvelope {
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  const sig = sign(null, pae(PAYLOAD_TYPE, payload), createPrivateKey(keys.privateKeyPem));
  return {
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{ keyid: fingerprintOf(keys.publicKeyPem), sig: sig.toString("base64") }],
  };
}

export type AttestationCheck =
  | { valid: true; statement: InTotoStatement; fingerprint: string; pinned: boolean }
  | { valid: false; problem: string };

/**
 * Verify a DSSE envelope. With `trustedPublicKeyPem` the signature must come
 * from that key; with `expectFingerprint` the embedded signer must match it.
 * Without either, the signature is checked against the key the statement names,
 * which shows integrity but not identity (`pinned: false`).
 */
export function verifyAttestation(
  input: unknown,
  options: { trustedPublicKeyPem?: string; expectFingerprint?: string } = {},
): AttestationCheck {
  const envelope = input as Partial<DsseEnvelope> | null;
  if (!envelope || typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures)) {
    return { valid: false, problem: "Not a DSSE envelope." };
  }
  if (envelope.payloadType !== PAYLOAD_TYPE) return { valid: false, problem: "Payload type is not in-toto." };
  // One key signs these envelopes; a long list only costs the verifier time.
  if (envelope.signatures.length === 0 || envelope.signatures.length > MAX_SIGNATURES) {
    return { valid: false, problem: "Expected between 1 and " + MAX_SIGNATURES + " signatures." };
  }
  const payload = Buffer.from(envelope.payload, "base64");
  if (payload.toString("base64") !== envelope.payload.replace(/\s/g, "")) return { valid: false, problem: "Payload is not valid base64." };

  let statement: InTotoStatement;
  try {
    statement = JSON.parse(payload.toString("utf8"));
  } catch {
    return { valid: false, problem: "Payload is not JSON." };
  }
  if (statement?._type !== STATEMENT_TYPE) return { valid: false, problem: "Payload is not an in-toto Statement v1." };
  if (statement.predicateType !== PREDICATE_TYPE) return { valid: false, problem: "Predicate is not a Work Receipt " + PREDICATE_TYPE + "." };
  const tree = statement.subject?.[0]?.digest?.gitTree;
  if (typeof tree !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) return { valid: false, problem: "Subject has no git tree digest." };

  const keyPem = options.trustedPublicKeyPem ?? statement.predicate?.signer?.publicKey;
  if (typeof keyPem !== "string") return { valid: false, problem: "No public key to verify with." };
  let fingerprint: string;
  try {
    fingerprint = fingerprintOf(keyPem);
  } catch {
    return { valid: false, problem: "Public key is unreadable." };
  }
  if (options.expectFingerprint && fingerprint !== options.expectFingerprint) {
    return { valid: false, problem: "Signed key " + fingerprint + " is not the expected key " + options.expectFingerprint + "." };
  }
  if (statement.predicate?.signer?.fingerprint !== fingerprint) {
    return { valid: false, problem: "The statement names a different signer than the verifying key." };
  }
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(keyPem);
  } catch {
    return { valid: false, problem: "Public key is unreadable." };
  }
  const signedBytes = pae(PAYLOAD_TYPE, payload);
  const signed = envelope.signatures.some((entry) => {
    if (!entry || typeof entry.sig !== "string") return false;
    try {
      return verify(null, signedBytes, publicKey, Buffer.from(entry.sig, "base64"));
    } catch {
      return false;
    }
  });
  if (!signed) return { valid: false, problem: "No signature matches the payload." };
  return { valid: true, statement, fingerprint, pinned: Boolean(options.trustedPublicKeyPem || options.expectFingerprint) };
}
