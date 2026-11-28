// 起 agent 子进程用的环境：去掉外层 agent 会话留下的变量，免得被当成嵌套会话。
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k !== "CLAUDE_CODE_OAUTH_TOKEN" && /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_|T3CODE_)/.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}
