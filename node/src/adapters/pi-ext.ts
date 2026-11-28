// A pi extension the node loads with `-e` (05, 08 P7): pi has no `--mcp-config`, so this registers the sbot MCP
// from SBOT_NODE_PI_MCP. `exposure: "direct"` is what makes pi declare the tools to the model. pi loads this file
// itself; nothing in node/ imports it. No tool_call hook: pi's `block` is a refusal, not a question, and is not used
// as a permission system (05).
export default function sbotNodeExtension(pi: { registerMcpServer(name: string, o: Record<string, unknown>): void }) {
  const raw = process.env.SBOT_NODE_PI_MCP;
  if (!raw) return;
  try { pi.registerMcpServer("sbot", { ...JSON.parse(raw), exposure: "direct" }); } catch { /* a bad value: no sbot tools, pi still runs */ }
}
