import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent } from "../../core/audit-chain";
import { createBundle, verifyBundle } from "../bundle";
import { classifyToolCall } from "../classify";
import { evaluateSessionAction } from "../policy";
import { buildSessionReceipt } from "../receipt";
import { checkSignature, fingerprintOf, keyDir, loadOrCreateKey, signDigest } from "../signing";

let home: string;
let previous: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "receipts-key-"));
  previous = process.env.WORK_RECEIPTS_HOME;
  process.env.WORK_RECEIPTS_HOME = join(home, ".work-receipts");
});

afterEach(() => {
  if (previous === undefined) delete process.env.WORK_RECEIPTS_HOME;
  else process.env.WORK_RECEIPTS_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

function bundle() {
  const event = appendAuditEvent(undefined, {
    eventId: "e1", runId: "s", workspaceId: "w", actorSubject: "work-receipts", eventType: "session.baseline",
    payload: { baseline: { git: false } }, createdAt: "2026-10-30T08:00:00.000Z",
  });
  const receipt = buildSessionReceipt({
    sessionId: "s", events: [event], contract: { status: "absent" }, checks: [],
    gitChanges: { available: false, reason: "not git" }, hashFile: () => null, now: new Date("2026-10-30T08:00:01.000Z"),
  });
  return createBundle(receipt, [event]);
}

describe("receipt signing", () => {
  it("creates one stable key per user and signs bundles verifiably", () => {
    const keys = loadOrCreateKey();
    expect(loadOrCreateKey().publicKeyPem).toBe(keys.publicKeyPem);
    const signed = bundle();
    signed.signature = signDigest(signed.bundleDigest, keys);
    const result = verifyBundle(signed);
    expect(result.consistent).toBe(true);
    expect(result.signature).toEqual({ status: "valid", fingerprint: fingerprintOf(keys.publicKeyPem) });
  });

  it("rejects a signature from one bundle reused on another", () => {
    const keys = loadOrCreateKey();
    const signature = signDigest(bundle().bundleDigest, keys);
    expect(checkSignature("f".repeat(64), signature).status).toBe("invalid");
  });

  it("rejects a swapped public key", () => {
    const keys = loadOrCreateKey();
    const other = loadOrCreateKey({ WORK_RECEIPTS_HOME: join(home, "other") });
    const signed = bundle();
    const signature = signDigest(signed.bundleDigest, keys);
    const swapped = { ...signature, publicKey: other.publicKeyPem, fingerprint: fingerprintOf(other.publicKeyPem) };
    expect(checkSignature(signed.bundleDigest, swapped).status).toBe("invalid");
  });

  it("reports unsigned bundles as unsigned, not invalid", () => {
    expect(verifyBundle(bundle()).signature).toEqual({ status: "unsigned" });
  });
});

describe("signing key boundary", () => {
  const project = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
  const decide = (tool: string, input: Record<string, unknown>) =>
    evaluateSessionAction(null, classifyToolCall(project, tool, input)).decision;

  it("denies file-tool access to the key directory, even without a contract", () => {
    expect(decide("Read", { file_path: join(keyDir(), "signing-key.pem") })).toBe("deny");
    expect(decide("Write", { file_path: join(keyDir(), "signing-key.pub.pem") })).toBe("deny");
    expect(decide("Read", { file_path: join(home, "elsewhere", ".work-receipts", "signing-key.pem") })).toBe("deny");
  });

  it("denies shell commands that name the key", () => {
    expect(decide("Bash", { command: "cat ~/.work-receipts/signing-key.pem" })).toBe("deny");
    expect(decide("PowerShell", { command: "Get-Content signing-key.pem" })).toBe("deny");
  });
});
