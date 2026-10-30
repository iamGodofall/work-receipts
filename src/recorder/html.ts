import type { ReceiptBundle } from "./bundle";
import type { SessionReceipt, Verdict } from "./receipt";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Mood = "celebrating" | "concerned" | "uncertain" | "alarmed";

/** The mascot's expression is derived from the computed verdict, never chosen freely. */
const MOOD: Record<Verdict, Mood> = {
  verified: "celebrating",
  checks_failed: "concerned",
  out_of_scope: "concerned",
  unverified: "uncertain",
  tampered: "alarmed",
};

const VERDICT_STYLE: Record<Verdict, { label: string; color: string }> = {
  verified: { label: "Verified", color: "#1f9d6b" },
  checks_failed: { label: "Checks failed", color: "#c2410c" },
  out_of_scope: { label: "Out of scope", color: "#c2410c" },
  unverified: { label: "Unverified", color: "#8a6d1d" },
  tampered: { label: "Log integrity failure", color: "#b91c1c" },
};

/** Head-only mascot: navy shell, cream face, amber eyes, orange ear rings, swirl antenna. */
export function mascotSvg(mood: Mood, size = 120): string {
  const brows: Record<Mood, string> = {
    celebrating: "M38 47 Q46 41 54 45 M66 45 Q74 41 82 47",
    concerned: "M38 44 Q46 46 54 49 M66 49 Q74 46 82 44",
    uncertain: "M38 47 Q46 44 54 46 M66 43 Q74 39 82 45",
    alarmed: "M38 43 Q46 37 54 42 M66 42 Q74 37 82 43",
  };
  const mouth: Record<Mood, string> = {
    celebrating: '<path d="M50 78 Q60 92 70 78 Q60 86 50 78Z" fill="#9d4a39"/>',
    concerned: '<path d="M51 84 Q60 77 69 84" fill="none" stroke="#543e35" stroke-width="2.6" stroke-linecap="round"/>',
    uncertain: '<path d="M51 81 Q57 79 63 82 Q66 83 69 81" fill="none" stroke="#543e35" stroke-width="2.6" stroke-linecap="round"/>',
    alarmed: '<ellipse cx="60" cy="82" rx="5" ry="6.5" fill="#9d4a39"/>',
  };
  const eyeRy = mood === "alarmed" ? 12 : 10.5;
  const eye = (cx: number) =>
    '<ellipse cx="' + cx + '" cy="60" rx="10" ry="' + (eyeRy + 2) + '" fill="#fffaf2" stroke="#b9ae9f" stroke-width="1.2"/>' +
    '<ellipse cx="' + cx + '" cy="61" rx="7" ry="' + eyeRy + '" fill="#f39a35"/>' +
    '<ellipse cx="' + cx + '" cy="61" rx="4.3" ry="' + (eyeRy - 3) + '" fill="#121823"/>' +
    '<circle cx="' + (cx - 2.5) + '" cy="56" r="2.4" fill="#fff"/>';
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="' + size + '" height="' + size + '" role="img" aria-label="Mascot looking ' + mood + '">' +
    '<path d="M57 17 C51 9 55 2 61 3 C66 4 66 9 64 12 C72 6 79 14 71 19 C67 22 62 22 57 17Z" fill="#f67a4e"/>' +
    '<circle cx="73" cy="6" r="2.2" fill="#5ce4dc"/>' +
    '<rect x="6" y="46" width="16" height="34" rx="8" fill="#1b273a"/><rect x="10" y="51" width="8" height="24" rx="4" fill="none" stroke="#ff8757" stroke-width="2.4"/>' +
    '<rect x="98" y="46" width="16" height="34" rx="8" fill="#1b273a"/><rect x="102" y="51" width="8" height="24" rx="4" fill="none" stroke="#ff8757" stroke-width="2.4"/>' +
    '<rect x="14" y="16" width="92" height="88" rx="40" fill="#202d41"/>' +
    '<ellipse cx="60" cy="66" rx="37" ry="31" fill="#f6e6d1"/>' +
    '<path d="' + brows[mood] + '" fill="none" stroke="#202a3b" stroke-width="3.4" stroke-linecap="round"/>' +
    eye(46) + eye(74) + mouth[mood] +
    '<rect x="52" y="108" width="16" height="3.5" rx="1.75" fill="#5ce4dc"/>' +
    "</svg>"
  );
}

function list(items: string[]): string {
  return items.length ? "<ul>" + items.map((item) => "<li>" + item + "</li>").join("") + "</ul>" : "";
}

