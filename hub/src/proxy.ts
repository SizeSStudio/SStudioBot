// LLM proxy (§办2.2, 03 proxy, R7). Only runs inside the hub process use it (pi); remote nodes never get a token (D3).
//   1. run token: random per run, stored as sha256 only, bound to {run, tier, requester}; revoked when the run ends,
//      no TTL (a run has no time limit). Bad or revoked → 401.
//   2. alias sbot-<tier> → the tier's real model, re-read from models.yaml on every request, so a mid-run model change
//      lands on the next request — always after the tool results are back (P10, IC-11). A run may use its own tier
//      and light; any other tier → 403 permission_error.
//   3. the endpoint's key from secrets.env is added here and nowhere else.
//   4. budgets only alert (R7 限5): run output line, daily cost line, per-tier daily line. Nothing is ever refused.
//   5. metering → usage (source = proxy, device_id = the run's); main/draft requests are kept gzip'd for 7 days.
//   6. when the model differs from the one the lane last used: thinking blocks are dropped and tool-call ids are
//      rewritten to the target family's shape (§办2.4).
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Db } from "./db/db.ts";
import { alertLines, modelsConf, tierConf, TIERS, type Tier, type TierConf } from "./config/load.ts";
import { secret } from "./secrets.ts";
import { putBlob } from "./blobs.ts";
import { classifyUpstream } from "./retry.ts";
import * as notify from "./notify.ts";
import { log } from "./log.ts";
import { TZ } from "./home.ts";

/** §触5.4: roles whose exact model requests are kept (7 days, readable by me only, no tool reads them) */
const CAPTURE_ROLES = new Set(["main", "draft"]);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function issueToken(db: Db, o: { run_id: string; tier: Tier; requester?: string }): string {
  const token = "run_" + randomBytes(18).toString("base64url");
  db.run("INSERT INTO run_tokens(hash, run_id, tier, requester_id, budget_output, expires) VALUES (?,?,?,?,?,NULL)",
    sha(token), o.run_id, o.tier, o.requester ?? "main", alertLines().run_output_tokens);
  return token;
}
export function revokeToken(db: Db, token: string) { db.run("UPDATE run_tokens SET status = 'revoked' WHERE hash = ?", sha(token)); }
export function revokeRun(db: Db, run_id: string) { db.run("UPDATE run_tokens SET status = 'revoked' WHERE run_id = ? AND status = 'active'", run_id); }

// ───────── request shaping on a model change ─────────

type Msg = { role: string; content: unknown };
type Block = Record<string, unknown> & { type?: string };

/** Which family's tool-call id shape a model expects. undefined = leave ids alone. */
export function idFamily(model: string): { prefix: string; re: RegExp } | undefined {
  if (/claude|anthropic/i.test(model)) return { prefix: "toolu_", re: /^toolu_[A-Za-z0-9_-]+$/ };
  if (/\bgpt|\bo[1-9]\b|openai|codex/i.test(model)) return { prefix: "call_", re: /^call_[A-Za-z0-9_-]+$/ };
  return undefined;
}

/**
 * Make a request built for one model safe for another (§办2.4): thinking blocks only make sense to the model that wrote
 * them (dropped when `prevModel` differs), and tool ids get the target family's shape everywhere (tool_use.id and
 * tool_result.tool_use_id map the same way, so pairs stay paired). Pure; returns whether anything changed.
 */
export function shapeForModel(body: { messages?: Msg[] }, model: string, prevModel?: string): boolean {
  if (!Array.isArray(body.messages)) return false;
  const strip = !!prevModel && prevModel !== model;
  const fam = idFamily(model);
  const map = new Map<string, string>();
  const fix = (id: unknown): unknown => {
    if (typeof id !== "string" || !fam || fam.re.test(id)) return id;
    let n = map.get(id);
    if (!n) { n = fam.prefix + sha(id).slice(0, 24); map.set(id, n); }
    return n;
  };
  let changed = false;
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    const before = m.content.length;
    let blocks = m.content as Block[];
    if (strip && m.role === "assistant") blocks = blocks.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    if (blocks.length !== before) changed = true;
    m.content = blocks.map((b) => {
      if (b.type === "tool_use" && fix(b.id) !== b.id) { changed = true; return { ...b, id: fix(b.id) }; }
      if (b.type === "tool_result" && fix(b.tool_use_id) !== b.tool_use_id) { changed = true; return { ...b, tool_use_id: fix(b.tool_use_id) }; }
      return b;
    });
  }
  return changed;
}

