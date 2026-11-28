// pi 扩展：挂 sbot MCP。bash 拦截只是探针的护栏（pi 没有权限请求），正式节点不带。
export default function (pi: any) {
  const mcp = process.env.SBOT_MCP ? JSON.parse(process.env.SBOT_MCP) : undefined;
  if (mcp) pi.registerMcpServer("sbot", { ...mcp, exposure: "direct" });
  const allow = process.env.PROBE_BASH_ALLOW ? new RegExp(process.env.PROBE_BASH_ALLOW) : undefined;
  pi.on("tool_call", async (e: any) => {
    if (allow && e.toolName === "bash" && !allow.test(String(e.input.command).trim()))
      return { block: true, reason: "probe: command not allowed" };
  });
}
