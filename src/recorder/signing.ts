import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the signing key lives: outside every project, in the user's home.
 * WORK_RECEIPTS_HOME overrides it (used by tests).
 */
export function keyDir(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.WORK_RECEIPTS_HOME || join(homedir(), ".work-receipts"));
}

export type ReceiptSignature = {
  algorithm: "ed25519";
  /** SPKI public key, PEM. */
  publicKey: string;
  /** First 16 bytes of SHA-256 over the DER public key, hex in groups of four. */
  fingerprint: string;
  /** Base64 Ed25519 signature over the UTF-8 bundle digest. */
  signature: string;
  signedAt: string;
};

export function fingerprintOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 32).match(/.{4}/g)!.join(":");
}

/** Load the user's signing key, creating it on first use. */
export function loadOrCreateKey(env: Record<string, string | undefined> = process.env): { privateKeyPem: string; publicKeyPem: string } {
  const dir = keyDir(env);
  const privatePath = join(dir, "signing-key.pem");
  const publicPath = join(dir, "signing-key.pub.pem");
  if (existsSync(privatePath) && existsSync(publicPath)) {
    return { privateKeyPem: readFileSync(privatePath, "utf8"), publicKeyPem: readFileSync(publicPath, "utf8") };
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(privatePath, privateKeyPem, { mode: 0o600, flag: "wx" });
  writeFileSync(publicPath, publicKeyPem, { mode: 0o644, flag: "wx" });
  try {
    chmodSync(privatePath, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file inherits the user profile's ACL.
  }
  return { privateKeyPem, publicKeyPem };
}

export function signDigest(digest: string, keys: { privateKeyPem: string; publicKeyPem: string }, now = new Date()): ReceiptSignature {
  return {
    algorithm: "ed25519",
    publicKey: keys.publicKeyPem,
    fingerprint: fingerprintOf(keys.publicKeyPem),
    signature: sign(null, Buffer.from(digest, "utf8"), createPrivateKey(keys.privateKeyPem)).toString("base64"),
    signedAt: now.toISOString(),
  };
}

export type SignatureCheck =
  | { status: "unsigned" }
  | { status: "valid"; fingerprint: string }
  | { status: "invalid"; reason: string };

export function checkSignature(digest: string, signature: unknown): SignatureCheck {
  if (signature === undefined || signature === null) return { status: "unsigned" };
  const sig = signature as Partial<ReceiptSignature>;
  if (sig.algorithm !== "ed25519" || typeof sig.publicKey !== "string" || typeof sig.signature !== "string") {
    return { status: "invalid", reason: "Signature block is malformed." };
  }
  try {
    const fingerprint = fingerprintOf(sig.publicKey);
    if (sig.fingerprint !== fingerprint) return { status: "invalid", reason: "Fingerprint does not match the public key." };
    const ok = verify(null, Buffer.from(digest, "utf8"), createPublicKey(sig.publicKey), Buffer.from(sig.signature, "base64"));
    return ok ? { status: "valid", fingerprint } : { status: "invalid", reason: "Signature does not match the bundle." };
  } catch {
    return { status: "invalid", reason: "Signature could not be checked." };
  }
}
