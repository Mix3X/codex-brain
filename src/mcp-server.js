#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { addMemory, search, recent } from "./store.js";
import { embeddingsEnabled } from "./embed.js";

const server = new Server(
  { name: "codex-brain", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Search shared cross-machine/cross-project memory. Use when the user asks 'did we already do/solve X?', 'how did we handle Y before?', or needs context from a previous session on any machine.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        project: { type: "string", description: "Optional: restrict to one project name" },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["observation", "summary", "prompt"] },
          description: "Optional: filter by memory kind",
        },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_add",
    description:
      "Save a durable note to shared memory (a decision, a fix, a gotcha worth remembering across sessions/machines).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        content: { type: "string" },
        kind: { type: "string", enum: ["observation", "summary"], description: "default observation" },
      },
      required: ["project", "content"],
    },
  },
  {
    name: "memory_context",
    description: "Get the most recent memories for a project (recent decisions/summaries).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        limit: { type: "number" },
      },
      required: ["project"],
    },
  },
];

function limit(value, fallback) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 50) : fallback;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function fmt(rows) {
  if (!rows.length) return "No matching memories.";
  return rows
    .map((r) => {
      const when = new Date(r.created_at).toISOString().slice(0, 10);
      const score = r.score != null ? ` (${r.score.toFixed(3)})` : "";
      return `[${r.kind} · ${r.project} · ${when}${score}]\n${r.content}`;
    })
    .join("\n\n---\n\n");
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    if (name === "memory_search") {
      if (typeof a.query !== "string" || !a.query.trim()) throw new Error("Invalid query");
      const rows = await search({ q: a.query.slice(0, 2000), project: a.project, kinds: a.kinds, limit: limit(a.limit, 10) });
      return { content: [{ type: "text", text: fmt(rows) }] };
    }
    if (name === "memory_add") {
      if (typeof a.project !== "string" || !a.project.trim() || typeof a.content !== "string" || !a.content.trim() || a.content.length > 24000) throw new Error("Invalid memory");
      const id = await addMemory({ project: a.project, kind: a.kind || "observation", content: a.content });
      return { content: [{ type: "text", text: id ? `Saved (#${id}).` : "Already stored (duplicate)." }] };
    }
    if (name === "memory_context") {
      if (typeof a.project !== "string" || !a.project.trim()) throw new Error("Invalid project");
      const rows = await recent({ project: a.project, limit: limit(a.limit, 12) });
      return { content: [{ type: "text", text: fmt(rows) }] };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch {
    return { content: [{ type: "text", text: "brain: operation failed; check arguments and local NAS configuration." }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `codex-brain MCP ready (embeddings: ${embeddingsEnabled() ? "on" : "off / FTS"})\n`
);
