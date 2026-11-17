// LLM proxy (DESIGN §5.2). Every model request from every run goes through 127.0.0.1:7811/llm.
//
//   1. run token: random per run, stored only as a sha256 hash, bound to { run, tier, budget, expiry }
//   2. model alias: sbot-<tier> → the tier's real model (re-read from models.yaml, so edits apply to the next call)
//   3. credential: the endpoint's key from secrets.env is added here and nowhere else
//   4. metering: usage from the SSE / JSON response × price → `usage` table
//   5. hard limits: run budget (output tokens) and global daily cost → 403 permission_error (not 429: the CLI would
//      retry for ~3 min, P0). Why a run ended is read from run_tokens.status, not from the client's error text.

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { models, secret, tierConf, log, PROXY_PORT, TIERS, type Tier, type Price } from "./config.ts";
import { one, run, tx } from "./db.ts";
import { gzipSync } from "node:zlib";

/** §10.4: runs whose exact model requests the console keeps (7 days, owner-only, no agent tool reads them) */
const CAPTURE_ROLES = ["main", "draft"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function issueToken(o: { runId: string; tier: Tier; requester?: string; budgetOutput?: number; ttlMs?: number }) {
  const token = "run_" + randomBytes(18).toString("base64url");
  const budget = o.budgetOutput ?? models().budgets?.run_output_tokens ?? 60_000;
  run("INSERT INTO run_tokens(hash, run_id, tier, requester_id, budget_output, expires) VALUES(?,?,?,?,?,?)",
    sha(token), o.runId, o.tier, o.requester ?? "owner", budget, Date.now() + (o.ttlMs ?? 30 * 60_000));
  return token;
}
export function revokeToken(token: string) {
  run("UPDATE run_tokens SET status='revoked' WHERE hash=? AND status='active'", sha(token));
}
export const tokenStatus = (runId: string) => one("SELECT status, spent_output, budget_output FROM run_tokens WHERE run_id=? ORDER BY rowid DESC", runId);

/**
 * One tool-less Messages call through the proxy with its own short-lived token (summaries, Triage, redrafts, checks,
 * expert reviews). Returns the text. `json: true` → parse the first JSON value in the reply, retrying once (§5.4:
 * structured output by prompt + code check, not forced tools).
 */
export async function complete(o: { tier: Tier; system: string; user: string; maxTokens?: number; runId?: string; requester?: string; json?: boolean }): Promise<any> {
  const runId = o.runId ?? `llm_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const token = issueToken({ runId, tier: o.tier, requester: o.requester ?? "system", budgetOutput: (o.maxTokens ?? 2000) * 2 + 2000, ttlMs: 300_000 });
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/llm/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: `sbot-${o.tier}`, max_tokens: o.maxTokens ?? 2000, system: o.system, messages: [{ role: "user", content: o.user }] }),
      });
      if (!r.ok) throw new Error(`${o.tier} call ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j: any = await r.json();
      const text = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      if (!o.json) return text;
      const m = /[[{][\s\S]*[\]}]/.exec(text.replace(/^```(?:json)?|```$/gm, ""));
      try { if (m) return JSON.parse(m[0]); } catch { /* retry */ }
      if (attempt >= 1) throw new Error(`${o.tier} call: no valid JSON in reply`);
    }
  } finally { revokeToken(token); }
}

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const costOf = (p: Price | undefined, u: Usage) => !p ? 0 :
  (u.input * p.in + u.output * p.out + u.cache_read * (p.cache_read ?? p.in * 0.1) + u.cache_write * (p.cache_write ?? p.in * 1.25)) / 1e6;

type Usage = { input: number; output: number; cache_read: number; cache_write: number };
function meter() {
  let buf = "";
  const u: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const take = (x: any) => {
    if (!x) return;
    if (x.input_tokens) u.input = x.input_tokens;
    if (x.output_tokens) u.output = x.output_tokens;
    if (x.cache_read_input_tokens) u.cache_read = x.cache_read_input_tokens;
    if (x.cache_creation_input_tokens) u.cache_write = x.cache_creation_input_tokens;
  };
  return {
    u,
    feed(s: string) {
      buf += s;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        try { const ev = JSON.parse(line.slice(5)); take(ev.message?.usage); take(ev.usage); } catch {}
      }
    },
    json(s: string) { try { take(JSON.parse(s).usage); } catch {} },
  };
}

const deny = (res: http.ServerResponse, status: number, type: string, message: string) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type, message } }));

function tokenOf(req: http.IncomingMessage) {
  const a = req.headers["authorization"];
  if (typeof a === "string" && a.startsWith("Bearer ")) return a.slice(7);
  const k = req.headers["x-api-key"];
  return typeof k === "string" ? k : undefined;
}

