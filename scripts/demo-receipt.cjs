// Generates plugin/examples/receipt-example.html by replaying a realistic
// session through the shipped plugin loaders in a throwaway git repository.
// Usage: node scripts/demo-receipt.cjs
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync, execSync } = require("node:child_process");

const root = resolve(__dirname, "..");
const project = fs.mkdtempSync(join(tmpdir(), "receipt-demo-"));
const session = "signup-validation";
// Sign with a throwaway key so the demo never touches the real ~/.work-receipts.
const keyHome = fs.mkdtempSync(join(tmpdir(), "receipt-demo-key-"));
const env = { ...process.env, CLAUDE_PROJECT_DIR: project, WORK_RECEIPTS_HOME: keyHome };

try {
  const sh = (command) => execSync(command, { cwd: project, stdio: "pipe" });
  sh("git init -q && git config user.email demo@example.invalid && git config user.name demo");
  fs.mkdirSync(join(project, "src"));
  fs.writeFileSync(join(project, "src", "signup.ts"), "export {};\n");
  fs.writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "node -e 0", lint: "node -e 0" } }));
  fs.writeFileSync(join(project, ".gitignore"), ".receipts/\n");
  sh("git add . && git commit -qm init");
  fs.writeFileSync(join(project, "receipts.contract.json"), JSON.stringify({
    schemaVersion: "1.0",
    goal: "Add input validation to the signup form",
    write: ["src/**", "test/**"],
    shell: { allow: ["npm test", "npm run lint"], otherwise: "ask" },
    checks: [
      { id: "tests", description: "Unit tests pass", command: "npm test" },
      { id: "lint", description: "Lint is clean", command: "npm run lint" },
    ],
  }));

  const hook = (mode, fields) => spawnSync("node", [join(root, "plugin/bin/hook.js"), mode], {
    input: JSON.stringify({ session_id: session, cwd: project, ...fields }), env, encoding: "utf8",
  });
  const call = (tool, input, id, effect) => {
    const pre = hook("pre", { tool_name: tool, tool_input: input, tool_use_id: id }).stdout;
    const decision = pre ? JSON.parse(pre).hookSpecificOutput.permissionDecision : "allow";
    if (decision !== "allow") return;
    if (effect) effect();
    hook("post", { tool_name: tool, tool_input: input, tool_use_id: id });
  };
  const touch = (file) => () => {
    fs.mkdirSync(join(project, file, ".."), { recursive: true });
    fs.appendFileSync(join(project, file), "// validated\n");
  };

  hook("session-start", { source: "startup" });
  call("Read", { file_path: join(project, "src", "signup.ts") }, "r1");
  call("Edit", { file_path: join(project, "src", "signup.ts") }, "e1", touch("src/signup.ts"));
  call("Write", { file_path: join(project, "test", "signup.test.ts") }, "e2", touch("test/signup.test.ts"));
  call("Read", { file_path: join(project, ".env") }, "r2");
  call("Edit", { file_path: join(project, "package.json") }, "e3");
  call("Bash", { command: "npm test" }, "b1");
  call("Bash", { command: "npm install zod" }, "b2");

  spawnSync("node", [join(root, "plugin/bin/cli.js"), "receipt"], { cwd: project, env });
  const out = join(root, "plugin", "examples", "receipt-example.html");
  fs.copyFileSync(join(project, ".receipts", "sessions", session, "receipt.html"), out);
  console.log("Wrote " + out);
} finally {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(keyHome, { recursive: true, force: true });
}
