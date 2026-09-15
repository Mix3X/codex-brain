// Explicit opt-in integration test. Only writes to its own unique test project.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { query, closePool } from "../src/db.js";

const project = `codex-brain-test-${randomUUID()}`;
const state = mkdtempSync(join(tmpdir(), "codex-brain-nas-"));
let projectId;
async function fire(hook) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve("hooks/dispatch.js")], {
      env: { ...process.env, CODEX_BRAIN_PROJECT: project, CODEX_BRAIN_STATE_DIR: state },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", b => output += b);
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", code => {
      try { assert.equal(code, 0); resolveResult(JSON.parse(output)); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify({ cwd: `/tmp/${project}`, session_id: "test-parent", turn_id: "t1", ...hook }));
  });
}

try {
  const result = await query("INSERT INTO projects(name) VALUES($1) RETURNING id", [project]);
  projectId = result.rows[0].id;
  // Existing Claude-compatible rows must be readable without migration.
  await query("INSERT INTO memories(project_id,kind,session_id,content,metadata) VALUES($1,'observation','claude-test','Legacy Claude note',$2::jsonb)", [projectId, JSON.stringify({ provider: "claude" })]);
  const prompt = { hook_event_name: "UserPromptSubmit", prompt: "Test synthetic prompt" };
  await Promise.all([fire(prompt), fire(prompt)]);
  await fire({ ...prompt, turn_id: "t2" });
  await fire({ hook_event_name: "Stop", last_assistant_message: "Synthetic final answer" });
  await fire({ hook_event_name: "SubagentStop", agent_id: "test-child", agent_type: "research", last_assistant_message: "Synthetic child answer" });
  const rows = (await query("SELECT kind,session_id,metadata,content FROM memories WHERE project_id=$1", [projectId])).rows;
  assert.equal(rows.length, 5);
  assert.equal(rows.filter(r => r.kind === "prompt").length, 2);
  assert.equal(rows.find(r => r.session_id === "codex:test-child").metadata.parent_session_id, "codex:test-parent");
  assert.equal(rows.find(r => r.session_id === "claude-test").content, "Legacy Claude note");
  for (const event of ["SessionStart", "SubagentStart"]) {
    const response = await fire({ hook_event_name: event, agent_id: "test-child" });
    assert.equal(response.hookSpecificOutput.hookEventName, event);
    assert.match(response.hookSpecificOutput.additionalContext, /Legacy Claude note/);
    assert.match(response.hookSpecificOutput.additionalContext, /Synthetic final answer/);
  }
  if (existsSync(join(state, "outbox"))) assert.equal(readdirSync(join(state, "outbox")).length, 0);
  console.log("NAS integration OK: 5 hooks, legacy reads, parent/child links, concurrent deduplication, distinct turns.");
} finally {
  if (projectId) await query("DELETE FROM projects WHERE id=$1 AND name=$2", [projectId, project]);
  await closePool();
}
