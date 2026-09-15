#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { EVENTS } from "../src/events.js";

export const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
export function mergeHooks(existing, root, node = process.execPath) {
  const result = structuredClone(existing);
  result.hooks ||= {};
  for (const event of EVENTS) {
    const groups = result.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error(`Invalid hook groups: ${event}`);
    // Own a group through the explicit status marker, preserving all other handlers.
    const kept = groups.map(group => ({ ...group, hooks: (group.hooks || []).filter(
      h => h.statusMessage !== `codex-brain: ${event}`,
    ) })).filter(group => group.hooks.length);
    kept.push({ hooks: [{
      type: "command",
      command: `${quote(node)} ${quote(join(root, "hooks", "dispatch.js"))} ${event}`,
      timeout: 6,
      statusMessage: `codex-brain: ${event}`,
      ...(["SessionStart", "SubagentStart"].includes(event) ? { additionalContextLimit: 2500 } : {}),
    }] });
    result.hooks[event] = kept;
  }
  return result;
}

export function install({ home = process.env.CODEX_HOME || join(homedir(), ".codex"), root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), run = spawnSync } = {}) {
  if (process.platform === "win32") throw new Error("Installer supports Linux/macOS; use WSL on Windows.");
  const check = run("codex", ["--version"], { encoding: "utf8" });
  if (check.status !== 0) throw new Error("Codex CLI is required");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const hooksPath = join(home, "hooks.json");
  const existing = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, "utf8")) : {};
  const hooks = mergeHooks(existing, root);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backups = [];
  for (const name of ["hooks.json", "config.toml"]) {
    const path = join(home, name);
    if (existsSync(path)) {
      const backup = `${path}.codex-brain-${stamp}.bak`;
      copyFileSync(path, backup);
      backups.push(backup);
    }
  }
  const added = run("codex", ["mcp", "add", "brain", "--", process.execPath, join(root, "src", "mcp-server.js")], {
    encoding: "utf8", env: { ...process.env, CODEX_HOME: home },
  });
  if (added.status !== 0) throw new Error("MCP registration failed; hooks were not changed.");
  const tmp = `${hooksPath}.codex-brain-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(hooks, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, hooksPath);
  return { hooksPath, backups };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(install(), null, 2));
    console.log("Installed. Restart Codex, then /hooks to review and trust the five codex-brain hooks; /mcp to check brain.");
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
