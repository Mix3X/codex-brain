import { mkdir, writeFile, rename, readdir, readFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

export function eventKey(memory) {
  return createHash("sha256").update(JSON.stringify([
    "codex-event-v1", memory.project, memory.kind, memory.sessionId,
    memory.metadata.turn_id, memory.content,
  ])).digest("hex");
}

export async function enqueue(dir, memory) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const key = eventKey(memory);
  const path = join(dir, `${key}.json`);
  const tmp = join(dir, `${key}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify({ ...memory, dedupKey: key, createdAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(tmp, path);
}

// Concurrent drains are safe: PostgreSQL's unique hash makes delivery idempotent.
// Remove an item only after the database acknowledged its insert (or duplicate).
export async function drain(dir, save, limit = 10) {
  let names;
  try { names = await readdir(dir); } catch (e) { if (e.code === "ENOENT") return 0; throw e; }
  let count = 0;
  for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, limit)) {
    const path = join(dir, name);
    let memory;
    try { memory = JSON.parse(await readFile(path, "utf8")); }
    catch (e) { if (e.code === "ENOENT") continue; throw e; }
    await save(memory);
    await unlink(path).catch(e => { if (e.code !== "ENOENT") throw e; });
    count++;
  }
  return count;
}
