import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const client = new Client({ name: "codex-brain-check", version: "1.0.0" });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    env: process.env,
    args: [fileURLToPath(new URL("../src/mcp-server.js", import.meta.url))],
  }));
  const { tools } = await client.listTools();
  console.log("MCP tools:", tools.map(t => t.name).join(", "));
  const result = await client.callTool({ name: "memory_context", arguments: {
    project: process.argv[2] || "youtube-mtg", limit: 1,
  } });
  if (result.isError) throw new Error("Memory read failed");
  console.log("NAS memory read OK (content omitted).");
} catch {
  console.error("Check failed. Check the NAS connection and local brain configuration.");
  process.exitCode = 1;
} finally { await client.close(); }
