import type { ReceiptBundle } from "./bundle";
import type { AuditEvent } from "../core/audit-chain";
import type { SessionReceipt, Verdict } from "./receipt";
import { buildTimeline, type TimelineEntry, type TimelineStatus } from "./timeline";

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
  verified: { label: "Verified", color: "#34d399" },
  checks_failed: { label: "Checks failed", color: "#ff7a4d" },
  out_of_scope: { label: "Out of scope", color: "#ff7a4d" },
  unverified: { label: "Unverified", color: "#f5b942" },
  tampered: { label: "Log integrity failure", color: "#f43f5e" },
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
  const timeline = receipt.chain.valid ? renderTimeline(buildTimeline(bundle.events as AuditEvent[])) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Work Receipt: ${esc(style.label)}</title>
<style>
:root { color-scheme: dark; --ink:#eef2f8; --muted:#93a0b8; --line:rgba(255,255,255,.09); --card:rgba(255,255,255,.045); --accent:${style.color}; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  background: radial-gradient(900px 500px at 8% -10%, rgba(255,122,77,.26), transparent 60%), radial-gradient(800px 520px at 100% 0%, rgba(79,227,220,.16), transparent 60%), radial-gradient(900px 700px at 50% 115%, rgba(109,92,255,.15), transparent 60%), #0b1322; }
main { max-width:880px; margin:0 auto; padding:34px 20px 64px; }
.hero { position:relative; display:flex; gap:26px; align-items:center; padding:26px 28px; border-radius:24px; overflow:hidden;
  background:linear-gradient(135deg, rgba(255,255,255,.08), rgba(255,255,255,.02)); border:1px solid var(--line);
  box-shadow:0 30px 70px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.08); animation:rise .7s cubic-bezier(.2,.8,.2,1) both; }