// ───────── metering ─────────

type Usage = { input: number; output: number; cache_read: number; cache_write: number };
const costOf = (p: TierConf["price"] | undefined, u: Usage) => !p ? 0 :
  (u.input * p.in + u.output * p.out + u.cache_read * (p.cache_read ?? p.in * 0.1) + u.cache_write * (p.cache_write ?? p.in * 1.25)) / 1e6;

function meter() {
  let buf = "";
  const u: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const take = (x: Record<string, number> | undefined) => {
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
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        try { const ev = JSON.parse(line.slice(5)); take(ev.message?.usage); take(ev.usage); } catch { /* not JSON */ }
      }
    },
    json(s: string) { try { take(JSON.parse(s).usage); } catch { /* not JSON */ } },
  };
}

const dayKey = (now = Date.now()) => new Date(now).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 10);
const startOfDay = (now = Date.now()) => {
  const d = dayKey(now), shown = Date.parse(new Date(now).toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T") + "Z");
  return now - (shown - Date.parse(d + "T00:00:00Z"));
};

/** R7: each line alerts once (per token, per day), through the admin outlet. Never refuses. */
async function checkLines(db: Db, t: { hash: string; run_id: string; tier: string; budget_output: number }, spent: number) {
  const lines = alertLines(), day = dayKey(), once = (k: string) => {
    if (db.kvGet(k)) return false;
    db.kvSet(k, String(Date.now()));
    return true;
  };
  const say: string[] = [];
  if (t.budget_output > 0 && spent >= t.budget_output && once(`proxy.alert.run:${t.hash.slice(0, 16)}`))
    say.push(`run ${t.run_id} 输出已到 ${spent} tokens，过了单 run 告警线 ${t.budget_output}。照常跑，没拦。`);
  if (lines.daily_cost) {
    const c = db.one<{ c: number }>("SELECT COALESCE(SUM(cost), 0) AS c FROM usage WHERE ts >= ?", startOfDay())!.c;
    if (c >= lines.daily_cost && once(`proxy.alert.daily:${day}`)) say.push(`今天模型花费 $${c.toFixed(2)}，过了全天告警线 $${lines.daily_cost}。照常跑，没拦。`);
  }
  const tl = lines.tier_daily[t.tier as Tier];
  if (tl) {
    const n = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM usage WHERE tier = ? AND ts >= ? AND source = 'proxy'", t.tier, startOfDay())!.n;
    if (n >= tl && once(`proxy.alert.tier:${t.tier}:${day}`)) say.push(`今天 ${t.tier} 档已调用 ${n} 次，过了告警线 ${tl}。照常跑，没拦。`);
  }
  for (const s of say) { log("proxy", "alert line reached", { run: t.run_id }); await notify.admin(s); }
}

// ───────── the server ─────────

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
  req.on("data", (c: Buffer) => parts.push(c)).on("end", () => ok(Buffer.concat(parts))).on("error", bad);
});

/** A usage limit can come as an HTTP error or as the first event of a 200 stream: read just enough to tell. */
async function peekLimit(up: Response): Promise<{ limited: boolean; chunks: AsyncIterable<Uint8Array> | null; drop: () => void }> {
  const sse = (up.headers.get("content-type") ?? "").includes("event-stream");
  if (!up.body || (up.ok && !sse)) return { limited: false, chunks: up.body as unknown as AsyncIterable<Uint8Array> | null, drop: () => {} };
  const reader = up.body.getReader(), head: Uint8Array[] = [], dec = new TextDecoder();
  let text = "", ended = false;
  while (text.length < 64_000 && (!up.ok || !/data:[^\n]*\n\r?\n/.test(text))) {
    let r;
    try { r = await reader.read(); } catch { break; }
    if (r.done) { ended = true; break; }
    head.push(r.value);
    text += dec.decode(r.value, { stream: true });
  }
  const limited = (!up.ok || /"type"\s*:\s*"error"/.test(text)) && classifyUpstream(text)?.kind === "limit";
  return {
    limited, drop: () => { void reader.cancel().catch(() => {}); },
    chunks: (async function* () {
      yield* head;
      while (!ended) { const { value, done } = await reader.read(); if (done) return; yield value; }
    })(),
  };
}