export function renderReceiptHtml(bundle: ReceiptBundle): string {
  const receipt: SessionReceipt = bundle.receipt;
  const style = VERDICT_STYLE[receipt.verdict];
  const changed = receipt.workingTree.available
    ? receipt.workingTree.changed.map((path) => {
        const tags = [
          receipt.workingTree.outOfScope.includes(path) ? '<span class="tag bad">out of scope</span>' : "",
          receipt.workingTree.notFromFileTools.includes(path) ? '<span class="tag">via shell or editor</span>' : "",
          receipt.workingTree.ignored.includes(path) ? '<span class="tag">ignored by contract</span>' : "",
          receipt.checkInputsChanged.includes(path) ? '<span class="tag warn">affects checks</span>' : "",
        ].join("");
        return "<code>" + esc(path) + "</code> " + tags;
      })
    : [];

  const checks = receipt.checks.map((check) =>
    "<tr><td>" + esc(check.description) + "</td><td><code>" + esc(check.command) + "</code></td><td class=\"" +
    (check.status === "passed" ? "ok" : "bad") + "\">" + esc(check.status) + "</td><td>" + esc(check.exitCode ?? "n/a") +
    "</td><td>" + (Math.round(check.durationMs / 100) / 10) + "s</td></tr>");

  const embedded = JSON.stringify(bundle).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Work Receipt: ${esc(style.label)}</title>
<style>
:root { color-scheme: light dark; --ink:#172033; --muted:#5b6475; --line:#e3e6ec; --bg:#f7f6f3; --card:#fff; }
@media (prefers-color-scheme: dark) { :root { --ink:#e8ebf2; --muted:#9aa3b5; --line:#2a3345; --bg:#0f1522; --card:#161e2e; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:860px; margin:0 auto; padding:32px 20px 64px; }
.hero { display:flex; gap:22px; align-items:center; background:var(--card); border:1px solid var(--line); border-radius:18px; padding:22px; }
.verdict { display:inline-block; padding:4px 12px; border-radius:999px; color:#fff; font-weight:700; letter-spacing:.02em; background:${style.color}; }
h1 { margin:8px 0 4px; font-size:24px; } h2 { font-size:16px; margin:28px 0 10px; }
.muted { color:var(--muted); } code { font:13px ui-monospace,SFMono-Regular,Consolas,monospace; }
section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:4px 18px 14px; margin-top:16px; }
table { width:100%; border-collapse:collapse; } td,th { text-align:left; padding:7px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
.ok { color:#1f9d6b; font-weight:600; } .bad { color:#c2410c; font-weight:600; }
.tag { font-size:12px; border:1px solid var(--line); border-radius:6px; padding:1px 6px; margin-left:4px; color:var(--muted); }
.tag.bad { color:#c2410c; border-color:#c2410c; } .tag.warn { color:#8a6d1d; border-color:#8a6d1d; }
.facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0 4px; }
.facts div { border:1px solid var(--line); border-radius:10px; padding:8px 10px; } .facts b { display:block; font-size:20px; }
footer { margin-top:26px; font-size:13px; }
.avatar { flex:none; border-radius:50%; padding:8px; background:radial-gradient(circle at 40% 35%, #fff8ee, #e9dcc9); }
@media (max-width:560px) { .hero { flex-direction:column; text-align:center; } }
</style>
</head>
<body>
<main>
<div class="hero">
<div class="avatar">${mascotSvg(MOOD[receipt.verdict])}</div>
<div>
<span class="verdict">${esc(style.label)}</span>
<h1>${esc(receipt.contract.goal ?? "Claude Code session")}</h1>
<div>${esc(receipt.verdictReason)}</div>
</div>
</div>

<div class="facts">
<div><b>${receipt.summary.requested}</b>actions requested</div>
<div><b>${receipt.summary.denied}</b>blocked</div>
<div><b>${receipt.summary.approvalRequested}</b>needed approval</div>
<div><b>${receipt.workingTree.available ? receipt.workingTree.changed.length : "n/a"}</b>files changed</div>
<div><b>${receipt.checks.filter((check) => check.status === "passed").length}/${receipt.checks.length}</b>checks passed</div>
</div>

${checks.length ? `<section><h2>Acceptance checks</h2><table><tr><th>Check</th><th>Command</th><th>Result</th><th>Exit</th><th>Time</th></tr>${checks.join("")}</table></section>` : ""}

<section><h2>Files changed since the session started</h2>
${receipt.workingTree.available ? (changed.length ? list(changed) : "<p>No files changed.</p>") : "<p class=\"muted\">Not available: " + esc(receipt.workingTree.reason) + "</p>"}
${receipt.workingTree.available && receipt.workingTree.contractChanged ? "<p class=\"bad\">The session contract itself changed during this session.</p>" : ""}
</section>

${receipt.denied.length ? `<section><h2>Blocked actions</h2>${list(receipt.denied.map((entry) => esc(entry.tool) + " <code>" + esc(entry.target) + "</code>: " + esc(entry.reason)))}</section>` : ""}

${receipt.approvalRequests.length ? `<section><h2>Actions that required approval</h2>${list(receipt.approvalRequests.map((entry) => esc(entry.tool) + " <code>" + esc(entry.preview ?? entry.target) + "</code>: " + (entry.executed ? "ran after the approval prompt" : "did not run")))}</section>` : ""}

<section><h2>What this receipt does not prove</h2>${list(receipt.limitations.map(esc))}</section>

<footer class="muted">
Session <code>${esc(receipt.sessionId)}</code> · ${esc(receipt.firstEventAt ?? "n/a")} to ${esc(receipt.lastEventAt ?? "n/a")} ·
event log ${receipt.chain.valid ? "intact" : "FAILED"} (${receipt.chain.checkedEvents} events, head <code>${esc(receipt.chain.headHash?.slice(0, 16) ?? "none")}</code>) ·
bundle <code>${esc(bundle.bundleDigest.slice(0, 16))}</code> ·
${bundle.signature ? "signed by key <code>" + esc(bundle.signature.fingerprint) + "</code>" : "unsigned"}<br>
This file embeds the full evidence bundle. Re-check it with <code>node cli.js verify &lt;this file&gt;</code>. Verification proves the verdict follows from the evidence, nothing was edited afterwards, and (if signed) which key produced it. It does not prove the recorded check results were truthful.
</footer>
</main>
<script type="application/json" id="work-receipt-bundle">${embedded}</script>
</body>
</html>
`;
}

/** Extract the embedded bundle from a receipt HTML file, or parse a bundle JSON file. */
export function extractBundle(text: string): unknown {
  const match = /<script type="application\/json" id="work-receipt-bundle">([\s\S]*?)<\/script>/.exec(text);
  return JSON.parse(match ? match[1] : text);
}