const readBody = (req: http.IncomingMessage) => new Promise<Buffer>((ok, bad) => {
  const parts: Buffer[] = [];
  req.on("data", (c) => parts.push(c)).on("end", () => ok(Buffer.concat(parts))).on("error", bad);
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "/";
  if (!url.startsWith("/llm/")) return deny(res, 404, "not_found_error", "not found");
  const token = tokenOf(req);
  const t = token ? one("SELECT * FROM run_tokens WHERE hash=?", sha(token)) : undefined;
  if (!t || t.status === "revoked" || t.expires < Date.now()) return deny(res, 401, "authentication_error", "bad or expired run token");
  if (t.status === "budget_exhausted" || t.spent_output >= t.budget_output) {
    run("UPDATE run_tokens SET status='budget_exhausted' WHERE hash=?", t.hash);
    log("proxy", "run budget exhausted", { run: t.run_id });
    return deny(res, 403, "permission_error", "run budget exhausted");
  }
  const cfg = models();
  const dailyCap = cfg.budgets?.daily_cost;
  if (dailyCap && (one("SELECT COALESCE(SUM(cost),0) c FROM usage WHERE ts>=?", startOfDay())!.c as number) >= dailyCap) {
    log("proxy", "daily cost cap reached", { cap: dailyCap });
    return deny(res, 403, "permission_error", "daily budget exhausted");
  }

  const raw = await readBody(req);
  let body: Buffer | undefined = req.method === "GET" || req.method === "HEAD" ? undefined : raw;
  // a run may use its own tier and light (Claude Code's small calls); anything else is refused
  let tier = t.tier as Tier;
  if (raw.length && req.method === "POST") {
    let j: any;
    try { j = JSON.parse(raw.toString("utf8")); } catch { return deny(res, 400, "invalid_request_error", "body is not JSON"); }
    const asked = typeof j.model === "string" ? j.model : "";
    const m = /^sbot-(chat|work|light|expert)$/.exec(asked);
    if (m) {
      if (m[1] !== t.tier && m[1] !== "light") return deny(res, 403, "permission_error", `run token is for tier ${t.tier}, not ${m[1]}`);
      tier = m[1] as Tier;
    } else {
      log("proxy", "UNMAPPED model name, using light", { asked, run: t.run_id });
      tier = "light";
    }
    j.model = tierConf(tier).model;
    body = Buffer.from(JSON.stringify(j));
  }
  const tc = tierConf(tier);
  const ep = cfg.endpoints[tc.endpoint];
  const key = ep && secret(ep.key_ref);
  // base_url may be "secret:NAME" when the endpoint itself shouldn't sit in the (agent-readable) config repo
  const base = ep && (ep.base_url.startsWith("secret:") ? secret(ep.base_url.slice(7)) : ep.base_url);
  if (!ep || !key || !base) return deny(res, 500, "api_error", `endpoint for tier ${tier} not configured`);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v !== "string" || ["host", "authorization", "x-api-key", "content-length", "connection"].includes(k)) continue;
    headers[k] = v;
  }
  if (ep.auth === "x-api-key") headers["x-api-key"] = key; else headers["authorization"] = `Bearer ${key}`;

  const t0 = Date.now();
  let up: Response;
  try {
    up = await fetch(base.replace(/\/$/, "") + url.slice("/llm".length), { method: req.method, headers, body });
  } catch (e: any) {
    log("proxy", "upstream error", { err: String(e?.message ?? e), run: t.run_id });
    return deny(res, 502, "api_error", "upstream unreachable");
  }
  const out: Record<string, string> = {};
  up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) out[k] = v; });
  res.writeHead(up.status, out);
  const m = meter();
  const sse = (up.headers.get("content-type") ?? "").includes("event-stream");
  const dec = new TextDecoder();
  let text = "";
  try {
    if (up.body) for await (const c of up.body as any as AsyncIterable<Uint8Array>) {
      res.write(c);
      const s = dec.decode(c, { stream: true });
      if (sse) m.feed(s); else text += s;
    }
  } finally {
    res.end();
    if (!sse) m.json(text);
    const cost = costOf(tc.price, m.u);
    const keep = body && body.length && (t.requester_id === "draft" || CAPTURE_ROLES.includes(one("SELECT role FROM runs WHERE id=?", t.run_id)?.role));
    const gz = keep ? gzipSync(body!) : undefined;
    tx(() => {
      const r = run(`INSERT INTO usage(ts, run_id, tier, endpoint, model, requester_id, input_tokens, output_tokens, cache_read, cache_write, cost, status, ms)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, Date.now(), t.run_id, tier, tc.endpoint, tc.model, t.requester_id,
        m.u.input, m.u.output, m.u.cache_read, m.u.cache_write, cost, up.status, Date.now() - t0);
      run("UPDATE run_tokens SET spent_output = spent_output + ? WHERE hash=?", m.u.output, t.hash);
      if (gz) {
        run("INSERT INTO requests(ts, run_id, usage_id, tier, model, bytes, body) VALUES(?,?,?,?,?,?,?)", t0, t.run_id, Number(r.lastInsertRowid), tier, tc.model, body!.length, gz);
        run("DELETE FROM requests WHERE ts < ?", Date.now() - 7 * 86400_000);
      }
    });
  }
}

export function startProxy(port = PROXY_PORT): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log("proxy", "handler error", { err: String(e?.message ?? e) });
      if (!res.headersSent) deny(res, 500, "api_error", "proxy error"); else res.end();
    });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => { log("proxy", `listening 127.0.0.1:${port}/llm`, { tiers: TIERS.filter((t) => models().tiers[t]) }); ok(server); }));
}
