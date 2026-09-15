import pg from "pg";
import { loadConfig } from "./config.js";

let pool = null;

export function getPool() {
  if (pool) return pool;
  const c = loadConfig();
  const base = { max: 4, connectionTimeoutMillis: 1200, idleTimeoutMillis: 1000, statement_timeout: 1500, query_timeout: 2000 };
  let opts;
  if (c.pgPassword) {
    // discrete fields: password used verbatim, no URL parsing/encoding
    opts = { ...base, host: c.pgHost, port: c.pgPort, user: c.pgUser, password: c.pgPassword, database: c.pgDatabase };
  } else if (c.pg) {
    opts = { ...base, connectionString: c.pg };
  } else {
    throw new Error("codex-brain: no Postgres connection (config.pgPassword+pgHost, or config.pg)");
  }
  pool = new pg.Pool(opts);
  pool.on("error", () => {}); // never let an idle-client error crash the process
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

// Upsert project, return id.
export async function projectId(name) {
  const r = await query(
    `INSERT INTO projects (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name]
  );
  return r.rows[0].id;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}
