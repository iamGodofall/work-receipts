import type { ReceiptBundle } from "./bundle";
import type { Verdict } from "./receipt";

const HEADLINE: Record<Verdict, string> = {
  verified: "✅ **Verified**",
  checks_failed: "❌ **Checks failed**",
  out_of_scope: "⚠️ **Out of scope**",
  unverified: "⚪ **Unverified**",
  tampered: "🛑 **Log integrity failure**",
};

/** Escape text for a Markdown table cell or inline span. */
function md(value: string): string {
  return value.replace(/[|`*_[\]<>]/g, (char) => "\\" + char).replace(/\r?\n/g, " ");
}

function codeSpan(value: string): string {
  return "`" + value.replace(/`/g, "'") + "`";
}

/**
 * A compact receipt summary for a pull request description. Everything comes
 * from the computed receipt; the full evidence stays in the HTML receipt.
 */
export function renderPrSummary(bundle: ReceiptBundle): string {
  const receipt = bundle.receipt;
  const passed = receipt.checks.filter((check) => check.status === "passed").length;
  const lines: string[] = [];

  lines.push("### Work Receipt: " + HEADLINE[receipt.verdict]);
  lines.push("");
  if (receipt.contract.goal) {
    lines.push("> " + md(receipt.contract.goal));
    lines.push("");
  }
  // Out-of-scope files are listed in full below; avoid repeating them here.
  if (receipt.verdict !== "out_of_scope") {
    lines.push(md(receipt.verdictReason));
    lines.push("");
  }
  lines.push(
    "**" + passed + "/" + receipt.checks.length + "** checks passed · " +
    "**" + (receipt.workingTree.available ? receipt.workingTree.changed.length : "n/a") + "** files changed · " +
    "**" + receipt.summary.denied + "** blocked · " +
    "**" + receipt.summary.approvalRequested + "** needed approval",
  );

  if (receipt.checks.length) {
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("| --- | --- |");
    for (const check of receipt.checks) {
      lines.push("| " + md(check.description) + " " + codeSpan(check.command) + " | " + (check.status === "passed" ? "passed" : "**" + check.status + "**") + " |");
    }
  }

  if (receipt.workingTree.available && receipt.workingTree.outOfScope.length) {
    const shown = receipt.workingTree.outOfScope.slice(0, 8).map(codeSpan).join(", ");
    const more = receipt.workingTree.outOfScope.length > 8 ? " and " + (receipt.workingTree.outOfScope.length - 8) + " more" : "";
    lines.push("");
    lines.push("**Changed outside the agreed scope:** " + shown + more);
  }
  if (receipt.checkInputsChanged.length) {
    lines.push("");
    lines.push("**Review before trusting the checks:** " + receipt.checkInputsChanged.map(codeSpan).join(", "));
  }

  lines.push("");
  lines.push(
    "<sub>Session " + codeSpan(receipt.sessionId) + " · event log " + (receipt.chain.valid ? "intact" : "FAILED") + " · " +
    (bundle.signature ? "signed by " + codeSpan(bundle.signature.fingerprint) : "unsigned") +
    " · verify the attached receipt.html with " + codeSpan("node plugin/bin/cli.js verify receipt.html") +
    " · Work Receipts by Enock Labs</sub>",
  );
  return lines.join("\n") + "\n";
}
