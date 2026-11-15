import { matchTree, verifyBundle, type ReceiptBundle } from "./bundle";
import type { Verdict } from "./receipt";

/**
 * Pull-request gate: does this commit carry a receipt, signed by a trusted key,
 * whose checks ran against exactly this commit's code? Everything is read from
 * the commit's git objects, never from the working directory, so files left by
 * earlier CI steps or a different checkout cannot influence the result.
 * Receipts live under `.receipts/`, which the code identity excludes, so a
 * receipt can be committed inside the pull request it describes; that folder
 * may therefore hold nothing but receipt artifacts.
 */

export type ReceiptAssessment = {
  path: string;
  sessionId: string | null;
  verdict: Verdict | null;
  signer: string | null;
  problems: string[];
  passes: boolean;
};

export type GateResult = {
  passed: boolean;
  revision: string;
  tree: string | null;
  receipts: ReceiptAssessment[];
  /** Why the gate failed as a whole, when no receipt-level detail explains it. */
  reason: string | null;
};

const MAX_RECEIPTS = 50;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** Only receipt artifacts may live under `.receipts`, because that folder is outside the code identity. */
const RECEIPT_ARTIFACT = /^\.receipts\/sessions\/[A-Za-z0-9_-]{1,100}\/(receipt\.(json|html|md|pr\.md|intoto\.json)|events\.jsonl)$/;
const RECEIPT_BUNDLE = /^\.receipts\/sessions\/[A-Za-z0-9_-]{1,100}\/receipt\.json$/;

/** Committed `.receipts` entries that are not plain receipt artifacts and could therefore hide code. */
export function unexpectedReceiptEntries(entries: readonly { path: string; mode: string }[]): string[] {
  return entries
    .filter((entry) => !(entry.mode === "100644" || entry.mode === "100755") || !RECEIPT_ARTIFACT.test(entry.path))
    .map((entry) => entry.path);
}

function failed(path: string, problem: string): ReceiptAssessment {
  return { path, sessionId: null, verdict: null, signer: null, problems: [problem], passes: false };
}

export function assessReceipt(
  path: string,
  content: string,
  options: { trustedKeys: readonly string[]; tree: string | null; requireVerified: boolean },
): ReceiptAssessment {
  // A hostile receipt must produce a failed assessment, never an exception that hides the others.
  try {
    let bundle: ReceiptBundle;
    try {
      bundle = JSON.parse(content) as ReceiptBundle;
    } catch {
      return failed(path, "Not valid JSON.");
    }
    const result = verifyBundle(bundle);
    const problems = [...result.problems];
    const signer = result.signature.status === "valid" ? result.signature.fingerprint : null;
    if (!signer) problems.push(result.signature.status === "unsigned" ? "Unsigned." : "Signature is invalid.");
    else if (!options.trustedKeys.includes(signer)) problems.push("Signed by " + signer + ", which is not a trusted key.");
    if (bundle?.receipt && typeof bundle.receipt === "object") {
      const match = matchTree(bundle.receipt, options.tree);
      if (match.status === "mismatch") problems.push("Covers tree " + match.receiptTree.slice(0, 12) + ", not this commit's " + match.actualTree.slice(0, 12) + ".");
      if (match.status === "unknown") problems.push(match.reason);
    }
    if (options.requireVerified && result.verdict !== "verified") problems.push("Verdict is " + (result.verdict ?? "unknown") + ", not verified.");
    const sessionId = bundle?.receipt?.sessionId;
    return {
      path,
      sessionId: typeof sessionId === "string" ? sessionId.slice(0, 100) : null,
      verdict: result.verdict,
      signer,
      problems,
      passes: problems.length === 0,
    };
  } catch {
    return failed(path, "Malformed receipt: it could not be checked.");
  }
}

export function gate(params: {
  revision: string;
  tree: string | null;
  trustedKeys: readonly string[];
  requireVerified: boolean;
  /** What the commit stores under `.receipts` (from `git ls-tree`); null when it could not be listed. */
  receiptsEntries: { path: string; mode: string }[] | null;
  /** Reads a file's content from the commit (not the working tree); null when unreadable. */
  readCommitted: (path: string) => string | null;
}): GateResult {
  const base = { revision: params.revision, tree: params.tree };
  if (params.trustedKeys.length === 0) {
    return { ...base, passed: false, receipts: [], reason: "No trusted key fingerprint was given, so any receipt could be forged. Pass --expect-key." };
  }
  if (!params.tree || !params.receiptsEntries) return { ...base, passed: false, receipts: [], reason: "Could not resolve " + params.revision + " in this repository." };
  const unexpected = unexpectedReceiptEntries(params.receiptsEntries);
  if (unexpected.length) {
    return {
      ...base, passed: false, receipts: [],
      reason: "The commit stores files under .receipts that are not receipt artifacts, and that folder is outside the receipted code: " +
        unexpected.slice(0, 5).join(", ") + (unexpected.length > 5 ? " and " + (unexpected.length - 5) + " more" : "") + ".",
    };
  }
  const bundles = params.receiptsEntries.filter((entry) => RECEIPT_BUNDLE.test(entry.path)).map((entry) => entry.path).sort();
  if (bundles.length === 0) {
    return { ...base, passed: false, receipts: [], reason: "No receipt found under .receipts/sessions/*/receipt.json in this commit." };
  }
  let budget = MAX_TOTAL_BYTES;
  const receipts = bundles.slice(0, MAX_RECEIPTS).map((path) => {
    const content = params.readCommitted(path);
    if (content === null) return failed(path, "Could not read the receipt from the commit, or it is larger than 20 MB.");
    budget -= content.length;
    if (budget < 0) return failed(path, "Skipped: the commit's receipts exceed 100 MB in total.");
    return assessReceipt(path, content, { trustedKeys: params.trustedKeys, tree: params.tree, requireVerified: params.requireVerified });
  });
  const passed = receipts.some((receipt) => receipt.passes);
  return { ...base, passed, receipts, reason: passed ? null : "No receipt is signed by a trusted key, consistent, and bound to this commit's code" + (params.requireVerified ? " with a verified verdict" : "") + "." };
}

/**
 * Safe inside a Markdown table cell and a terminal: control characters (including
 * ESC and lone CR) become spaces, and backslashes are escaped before the
 * characters that build tables, code, emphasis, links, and HTML.
 */
export function md(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\\|`*_[\]<>]/g, (char) => "\\" + char)
    .slice(0, 2000);
}

export function renderGateSummary(result: GateResult): string {
  const lines = [
    "### Work Receipts gate: " + (result.passed ? "✅ passed" : "❌ failed"),
    "",
    result.passed
      ? "This commit's code, excluding gitignored files and the .receipts folder of receipt artifacts, is exactly the code a trusted, signed receipt checked."
      : md(result.reason ?? "Failed."),
    "",
    "Commit `" + md(result.revision) + "` · tree `" + (result.tree ?? "unresolved") + "`",
  ];
  if (result.receipts.length) {
    lines.push("", "| Receipt | Verdict | Signer | Result |", "| --- | --- | --- | --- |");
    for (const receipt of result.receipts) {
      lines.push("| " + md(receipt.sessionId ?? receipt.path) + " | " + md(receipt.verdict ?? "n/a") + " | " + (receipt.signer ? md(receipt.signer) : "none") + " | " +
        (receipt.passes ? "pass" : md(receipt.problems.join(" "))) + " |");
    }
  }
  return lines.join("\n") + "\n";
}
