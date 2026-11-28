// `sbot-node mcp --session <ref>` 的替身：stdio MCP server，经本机 socket 把工具调用转给「节点」。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect } from "./frames.ts";

const sock = process.env.SBOT_SOCK;
if (!sock) throw new Error("SBOT_SOCK missing");
const i = process.argv.indexOf("--session");
const session = i > 0 ? process.argv[i + 1] : "adhoc";
const link = await connect(sock);

const server = new McpServer({ name: "sbot", version: "0.0.0" });
server.registerTool(
  "sbot_ping",
  { description: "Returns a token from the sbot hub.", inputSchema: { note: z.string() } },
  async ({ note }) => {
    const text = await link.request<string>({ type: "tool_call", session, name: "sbot_ping", args: { note } });
    return { content: [{ type: "text" as const, text }] };
  },
);
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => process.exit(0));