type TokenRow = { hash: string; run_id: string; tier: string; requester_id: string; budget_output: number; spent_output: number; status: string };

export function proxyHandler(db: Db, blobs: string) {
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? "/";
    if (!url.startsWith("/llm/")) return deny(res, 404, "not_found_error", "not found");
    const token = tokenOf(req);
    const t = token ? db.one<TokenRow>("SELECT * FROM run_tokens WHERE hash = ?", sha(token)) : undefined;
    if (!t || t.status !== "active") return deny(res, 401, "authentication_error", "bad or revoked run token");

    const raw = await readBody(req);
    let body: Buffer | undefined = req.method === "GET" || req.method === "HEAD" ? undefined : raw;
    let tier = t.tier as Tier, j: Record<string, unknown> & { messages?: Msg[] } | undefined;
    const run = db.one<{ role: string | null; lane: string | null; device_id: string | null }>("SELECT role, lane, device_id FROM runs WHERE id = ?", t.run_id);
    if (raw.length && req.method === "POST") {
      try { j = JSON.parse(raw.toString("utf8")); } catch { return deny(res, 400, "invalid_request_error", "body is not JSON"); }
      const asked = typeof j!.model === "string" ? j!.model : "";
      const m = /^sbot-(chat|work|light|expert)$/.exec(asked);
      if (m) {
        if (m[1] !== t.tier && m[1] !== "light") return deny(res, 403, "permission_error", `run token is for tier ${t.tier}, not ${m[1]}`);
        tier = m[1] as Tier;
      } else {
        log("proxy", "unmapped model name, using light", { run: t.run_id });
        tier = "light";
      }
      let tc: TierConf;
      try { tc = tierConf(tier); } catch { return deny(res, 500, "api_error", `tier ${tier} not configured`); }
      j!.model = tc.model;
      const prev = run?.lane ? db.one<{ model: string | null }>("SELECT model FROM sessions WHERE key = ?", run.lane)?.model ?? undefined : undefined;
      shapeForModel(j!, tc.model, prev);
      body = Buffer.from(JSON.stringify(j));
    }
    let tc: TierConf;
    try { tc = tierConf(tier); } catch { return deny(res, 500, "api_error", `tier ${tier} not configured`); }
    const cfg = modelsConf();
    const target = (name: string) => {
      const ep = cfg.endpoints?.[name];
      const key = ep && secret(ep.key_ref);
      // base_url may be "secret:NAME" when the endpoint itself shouldn't sit in the agent-readable config repo
      const base = ep && (ep.base_url.startsWith("secret:") ? secret(ep.base_url.slice(7)) : ep.base_url);
      if (!ep || !key || !base) return undefined;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v !== "string" || ["host", "authorization", "x-api-key", "content-length", "connection"].includes(k)) continue;
        headers[k] = v;
      }
      if (ep.auth === "x-api-key") headers["x-api-key"] = key; else headers["authorization"] = `Bearer ${key}`;
      return { url: base.replace(/\/$/, "") + url.slice("/llm".length), headers };
    };
    const primary = target(tc.endpoint);
    if (!primary) return deny(res, 500, "api_error", `endpoint for tier ${tier} not configured`);
    const send = (to: NonNullable<ReturnType<typeof target>>, b: Buffer | undefined) => fetch(to.url, { method: req.method, headers: to.headers, body: b });
    const book = (status: number, endpoint: string, model: string, u: Usage, cost: number, ms: number) =>
      Number(db.run(`INSERT INTO usage(ts, source, device_id, run_id, tier, endpoint, model, requester_id, input_tokens, output_tokens, cache_read, cache_write, cost, status, ms)
                     VALUES (?, 'proxy', ?,?,?,?,?,?,?,?,?,?,?,?,?)`, Date.now(), run?.device_id ?? null, t.run_id, tier, endpoint, model, t.requester_id,
        u.input, u.output, u.cache_read, u.cache_write, cost, status, ms).lastInsertRowid);

    let t0 = Date.now();
    let up: Response;
    try { up = await send(primary, body); } catch (e) {
      log("proxy", "upstream unreachable", { run: t.run_id, err: String((e as Error)?.message ?? e).slice(0, 200) });
      return deny(res, 502, "api_error", "upstream unreachable");
    }
    let used = { endpoint: tc.endpoint, model: tc.model, price: tc.price };
    let chunks = up.body as unknown as AsyncIterable<Uint8Array> | null;
    const fb = tc.fallback as { model?: string; endpoint?: string; price?: TierConf["price"] } | undefined;
    if (fb?.model && j) {
      const seen = await peekLimit(up);
      chunks = seen.chunks;
      if (seen.limited) {
        const endpoint = fb.endpoint ?? tc.endpoint, to = target(endpoint), b2 = Buffer.from(JSON.stringify({ ...j, model: fb.model }));
        let alt: Response | undefined;
        try {
          alt = to ? await send(to, b2) : undefined;
          if (alt && !alt.ok) { log("proxy", "fallback refused too", { tier, status: alt.status }); await alt.body?.cancel(); alt = undefined; }
        } catch (e) { alt = undefined; log("proxy", "fallback unreachable", { tier, err: String((e as Error)?.message ?? e).slice(0, 200) }); }
        if (alt) {
          book(up.ok ? 429 : up.status, tc.endpoint, tc.model, { input: 0, output: 0, cache_read: 0, cache_write: 0 }, 0, Date.now() - t0);
          log("proxy", "usage limit, using the tier's fallback", { tier, run: t.run_id });
          seen.drop();
          t0 = Date.now(); up = alt; chunks = alt.body as unknown as AsyncIterable<Uint8Array>; body = b2;
          used = { endpoint, model: fb.model, price: fb.price ?? tc.price };
        }
      }
    }
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) out[k] = v; });
    res.writeHead(up.status, out);
    const m = meter(), sse = (up.headers.get("content-type") ?? "").includes("event-stream"), dec = new TextDecoder();
    let text = "";
    try {
      if (chunks) for await (const c of chunks) {
        res.write(c);
        const s = dec.decode(c, { stream: true });
        if (sse) m.feed(s); else text += s;
      }
    } finally {
      res.end();
      if (!sse) m.json(text);
      const cost = costOf(used.price, m.u);
      const keep = !!body?.length && (t.requester_id === "draft" || CAPTURE_ROLES.has(run?.role ?? ""));
      const gz = keep ? gzipSync(body!) : undefined;
      const ref = gz ? putBlob(blobs, gz) : undefined;
      const spent = db.tx(() => {
        const uid = book(up.status, used.endpoint, used.model, m.u, cost, Date.now() - t0);
        db.run("UPDATE run_tokens SET spent_output = spent_output + ? WHERE hash = ?", m.u.output, t.hash);
        if (ref) db.run("INSERT INTO requests(ts, run_id, usage_id, tier, model, bytes, body_ref) VALUES (?,?,?,?,?,?,?)", t0, t.run_id, uid, tier, used.model, gz!.length, ref);
        // the lane's last model, so the next request knows whether the model changed (thinking blocks)
        if (up.ok && run?.lane) db.run("UPDATE sessions SET model = ? WHERE key = ?", used.model, run.lane);
        return t.spent_output + m.u.output;
      });
      await checkLines(db, t, spent);
    }
  };
}

export const proxyPort = () => Number(process.env.SBOT_PROXY_PORT ?? process.env.SBOT_PORT ?? 7811);

export function startProxy(db: Db, blobs: string, port = proxyPort()): Promise<http.Server> {
  const handle = proxyHandler(db, blobs);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log("proxy", "handler error", { err: String((e as Error)?.message ?? e).slice(0, 200) });
      if (!res.headersSent) deny(res, 500, "api_error", "proxy error"); else res.end();
    });
  });
  return new Promise((ok, bad) => {
    server.once("error", bad);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", bad);
      let tiers: string[] = [];
      try { tiers = TIERS.filter((x) => modelsConf().tiers[x]); } catch { /* models.yaml not filled in yet */ }
      log("proxy", "listening", { port: (server.address() as { port: number }).port, tiers });
      ok(server);
    });
  });
}
