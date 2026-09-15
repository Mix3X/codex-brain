import { readFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export function loadConfig(env = process.env, home = homedir()) {
  const own = join(home, ".codex-brain", "config.json");
  const path = env.CODEX_BRAIN_CONFIG || env.BRAIN_CONFIG ||
    (existsSync(own) ? own : join(home, ".claude-brain", "config.json"));
  let raw = {};
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Invalid brain configuration"); }
  const bounded = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.min(Math.floor(Number(value)), max) : fallback;
  return {
    pg: env.BRAIN_PG || raw.pg || null,
    pgHost: env.BRAIN_PG_HOST || raw.pgHost || null,
    pgPort: Number(env.BRAIN_PG_PORT || raw.pgPort || 5432),
    pgUser: env.BRAIN_PG_USER || raw.pgUser || "nasmem",
    pgPassword: env.BRAIN_PG_PASSWORD || raw.pgPassword || null,
    pgDatabase: env.BRAIN_PG_DATABASE || raw.pgDatabase || "nasmem",
    embed: env.BRAIN_EMBED !== undefined ? env.BRAIN_EMBED === "1" : Boolean(raw.embed),
    machine: env.BRAIN_MACHINE || raw.machine || hostname(),
    contextLimit: bounded(raw.contextLimit, 6, 12),
    project: env.CODEX_BRAIN_PROJECT || raw.project || null,
    projectAliases: raw.projectAliases || {},
    stateDir: env.CODEX_BRAIN_STATE_DIR || join(home, ".codex-brain"),
  };
}