.hero::before { content:""; position:absolute; width:260px; height:260px; left:-40px; top:-60px; border-radius:50%; background:radial-gradient(circle, color-mix(in srgb, var(--accent) 45%, transparent), transparent 70%); filter:blur(20px); }
.avatar { position:relative; flex:none; border-radius:50%; padding:10px; background:radial-gradient(circle at 40% 35%, #fff8ee, #e3d3bd); box-shadow:0 0 0 6px color-mix(in srgb, var(--accent) 25%, transparent), 0 18px 40px rgba(0,0,0,.45); animation:float 4.5s ease-in-out infinite; }
.hero-copy { position:relative; min-width:0; }
.verdict { display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:10px; color:var(--accent); font-weight:800; letter-spacing:.12em; text-transform:uppercase; font-size:13px;
  border:2px solid var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent); box-shadow:0 0 24px color-mix(in srgb, var(--accent) 35%, transparent);
  transform:rotate(-3deg); animation:stamp .55s cubic-bezier(.3,1.6,.5,1) .35s both; }
h1 { margin:12px 0 6px; font-size:clamp(22px,3.4vw,30px); line-height:1.15; letter-spacing:-.03em; color:#fff; }
.reason { color:#c3cddf; }
h2 { font-size:15px; margin:22px 0 12px; color:#fff; letter-spacing:-.01em; }
.muted { color:var(--muted); } code { font:13px ui-monospace,SFMono-Regular,Consolas,monospace; color:#dfe7f5; }
section { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:2px 20px 14px; margin-top:16px; animation:rise .6s cubic-bezier(.2,.8,.2,1) both; }
section:nth-of-type(1) { animation-delay:.25s } section:nth-of-type(2) { animation-delay:.32s } section:nth-of-type(3) { animation-delay:.39s }
section:nth-of-type(4) { animation-delay:.46s } section:nth-of-type(5) { animation-delay:.53s } section:nth-of-type(n+6) { animation-delay:.6s }
table { width:100%; border-collapse:collapse; } td,th { text-align:left; padding:9px 6px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; font-size:13px; }
.ok { color:#34d399; font-weight:700; } .bad { color:#ff7a4d; font-weight:700; }
.tag { font-size:12px; border:1px solid var(--line); border-radius:6px; padding:1px 7px; margin-left:4px; color:var(--muted); }
.tag.bad { color:#ff7a4d; border-color:#ff7a4d; } .tag.warn { color:#f5b942; border-color:#f5b942; }
ul { padding-left:20px; } li { margin:4px 0; }
.facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:16px 0 4px; }
.facts div { padding:14px 16px; border-radius:16px; background:var(--card); border:1px solid var(--line); color:var(--muted); font-size:13px; animation:rise .6s cubic-bezier(.2,.8,.2,1) both; }
.facts div:nth-child(1) { animation-delay:.1s } .facts div:nth-child(2) { animation-delay:.15s } .facts div:nth-child(3) { animation-delay:.2s } .facts div:nth-child(4) { animation-delay:.25s } .facts div:nth-child(5) { animation-delay:.3s }
.facts b { display:block; font-size:28px; letter-spacing:-.04em; color:#fff; font-variant-numeric:tabular-nums; }
footer { margin-top:28px; font-size:12.5px; line-height:1.6; }
.brand { margin-top:10px; font-weight:700; color:#c3cddf; letter-spacing:.02em; }
.tl { list-style:none; margin:0; padding:0 0 4px; position:relative; }
.tl::before { content:""; position:absolute; left:6px; top:6px; bottom:10px; width:2px; background:linear-gradient(rgba(255,255,255,.12), rgba(255,255,255,.02)); }
.tl li { position:relative; display:grid; grid-template-columns:74px 1fr auto; gap:10px; align-items:baseline; padding:8px 0 8px 24px; margin:0; animation:slide .45s cubic-bezier(.2,.8,.2,1) both; animation-delay:calc(.5s + var(--n, 0) * 45ms); }
.tl li::before { content:""; position:absolute; left:1px; top:13px; width:12px; height:12px; border-radius:50%; background:var(--dot); box-shadow:0 0 0 3px #111a2c, 0 0 12px var(--dot); }
.tl time { color:var(--muted); font:12px ui-monospace,SFMono-Regular,Consolas,monospace; }
.tl .what { min-width:0; overflow-wrap:anywhere; } .tl .what b { font-weight:700; margin-right:6px; color:#fff; }
.tl .why { display:block; color:var(--muted); font-size:13px; }
.tl .state { font-size:12px; font-weight:700; color:var(--dot); white-space:nowrap; }
.tl .agent { font-size:11px; border:1px solid var(--line); border-radius:6px; padding:0 6px; margin-right:6px; color:var(--muted); }
.st-done { --dot:#34d399; } .st-approved { --dot:#60a5fa; } .st-blocked { --dot:#ff7a4d; }
.st-failed { --dot:#f43f5e; } .st-not_run { --dot:#f5b942; } .st-pending { --dot:#8a93a5; }
.more { color:var(--muted); font-size:13px; margin:4px 0 0 24px; }
@keyframes rise { from { opacity:0; transform:translateY(16px) scale(.985); } to { opacity:1; transform:none; } }
@keyframes slide { from { opacity:0; transform:translateX(-10px); } to { opacity:1; transform:none; } }
@keyframes float { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-8px); } }
@keyframes stamp { 0% { opacity:0; transform:scale(2.2) rotate(-14deg); } 70% { opacity:1; transform:scale(.94) rotate(-2deg); } 100% { opacity:1; transform:scale(1) rotate(-3deg); } }
@media (max-width:560px) { .hero { flex-direction:column; text-align:center; } .tl li { grid-template-columns:1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before { animation:none !important; } }
@media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } * { animation:none !important; } }
</style>
</head>
<body>
<main>
<div class="hero">
<div class="avatar">${mascotSvg(MOOD[receipt.verdict])}</div>
<div class="hero-copy">
<span class="verdict">${esc(style.label)}</span>
<h1>${esc(receipt.contract.goal ?? "Claude Code session")}</h1>
<div class="reason">${esc(receipt.verdictReason)}</div>
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

${timeline}

${receipt.denied.length ? `<section><h2>Blocked actions</h2>${list(receipt.denied.map((entry) => esc(entry.tool) + " <code>" + esc(entry.target) + "</code>: " + esc(entry.reason)))}</section>` : ""}

${receipt.approvalRequests.length ? `<section><h2>Actions that required approval</h2>${list(receipt.approvalRequests.map((entry) => esc(entry.tool) + " <code>" + esc(entry.preview ?? entry.target) + "</code>: " + (entry.executed ? "ran after the approval prompt" : "did not run")))}</section>` : ""}

<section><h2>What this receipt does not prove</h2>${list(receipt.limitations.map(esc))}</section>

<footer class="muted">
Session <code>${esc(receipt.sessionId)}</code> · ${esc(receipt.firstEventAt ?? "n/a")} to ${esc(receipt.lastEventAt ?? "n/a")} ·
event log ${receipt.chain.valid ? "intact" : "FAILED"} (${receipt.chain.checkedEvents} events, head <code>${esc(receipt.chain.headHash?.slice(0, 16) ?? "none")}</code>) ·
bundle <code>${esc(bundle.bundleDigest.slice(0, 16))}</code> ·
${bundle.signature ? "signed by key <code>" + esc(bundle.signature.fingerprint) + "</code>" : "unsigned"}<br>
This file embeds the full evidence bundle. Re-check it with <code>node cli.js verify &lt;this file&gt;</code>. Verification proves the verdict follows from the evidence, nothing was edited afterwards, and (if signed) which key produced it. It does not prove the recorded check results were truthful.
<div class="brand">Work Receipts by Enock Labs</div>
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

const TIMELINE_LIMIT = 300;

const STATUS_LABEL: Record<TimelineStatus, string> = {
  done: "done",
  approved: "approved, ran",
  blocked: "blocked",
  failed: "failed",
  not_run: "did not run",
  pending: "no result",
};

function clock(iso: string): string {
  return iso.slice(11, 19);
}

function renderTimeline(entries: TimelineEntry[]): string {
  if (entries.length === 0) return "";
  const shown = entries.slice(0, TIMELINE_LIMIT);
  const items = shown.map((entry, index) => {
    const agent = entry.actor.startsWith("claude-code:") ? '<span class="agent">' + esc(entry.actor.slice(12)) + "</span>" : "";
    const duration = entry.durationMs !== null && entry.durationMs >= 1000 ? " · " + (Math.round(entry.durationMs / 100) / 10) + "s" : "";
    return '<li class="st-' + entry.status + '" style="--n:' + Math.min(index, 30) + '"><time>' + esc(clock(entry.at)) + '</time><span class="what">' + agent +
      "<b>" + esc(entry.tool) + "</b><code>" + esc(entry.subject) + "</code>" +
      (entry.reason ? '<span class="why">' + esc(entry.reason) + "</span>" : "") +
      '</span><span class="state">' + STATUS_LABEL[entry.status] + esc(duration) + "</span></li>";
  });
  const more = entries.length > TIMELINE_LIMIT
    ? '<p class="more">and ' + (entries.length - TIMELINE_LIMIT) + " more actions in the embedded log</p>"
    : "";
  return '<section><h2>What the agent did, step by step</h2><ol class="tl">' + items.join("") + "</ol>" + more + "</section>";
}
