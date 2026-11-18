// Public entrance to the console (DESIGN §10.1): nginx on 443 (Let's Encrypt, DNS only at Cloudflare) → unix socket
// /run/sbot-web/console.sock. Same shape as the owner's other admin gate: one password (PBKDF2-SHA256, hash in
// secrets.env), an HMAC-signed session cookie for 12 h (Secure, HttpOnly, SameSite=Strict), the login POST must come
// from our own Origin, failures are rate limited here and in nginx.
//
// Nothing the client or the proxy sends counts as identity on this socket. Tailscale-User-Login is ignored: only
// tailscaled replaces it, and nginx (or any www-data process that can reach this socket) would pass a forged one through.

import http from "node:http";
import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { P, secret, log } from "./config.ts";

export const PASS_SECRET = "CONSOLE_WEB_PASSWORD_HASH";
export const KEY_SECRET = "CONSOLE_WEB_SESSION_KEY";
/** set only by console-passwd.ts on the server; the console's secrets page refuses them */
export const WEB_SECRETS = [PASS_SECRET, KEY_SECRET];
export const COOKIE = "__Host-sbot_console";   // __Host-: Secure, Path=/, no Domain, so no sibling host can set it
export const TTL = 12 * 3600;
export const WEB_LOGIN = "公网入口";
export const ITERATIONS = 300_000;
const pbkdf2Async = promisify(pbkdf2);

/** console.yaml `web.origin`, e.g. https://console.example.com (the host lives on the server, not in the repo) */
export function webOrigin(): string | null {
  const f = join(P.config, "console.yaml");
  if (!existsSync(f)) return null;
  try {
    const o = parseYaml(readFileSync(f, "utf8"))?.web?.origin;
    return typeof o === "string" && ORIGIN_RE.test(o) ? o : null;
  } catch { return null; }
}
export const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/** null = the entrance is off: no origin in console.yaml, or no password / session key on the server */
export function webConf(): { origin: string; hash: string; key: string } | null {
  const origin = webOrigin(), hash = secret(PASS_SECRET), key = secret(KEY_SECRET);
  return origin && hash && key && key.length >= 32 ? { origin, hash, key } : null;
}

// ───────── password ─────────

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await pbkdf2Async(pw, salt, ITERATIONS, 32, "sha256");
  return `pbkdf2_sha256$${ITERATIONS}$${salt.toString("base64")}$${h.toString("base64")}`;
}

// async pbkdf2 runs on the libuv pool, so a login attempt doesn't stall the core's event loop for ~0.2 s
export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const m = /^pbkdf2_sha256\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m || Number(m[1]) < ITERATIONS) return false;
  const want = Buffer.from(m[3], "base64");
  if (want.length < 16) return false;
  const got = await pbkdf2Async(pw, Buffer.from(m[2], "base64"), Number(m[1]), want.length, "sha256");
  return timingSafeEqual(got, want);
}

// ───────── session cookie: <unix seconds>.<nonce>.<hmac> ─────────

const mac = (key: string, payload: string) => createHmac("sha256", key).update("sbot-console/1." + payload).digest("hex");

export function signSession(key: string, now = Date.now()): string {
  const p = `${Math.floor(now / 1000)}.${randomBytes(16).toString("hex")}`;
  return `${p}.${mac(key, p)}`;
}

