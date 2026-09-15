import { loadConfig } from "./config.js";

// Lazy, optional local embeddings (all-MiniLM-L6-v2, 384 dims).
// Requires the optional dependency @huggingface/transformers + config.embed=true.
// If unavailable, returns null and the system falls back to Postgres full-text search.
let extractor = null;
let tried = false;

async function getExtractor() {
  if (extractor || tried) return extractor;
  tried = true;
  const { embed } = loadConfig();
  if (!embed) return null;
  try {
    const { pipeline } = await import("@huggingface/transformers");
    extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  } catch {
    extractor = null; // dependency missing -> silently disable embeddings
  }
  return extractor;
}

// Returns a pgvector-compatible string '[0.1,0.2,...]' or null.
export async function embed(text) {
  const ex = await getExtractor();
  if (!ex || !text) return null;
  const out = await ex(text.slice(0, 8000), { pooling: "mean", normalize: true });
  return "[" + Array.from(out.data).join(",") + "]";
}

export function embeddingsEnabled() {
  return loadConfig().embed;
}
