// FCM (03 push 「FCM」, veto 8): HTTP v1, our own RS256 JWT with node:crypto, the access token cached 50 minutes; no
// firebase-admin. Behind console.yaml fcm.enabled, which is off by default and stays off until I turn it on (a
// widening). The service account is in secrets.env (FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY ※); none exists
// yet, so the hub only ever uses this when both the flag and the secrets are there. Tokens and keys are never logged.
import { createSign } from "node:crypto";
import type { PushChannel, PushData } from "../../../protocol/api/push.ts";
import { secret } from "../secrets.ts";
import { log } from "../log.ts";

export interface FcmMessage { title: string; body: string; channel: PushChannel; data: PushData }
/** ok: FCM took it · invalid: the token is dead (UNREGISTERED / INVALID_ARGUMENT) · error: try the channel instead */
export type FcmResult = "ok" | "invalid" | "error";
export interface FcmSender { send(token: string, m: FcmMessage): Promise<FcmResult> }

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const TOKEN_TTL = 50 * 60_000;

/** The real sender; undefined when the service account isn't in secrets.env. */
export function httpFcm(f: typeof fetch = fetch): FcmSender | undefined {
  const project = secret("FCM_PROJECT_ID"), email = secret("FCM_CLIENT_EMAIL"), key = secret("FCM_PRIVATE_KEY")?.replace(/\\n/g, "\n");
  if (!project || !email || !key) return undefined;
  let cached: { token: string; until: number } | undefined;
  async function access(): Promise<string> {
    if (cached && cached.until > Date.now()) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64u(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(key!);
    const r = await f("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64u(sig)}` }),
    });
    if (!r.ok) throw new Error(`token exchange ${r.status}`);
    const j = await r.json() as { access_token?: string };
    if (!j.access_token) throw new Error("token exchange: no access_token");
    cached = { token: j.access_token, until: Date.now() + TOKEN_TTL };
    return cached.token;
  }
  return {
    async send(token, m) {
      try {
        const r = await f(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project!)}/messages:send`, {
          method: "POST", headers: { authorization: `Bearer ${await access()}`, "content-type": "application/json" },
          body: JSON.stringify({ message: { token, notification: { title: m.title, body: m.body }, data: m.data, android: { notification: { channel_id: m.channel } } } }),
        });
        if (r.ok) return "ok";
        const j = await r.json().catch(() => ({})) as { error?: { status?: string; details?: { errorCode?: string }[] } };
        const code = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status;
        if (code === "UNREGISTERED" || code === "INVALID_ARGUMENT" || r.status === 404) return "invalid";
        log("push", "fcm refused", { status: r.status, code: code ?? null });
        return "error";
      } catch (e) {
        log("push", "fcm failed", { err: String((e as Error)?.message ?? e).slice(0, 120) });
        return "error";
      }
    },
  };
}
