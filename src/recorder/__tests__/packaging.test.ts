import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RECORDER_VERSION } from "../receipt";

const pluginDir = resolve(__dirname, "..", "..", "..", "plugin");

/**
 * Found while installing from GitHub (2026-11-15): a "type": "module"
 * package.json in any parent folder made Node load the plugin's CommonJS
 * scripts as ES modules, so every hook crashed. Claude Code treats a crashed
 * hook as a non-blocking error, so the recorder silently stopped enforcing.
 */
describe("plugin packaging", () => {
  it("runs its hook and CLI even under a parent package.json that declares ES modules", () => {
    const root = mkdtempSync(join(tmpdir(), "receipts-esm-parent-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      const installed = join(root, "plugins", "work-receipts");
      cpSync(pluginDir, installed, { recursive: true });

      const cli = spawnSync(process.execPath, [join(installed, "bin", "cli.js")], { encoding: "utf8" });
      expect(cli.stderr).not.toMatch(/require is not defined/);
      expect(cli.stdout).toMatch(/^Usage: cli\.js/);

      const project = mkdtempSync(join(tmpdir(), "receipts-esm-project-"));
      try {
        const hook = spawnSync(process.execPath, [join(installed, "bin", "hook.js"), "pre"], {
          input: JSON.stringify({ session_id: "s", cwd: project, tool_name: "Read", tool_input: { file_path: join(project, "a.txt") } }),
          env: { ...process.env, CLAUDE_PROJECT_DIR: project },
          encoding: "utf8",
        });
        expect(hook.stderr).toBe("");
        expect(hook.status).toBe(0);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declares the recorder's version, so installed copies update when it changes", () => {
    const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.version).toBe(RECORDER_VERSION);
    expect(JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).type).toBe("commonjs");
  });
});
