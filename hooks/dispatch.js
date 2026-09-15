#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { addMemory, recent } from "../src/store.js";
import { closePool } from "../src/db.js";
import { EVENTS, isStart, projectName, memoryFromEvent, formatContext } from "../src/events.js";
import { enqueue, drain } from "../src/outbox.js";

let ended = false;
function finish(output = {}) {
  if (ended) return;
  ended = true;
  process.stdout.write(JSON.stringify(output) + "\n", () => process.exit(0));
}
// Includes stdin, connection, SQL, and cleanup. Never keep Codex waiting on the NAS.
const deadline = setTimeout(() => finish(), 5000);
if (process.env.BRAIN_INTERNAL === "1" || process.env.CODEX_BRAIN_DISABLED === "1") finish();
else {
  let cfg;
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1024 * 1024) throw new Error("InputTooLarge");
    }
    const hook = JSON.parse(raw);
    const expected = process.argv[2];
    if (!hook || !EVENTS.includes(hook.hook_event_name) || (expected && expected !== hook.hook_event_name)) {
      throw new Error("UnsupportedEvent");
    }
    cfg = loadConfig();
    const queue = join(cfg.stateDir, "outbox");
    const memory = memoryFromEvent(hook, cfg);
    if (memory) await enqueue(queue, memory);
    let output = {};
    if (isStart(hook.hook_event_name)) {
      // Read first: a large offline queue must not delay startup context.
      const project = projectName(hook, cfg);
      const rows = await recent({ project, limit: cfg.contextLimit });
      output = { hookSpecificOutput: {
        hookEventName: hook.hook_event_name,
        additionalContext: formatContext(project, rows),
      } };
    }
    await drain(queue, addMemory);
    await closePool();
    clearTimeout(deadline);
    finish(output);
  } catch (e) {
    // Log codes only: never credentials, prompt contents, or connection strings.
    if (cfg) {
      await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 }).catch(() => {});
      await appendFile(join(cfg.stateDir, "hooks.log"), `${new Date().toISOString()} hook failed: ${e.code || e.name || "Error"}\n`, { mode: 0o600 }).catch(() => {});
    }
    finish();
  }
}