export function validSession(cookieHeader: string | undefined, key: string, now = Date.now()): boolean {
  const v = cookieValue(cookieHeader, COOKIE);
  const m = v ? /^(\d{9,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(v) : null;
  if (!m) return false;
  const age = Math.floor(now / 1000) - Number(m[1]);
  if (age < 0 || age >= TTL) return false;
  return timingSafeEqual(Buffer.from(mac(key, `${m[1]}.${m[2]}`), "hex"), Buffer.from(m[3], "hex"));
}

function cookieValue(h: string | undefined, name: string): string | null {
  for (const part of String(h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const setCookie = (v: string) => `${COOKIE}=${v}; Path=/; Max-Age=${TTL}; Secure; HttpOnly; SameSite=Strict`;
const clearCookie = `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;

// ───────── failed logins: per client IP and overall ─────────
// X-Real-IP comes from nginx; a local www-data process could forge it, which is why there is a global cap too.

const WINDOW = 10 * 60_000, PER_IP = 10, GLOBAL = 30;
let fails: { ip: string; at: number }[] = [];
let lockedNoticeAt = 0;
const prune = (now: number) => { fails = fails.filter((f) => now - f.at < WINDOW); };
export function limited(ip: string, now = Date.now()): boolean {
  prune(now);
  return fails.length >= GLOBAL || fails.filter((f) => f.ip === ip).length >= PER_IP;
}
/** true when this failure just tripped a limit and nobody has been told within the window */
function noteFailure(ip: string, now = Date.now()): boolean {
  fails.push({ ip, at: now });
  if (!limited(ip, now) || now - lockedNoticeAt < WINDOW) return false;
  lockedNoticeAt = now;
  return true;
}
export function resetLimiter() { fails = []; lockedNoticeAt = 0; }

const maskIp = (ip: string) => ip.includes(":") ? ip.split(":").slice(0, 3).join(":") + ":…" : ip.replace(/\.\d+\.\d+$/, ".*.*");

// ───────── pages ─────────

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
  "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",   // see WEB_SEC_HEADERS
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

// msg is always one of our own strings, never anything from the request
function loginPage(msg = ""): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>SStudioBot 控制台</title><style>
body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
form{display:grid;gap:12px;width:min(320px,86vw)}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #8886}
button{cursor:pointer}p{margin:0;color:#c33}h1{font-size:18px;margin:0 0 4px}</style></head><body>
<form method="post" action="/_auth"><h1>SStudioBot 控制台</h1>${msg ? `<p>${msg}</p>` : ""}
<input type="password" name="password" autocomplete="current-password" aria-label="密码" placeholder="密码" required autofocus>
<button>进入</button></form></body></html>`;
}

function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > 4096) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/** /_login, /_auth, /_logout on the public socket */
export async function handleAuthPaths(req: http.IncomingMessage, res: http.ServerResponse, path: string,
  w: { origin: string; hash: string; key: string }, notify: (text: string) => Promise<void>): Promise<void> {
  const page = (status: number, msg = "", extra: Record<string, string> = {}) => { res.writeHead(status, { ...PAGE_HEADERS, ...extra }); res.end(loginPage(msg)); };
  const method = req.method ?? "GET";
  if (path === "/_login") {
    if (validSession(req.headers.cookie, w.key)) { res.writeHead(303, { Location: "/", "Cache-Control": "no-store" }); return void res.end(); }
    return page(200);
  }
  if (method !== "POST") { res.writeHead(405, { Allow: "POST" }); return void res.end(); }
  // a browser always sends Origin on a POST; anything else is a cross-site form or not a browser
  if (req.headers.origin !== w.origin) { res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }); return void res.end("403"); }
  if (path === "/_logout") { res.writeHead(204, { "Set-Cookie": clearCookie, "Cache-Control": "no-store" }); return void res.end(); }

  const ip = String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "?").slice(0, 64);
  if (limited(ip)) return page(429, "试错太多次了，10 分钟后再试。");
  if (!/^application\/x-www-form-urlencoded\b/.test(String(req.headers["content-type"] ?? ""))) return page(400, "请从登录页提交。");
  let pw = "";
  try { pw = (await readForm(req)).get("password") ?? ""; } catch { return page(413, "请求太大。"); }
  if (pw && await checkPassword(pw, w.hash)) {
    log("console", "web login", { ip: maskIp(ip) });
    void notify(`🔐 控制台公网入口登录了（IP ${maskIp(ip)}）。不是你的话，在服务器上跑 console-passwd 换密码，所有会话立刻失效。`);
    res.writeHead(303, { Location: "/", "Set-Cookie": setCookie(signSession(w.key)), "Cache-Control": "no-store" });
    return void res.end();
  }
  log("console", "web login failed", { ip: maskIp(ip) });
  if (noteFailure(ip)) void notify(`⚠️ 控制台公网入口密码连续输错，已限流（IP ${maskIp(ip)}，10 分钟窗口）。`);
  return page(401, "密码不对。");
}
