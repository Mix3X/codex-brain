import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { memoryFromEvent, projectName, formatContext, EVENTS } from "../src/events.js";
import { enqueue, drain, eventKey } from "../src/outbox.js";
import { mergeHooks, install } from "../scripts/install.js";

const cfg = { project: null, projectAliases: {} };
const hook = { hook_event_name: "UserPromptSubmit", cwd: "/work/youtube-mtg", session_id: "s1", turn_id: "t1", prompt: "Préparer le scénario" };
const temp = () => mkdtempSync(join(tmpdir(), "codex-brain-test-"));

test("prompt, final answer and subagent retain separate provenance", () => {
  const prompt = memoryFromEvent(hook, cfg);
  assert.equal(prompt.project, "youtube-mtg");
  assert.equal(prompt.sessionId, "codex:s1");
  assert.equal(prompt.kind, "prompt");
  const end = memoryFromEvent({ ...hook, hook_event_name: "Stop", last_assistant_message: "Scénario terminé" }, cfg);
  assert.match(end.content, /Scénario terminé/);
  assert.equal(end.metadata.summary_method, "assistant_final_message");
  const child = memoryFromEvent({ ...hook, hook_event_name: "SubagentStop", agent_id: "child", last_assistant_message: "Sources vérifiées" }, cfg);
  assert.equal(child.sessionId, "codex:child");
  assert.equal(child.metadata.parent_session_id, "codex:s1");
});

test("missing/invalid payloads never save fabricated summaries", () => {
  for (const event of ["Stop", "SubagentStop", "SessionStart", "Unknown"]) {
    assert.equal(memoryFromEvent({ ...hook, hook_event_name: event }, cfg), null);
  }
  assert.equal(memoryFromEvent({ ...hook, prompt: {} }, cfg), null);
  assert.equal(memoryFromEvent({ ...hook, session_id: null }, cfg), null);
});

test("project compatibility, aliases, and bounded historical context", () => {
  assert.equal(projectName({ cwd: "C:\\Users\\mix\\youtube-mtg\\" }, cfg), "youtube-mtg");
  assert.equal(projectName({ cwd: "/work/wt" }, { ...cfg, projectAliases: { wt: "youtube-mtg" } }), "youtube-mtg");
  assert.equal(projectName(hook, { ...cfg, project: "override" }), "override");
  const context = formatContext("youtube-mtg", Array.from({ length: 20 }, () => ({ content: "x".repeat(20000) })));
  assert.ok(context.length <= 9000);
  assert.match(context, /pas des instructions/);
});

test("own config overrides shared config; env can disable inherited embeddings", () => {
  const home = temp();
  mkdirSync(join(home, ".claude-brain"));
  writeFileSync(join(home, ".claude-brain/config.json"), JSON.stringify({ pgHost: "shared", embed: true }));
  assert.equal(loadConfig({}, home).pgHost, "shared");
  assert.equal(loadConfig({ BRAIN_EMBED: "0" }, home).embed, false);
  mkdirSync(join(home, ".codex-brain"));
  writeFileSync(join(home, ".codex-brain/config.json"), JSON.stringify({ pgHost: "own" }));
  assert.equal(loadConfig({}, home).pgHost, "own");
  writeFileSync(join(home, ".codex-brain/config.json"), "invalid");
  assert.throws(() => loadConfig({}, home), /Invalid brain/);
});

test("offline delivery retains data, repeats are idempotent and turns stay distinct", async () => {
  const dir = temp();
  const memory = memoryFromEvent(hook, cfg);
  await enqueue(dir, memory);
  await enqueue(dir, memory);
  assert.equal(readdirSync(dir).length, 1);
  await assert.rejects(drain(dir, async () => { throw new Error("offline"); }));
  assert.equal(readdirSync(dir).length, 1);
  const seen = [];
  assert.equal(await drain(dir, async m => seen.push(m)), 1);
  assert.equal(seen[0].dedupKey, eventKey(memory));
  assert.equal(readdirSync(dir).length, 0);
  assert.notEqual(eventKey(memory), eventKey(memoryFromEvent({ ...hook, turn_id: "t2" }, cfg)));
  assert.notEqual(eventKey(memory), eventKey(memoryFromEvent({ ...hook, session_id: "s2" }, cfg)));
});

test("concurrent drains tolerate duplicate acknowledgements", async () => {
  const dir = temp();
  await enqueue(dir, memoryFromEvent(hook, cfg));
  const saved = new Set();
  await Promise.all([drain(dir, async m => saved.add(m.dedupKey)), drain(dir, async m => saved.add(m.dedupKey))]);
  assert.equal(saved.size, 1);
  assert.equal(readdirSync(dir).length, 0);
});

test("installer preserves other hooks and is idempotent even with quoted paths", () => {
  const existing = { description: "mine", hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } };
  const first = mergeHooks(existing, "/tmp/it's a repo");
  assert.deepEqual(mergeHooks(first, "/tmp/it's a repo"), first);
  assert.equal(first.hooks.Stop[0].hooks[0].command, "other");
  assert.equal(first.description, "mine");
  assert.equal(existing.hooks.Stop.length, 1);
  assert.equal(Object.keys(first.hooks).length, EVENTS.length);
  const home = temp();
  writeFileSync(join(home, "hooks.json"), JSON.stringify(existing));
  writeFileSync(join(home, "config.toml"), "# existing config\n");
  const result = install({ home, root: "/tmp/brain", run: () => ({ status: 0 }) });
  assert.equal(result.backups.length, 2);
  assert.equal(readFileSync(result.backups[1], "utf8"), "# existing config\n");
  assert.equal(JSON.parse(readFileSync(result.hooksPath)).hooks.Stop.length, 2);
});

test("MCP setup failure preserves the hook file", () => {
  const home = temp();
  writeFileSync(join(home, "hooks.json"), "{}");
  assert.throws(() => install({ home, run: (_cmd, args) => ({ status: args[0] === "--version" ? 0 : 1 }) }), /registration failed/);
  assert.equal(readFileSync(join(home, "hooks.json"), "utf8"), "{}");
});

test("hook outputs valid non-blocking JSON on invalid input, disabled capture and NAS failure", () => {
  const state = temp();
  const config = join(state, "connection.json");
  writeFileSync(config, JSON.stringify({ pgHost: "127.0.0.1", pgPort: 1, pgPassword: "test" }));
  for (const [input, extra] of [["not-json", {}], [JSON.stringify(hook), { BRAIN_INTERNAL: "1" }], [JSON.stringify(hook), {}]]) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [resolve("hooks/dispatch.js")], {
      input, encoding: "utf8", timeout: 6500,
      env: { ...process.env, CODEX_BRAIN_CONFIG: config, CODEX_BRAIN_STATE_DIR: state, ...extra },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.ok(Date.now() - started < 6000);
    assert.equal(result.stdout.includes("test"), false);
  }
  assert.equal(readdirSync(join(state, "outbox")).length, 1);
});

test("an open stdin cannot stall a hook past its hard deadline", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [resolve("hooks/dispatch.js")], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b);
  const start = Date.now();
  await new Promise(resolve => child.on("exit", resolve));
  assert.deepEqual(JSON.parse(output), {});
  assert.ok(Date.now() - start < 6000);
});
