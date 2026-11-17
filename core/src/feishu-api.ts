// Bot-identity Feishu OpenAPI calls for things lark-cli has no shortcut for (CardKit streaming cards).
//
// Two paths:
//   - direct: FEISHU_APP_SECRET in secrets.env → the core fetches its own tenant_access_token and calls the API with
//     a kept-alive connection (~0.3 s per call from SG instead of ~3 s per lark-cli process: new TLS + token each time)
//   - fallback: `lark-cli api <METHOD> <path> --as bot` (works today, just slow; streaming updates get coarser)
// The app id is read from sbot's lark-cli config (not a secret).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { P, secret, log } from "./config.ts";
import { lark } from "./feishu.ts";

const BASE = "https://open.feishu.cn";
let tat: { token: string; until: number } | undefined;

function appId(): string | undefined {
  if (secret("FEISHU_APP_ID")) return secret("FEISHU_APP_ID");
  try { return JSON.parse(readFileSync(join(P.larkHome, ".lark-cli", "config.json"), "utf8")).apps?.[0]?.appId; } catch { return undefined; }
}

export const directApi = () => !!(secret("FEISHU_APP_SECRET") && appId());

async function tenantToken(): Promise<string> {
  if (tat && tat.until > Date.now()) return tat.token;
  const r = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId(), app_secret: secret("FEISHU_APP_SECRET") }),
  });
  const j: any = await r.json();
  if (j.code !== 0 || !j.tenant_access_token) throw new Error(`tenant_access_token: code ${j.code} ${j.msg ?? ""}`);
  tat = { token: j.tenant_access_token, until: Date.now() + (Number(j.expire ?? 7200) - 300) * 1000 };
  return tat.token;
}

/** Call a bot API; returns `data`. Throws on a non-zero code. */
export async function botApi(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, params?: Record<string, string>): Promise<any> {
  if (directApi()) {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, {
        method, headers: { authorization: `Bearer ${await tenantToken()}`, "content-type": "application/json; charset=utf-8" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j: any = await r.json().catch(() => ({ code: r.status, msg: "non-JSON response" }));
      // 99991663/99991664/99991668: token invalid or expired → refresh once
      if ([99991663, 99991664, 99991668].includes(j.code) && attempt === 0) { tat = undefined; continue; }
      if (j.code !== 0) throw new Error(`${method} ${path}: code ${j.code} ${String(j.msg ?? "").slice(0, 200)}`);
      return j.data ?? {};
    }
  }
  const args = ["api", method, path, "--as", "bot"];
  if (params) args.push("--params", JSON.stringify(params));
  if (body !== undefined) args.push("--data", "-");
  const out = await lark(args, body === undefined ? undefined : JSON.stringify(body));
  try { const j = JSON.parse(out); return j.data ?? j; } catch { return {}; }
}

if (!directApi()) log("feishu-api", "no FEISHU_APP_SECRET: CardKit calls go through lark-cli (~3 s each)");
