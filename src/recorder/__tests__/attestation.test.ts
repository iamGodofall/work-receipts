import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendAuditEvent } from "../../core/audit-chain";
import { buildStatement, pae, PAYLOAD_TYPE, PREDICATE_TYPE, signStatement, STATEMENT_TYPE, verifyAttestation } from "../attestation";
import { createBundle } from "../bundle";
import { SessionContractSchema } from "../contract";
import { buildSessionReceipt } from "../receipt";
import { fingerprintOf } from "../signing";

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const tree = "ab".repeat(20);

function bundle(code = { available: true as const, tree, treeAfterChecks: tree, head: "cd".repeat(20) }) {
  const contract = SessionContractSchema.parse({
    schemaVersion: "1.0", goal: "Fix login", write: ["src/**"],
    checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
  });
  const event = appendAuditEvent(undefined, {
    eventId: "e1", runId: "s", workspaceId: "w", actorSubject: "work-receipts", eventType: "session.baseline",
    payload: { baseline: { git: true, head: null, dirty: [], truncated: false } }, createdAt: "2026-11-15T00:00:00.000Z",
  });
  const receipt = buildSessionReceipt({
    sessionId: "s", events: [event], contract: { status: "loaded", contract },
    checks: [{ id: "tests", description: "Tests pass", command: "npm test", status: "passed", exitCode: 0, durationMs: 1, outputDigest: "e".repeat(64), outputTail: "ok", checkedAt: "2026-11-15T00:00:00.000Z" }],
    gitChanges: { available: true, changed: ["src/a.ts"], contractChanged: false }, hashFile: () => null, code,
  });
  return createBundle(receipt, [event]);
}

describe("DSSE pre-authentication encoding", () => {
  it("matches the DSSE protocol's worked example", () => {
    expect(pae("http://example.com/HelloWorld", Buffer.from("hello world")).toString()).toBe("DSSEv1 29 http://example.com/HelloWorld 11 hello world");
  });

  it("counts bytes, not characters", () => {
    expect(pae("t", Buffer.from("é", "utf8")).toString("utf8")).toBe("DSSEv1 1 t 2 é");
  });
});

describe("in-toto Work Receipt attestations", () => {
  it("names the checked git tree as the subject and carries the computed verdict", () => {
    const user = keys();
    const b = bundle();
    const statement = buildStatement(b, user.publicKeyPem);
    expect(statement._type).toBe(STATEMENT_TYPE);
    expect(statement.predicateType).toBe(PREDICATE_TYPE);
    expect(statement.subject).toEqual([{ name: "work-tree", digest: { gitTree: tree } }]);
    expect(statement.predicate.verdict).toBe("verified");
    expect(statement.predicate.receiptBundleDigest).toBe(b.bundleDigest);
    expect(statement.predicate.checks[0]).not.toHaveProperty("outputTail");
  });

  it("refuses to attest a receipt that does not identify its code", () => {
    expect(() => buildStatement(bundle({ available: false, reason: "x" } as never), keys().publicKeyPem)).toThrow(/no attestation subject/);
  });

  it("verifies a signed envelope and pins the signer when asked", () => {
    const user = keys();
    const envelope = signStatement(buildStatement(bundle(), user.publicKeyPem), user);
    expect(envelope.payloadType).toBe(PAYLOAD_TYPE);
    expect(envelope.signatures[0].keyid).toBe(fingerprintOf(user.publicKeyPem));

    const open = verifyAttestation(envelope);
    expect(open.valid && open.pinned).toBe(false);
    expect(open.valid).toBe(true);
    const pinned = verifyAttestation(envelope, { expectFingerprint: fingerprintOf(user.publicKeyPem) });
    expect(pinned.valid && pinned.pinned).toBe(true);
    expect(verifyAttestation(envelope, { trustedPublicKeyPem: user.publicKeyPem }).valid).toBe(true);
  });

  it("rejects an edited payload, a swapped payload type, and a different trusted key", () => {
    const user = keys();
    const envelope = signStatement(buildStatement(bundle(), user.publicKeyPem), user);

    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    statement.predicate.verdict = "verified";
    statement.subject[0].digest.gitTree = "ff".repeat(20);
    const edited = { ...envelope, payload: Buffer.from(JSON.stringify(statement)).toString("base64") };
    expect(verifyAttestation(edited)).toEqual({ valid: false, problem: "No signature matches the payload." });

    expect(verifyAttestation({ ...envelope, payloadType: "application/json" }).valid).toBe(false);
    const other = keys();
    const wrongKey = verifyAttestation(envelope, { trustedPublicKeyPem: other.publicKeyPem });
    expect(wrongKey.valid).toBe(false);
  });

  it("catches a forger who re-signs with their own key once the real signer is pinned", () => {
    const user = keys();
    const forger = keys();
    const forged = signStatement(buildStatement(bundle(), forger.publicKeyPem), forger);
    // Integrity alone holds: the forger's key really signed it.
    expect(verifyAttestation(forged).valid).toBe(true);
    const check = verifyAttestation(forged, { expectFingerprint: fingerprintOf(user.publicKeyPem) });
    expect(check.valid).toBe(false);
    expect(check.valid ? "" : check.problem).toMatch(/not the expected key/);
  });

  it("rejects a statement whose named signer differs from the verifying key", () => {
    const user = keys();
    const other = keys();
    const statement = buildStatement(bundle(), other.publicKeyPem);
    const envelope = signStatement(statement, user);
    expect(verifyAttestation(envelope, { trustedPublicKeyPem: user.publicKeyPem }).valid).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    for (const input of [null, {}, { payload: 1, signatures: [] }, { payloadType: PAYLOAD_TYPE, payload: "!!!", signatures: [] },
      { payloadType: PAYLOAD_TYPE, payload: Buffer.from("{}").toString("base64"), signatures: [] }]) {
      expect(verifyAttestation(input).valid).toBe(false);
    }
  });
});
