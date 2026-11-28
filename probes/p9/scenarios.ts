// The three 08/P9 measurements, written against the Backend contract so both backends run the same code.
// Reports hold counts and times only (no ids, no message text).
import { ApiError, Deduper, clickCard, sleep, streamCard, summarize } from "./core.ts";
import type { Backend, Incoming, Say } from "./core.ts";
import type { CutProxy, CutMode } from "./proxy.ts";

export type Report = Record<string, unknown>;
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
const codeOf = (e: unknown) => (e instanceof ApiError ? String(e.apiCode ?? e.status ?? "err") : "err");
const THROTTLE = (e: unknown) => e instanceof ApiError && (e.status === 429 || e.apiCode === 99991400);

export async function sendCard(b: Backend, chatId: string, card: unknown): Promise<string> {
  const d = await b.api("POST", "/open-apis/im/v1/messages", { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }, { receive_id_type: "chat_id" });
  if (!d.message_id) throw new Error("card send: no message_id");
  return d.message_id;
}

/** Refuse to start while another long connection is online for this app: it would split the events (09 「测试 home 里的飞书」). */
export async function assertNoOtherConnection(b: Backend, say: Say, allowUnknown = false, shared = false): Promise<number | undefined> {
  let cnt: number | undefined;
  try { cnt = (await b.api("GET", "/open-apis/event/v1/connection")).online_instance_cnt; } catch (e: any) { say(`connection check failed: ${e.message}`); }
  if (shared) { say(`shared live app: ${cnt ?? "unknown"} other long connection(s) online; events split with them`); return cnt; }
  if (typeof cnt === "number" && cnt > 0) throw new Error(`the app already has ${cnt} long connection(s) online; stop them or use a dedicated test app`);
  if (typeof cnt !== "number") {
    if (!allowUnknown) throw new Error("could not read the number of online long connections; set P9_ALLOW_UNKNOWN_CONNECTIONS=1 if you are sure this app is only used by the harness");
    say("connection count unknown, continuing because P9_ALLOW_UNKNOWN_CONNECTIONS=1");
  }
  return cnt;
}

/** what every report that held a long connection adds: server config, data frame types, the connection window */
export function wire(b: Backend, from: number) {
  return { server_config: b.serverConfig?.() ?? "n/a", data_frame_types: b.frameTypes?.() ?? "n/a",
    connection_window: { from: new Date(from).toISOString(), to: new Date().toISOString() } };
}

// ---- 4. what the server sends: ClientConfig, frame types ----------------------------------------------------------

export async function runConfig(b: Backend, o: { waitMs: number; say: Say }): Promise<Report> {
  const from = Date.now();
  const kinds: Record<string, number> = {};
  await b.start((e) => { bump(kinds, e.kind); if (e.kind === "card") return { toast: { type: "info", content: "p9 config" } }; });
  o.say(`connected; holding ${Math.round(o.waitMs / 1000)} s for at least one ping/pong`);
  await sleep(o.waitMs);
  return { scenario: "config", backend: b.name, events_by_kind: kinds, ...wire(b, from), timeline: b.timeline().map((x) => `${Math.round((x.at - from) / 100) / 10}s ${x.ev}`),
    pass: { got_endpoint_config: !!(b.serverConfig?.() as any)?.endpoint }, notes: b.notes() };
}

// ---- 1. 50 card clicks ----------------------------------------------------------------------------------------------

export async function runClicks(b: Backend, o: { chatId: string; target: number; timeoutMs: number; dedupe: Deduper; say: Say }): Promise<Report> {
  const { target, say, dedupe } = o;
  const msgId = await sendCard(b, o.chatId, clickCard(0, target));
  const from = Date.now();
  let n = 0, withOp = 0, noOp = 0, others = 0, finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });
  const handlerMs: number[] = [], deliverMs: number[] = [], updMs: number[] = [];
  const upd = { ok: 0, fail: 0, codes: {} as Record<string, number> };
  let chain: Promise<void> = Promise.resolve();

  await b.start(async (e: Incoming) => {
    const t0 = Date.now();
    if (e.kind !== "card" || e.value?.k !== "p9" || e.messageId !== msgId) { others++; return; }
    if (dedupe.seen(e.eventId)) return;
    const mine = ++n;
    e.operatorId ? withOp++ : noOp++;
    if (e.eventTs) deliverMs.push(e.recvAt - e.eventTs);
    // the update runs after this handler has returned (and so after the ack on the SDK path): serial, one PATCH per click
    chain = chain.then(async () => {
      const t = Date.now();
      try { await b.api("PATCH", `/open-apis/im/v1/messages/${msgId}`, { content: JSON.stringify(clickCard(mine, target)) }); upd.ok++; }
      catch (err) { upd.fail++; bump(upd.codes, codeOf(err)); }
      updMs.push(Date.now() - t);
    });
    handlerMs.push(Date.now() - t0);
    if (mine >= target) finish();
    return { toast: { type: "success", content: `${mine}/${target}` } };
  });
  say(`card sent to the test chat: click the button ${target} times (waiting up to ${Math.round(o.timeoutMs / 1000)} s)`);
  await Promise.race([done, sleep(o.timeoutMs)]);
  await chain;

  let readback: boolean | "unavailable" = "unavailable";
  try {
    const d = await b.api("GET", `/open-apis/im/v1/messages/${msgId}`, undefined, { card_msg_content_type: "raw_card_content" });
    readback = JSON.stringify(d).includes(`${n}/${target}`);
  } catch {}

  const ackSdk = b.ackMs();
  const under3 = handlerMs.filter((x) => x < 3000).length;
  return {
    scenario: "clicks", backend: b.name, ack_semantics: b.ackSemantics, target,
    clicks_unique: n, duplicate_event_ids: dedupe.dupes, with_operator_id: withOp, without_operator_id: noOp,
    handler_ms: summarize(handlerMs), sdk_ack_ms: ackSdk.length ? summarize(ackSdk) : "n/a (ack precedes delivery)",
    handled_under_3s: `${under3}/${n}`, event_to_handler_ms: summarize(deliverMs),
    card_updates: { ok: upd.ok, failed: upd.fail, codes: upd.codes, ms: summarize(updMs) }, card_readback_shows_final_count: readback,
    other_events: others, ...wire(b, from),
    pass: { clicks: n >= target, ack_3s: under3 === n && n >= target, operator_id: withOp === n && n >= target, updates: upd.ok === n && upd.fail === 0 && n >= target && readback !== false },
    notes: b.notes(),
  };
}

// ---- 2. network cut --------------------------------------------------------------------------------------------------

type Seen = { kind: string; eventId: string; messageId?: string; eventTs?: number; recvAt: number };

async function listUserMessages(b: Backend, chatId: string, fromMs: number, toMs: number): Promise<{ id: string; at: number }[]> {
  const out: { id: string; at: number }[] = [];
  let token: string | undefined;
  do {
    const params: Record<string, string> = { container_id_type: "chat", container_id: chatId, start_time: String(Math.floor(fromMs / 1000)),
      end_time: String(Math.ceil(toMs / 1000)), sort_type: "ByCreateTimeAsc", page_size: "50" };
    if (token) params.page_token = token;
    const d = await b.api("GET", "/open-apis/im/v1/messages", undefined, params);
    for (const it of d.items ?? []) if (it.sender?.sender_type === "user" && it.message_id) out.push({ id: it.message_id, at: Number(it.create_time) });
    token = d.has_more ? d.page_token : undefined;
  } while (token);
  return out;
}

export async function runNetcut(b: Backend, proxy: CutProxy, o: { chatId: string; baselineMs: number; cutMs: number; mode: CutMode; settleMs: number; dedupe: Deduper; say: Say }): Promise<Report> {
  const { say } = o;
  const seen: Seen[] = [];
  const msgEvents = new Map<string, Set<string>>();   // message_id → distinct event_ids it arrived with
  let dupEventIds = 0;
  const startedAt = Date.now();
  const cardId = await sendCard(b, o.chatId, clickCard(0, 9999));
  await b.start(async (e) => {
    if (o.dedupe.seen(e.eventId)) { dupEventIds++; return; }   // a repeat of an event we already handled
    seen.push({ kind: e.kind, eventId: e.eventId, messageId: e.messageId, eventTs: e.eventTs, recvAt: e.recvAt });
    if (e.kind === "message" && e.messageId) { const s = msgEvents.get(e.messageId) ?? new Set(); s.add(e.eventId); msgEvents.set(e.messageId, s); }
    if (e.kind === "card") return { toast: { type: "info", content: "ok" } };
  });
  say(`baseline ${Math.round(o.baselineMs / 1000)} s: send a message and click the card once so we know the path works`);
  await sleep(o.baselineMs);
  const cutAt = Date.now();
  proxy.cut(o.mode);
  say(`NETWORK CUT (${o.mode}) for ${Math.round(o.cutMs / 1000)} s: now send several messages in the test chat and click the card several times; write down how many`);
  await sleep(o.cutMs);
  const restoreAt = Date.now();
  proxy.restore();
  say(`network restored; collecting for ${Math.round(o.settleMs / 1000)} s (Feishu retries events at 15 s, 5 min, 1 h, 6 h)`);
  await sleep(o.settleMs);
  const endAt = Date.now();

  let history: { id: string; at: number }[] | "unavailable" = "unavailable";
  try { history = await listUserMessages(b, o.chatId, startedAt - 5000, endAt); } catch (e: any) { say(`chat history unavailable: ${e.message}`); }

  const phase = (t: number) => (t < cutAt ? "before" : t <= restoreAt ? "during" : "after");
  const gotMsg = new Set(seen.filter((s) => s.kind === "message" && s.messageId).map((s) => s.messageId!));
  const byPhase: Record<string, { sent: number; received: number; missing: number }> = {};
  if (history !== "unavailable") {
    for (const m of history) {
      const p = byPhase[phase(m.at)] ??= { sent: 0, received: 0, missing: 0 };
      p.sent++; gotMsg.has(m.id) ? p.received++ : p.missing++;
    }
  }
  const clicksDuring = seen.filter((s) => s.kind === "card" && s.eventTs && phase(s.eventTs) === "during");
  const messagesDuring = seen.filter((s) => s.kind === "message" && s.eventTs && phase(s.eventTs) === "during");
  const rel = (t: number) => Math.round((t - cutAt) / 100) / 10;
  const tl = b.timeline().filter((x) => x.at >= cutAt - 1000).map((x) => `${rel(x.at)}s ${x.ev}`);
  const after = b.timeline().filter((x) => x.at > restoreAt && /ready|reconnected|restart/.test(x.ev));
  const dupMsg = [...msgEvents.values()].filter((s) => s.size > 1).length;
  void cardId;
  return {
    scenario: "netcut", backend: b.name, mode: o.mode, cut_s: Math.round(o.cutMs / 1000), settle_s: Math.round(o.settleMs / 1000),
    reconnect_after_restore_s: after.length ? rel(after[0]!.at) - rel(restoreAt) : null, timeline_s_from_cut: tl,
    proxy: { tunnels_opened: proxy.tunnels, connects_refused_during_cut: proxy.refused },
    messages_by_phase: byPhase,
    delivered_late: { messages_created_during_cut: messagesDuring.length, clicks_created_during_cut: clicksDuring.length },
    duplicate_event_ids_dropped: dupEventIds, message_ids_delivered_under_two_event_ids: dupMsg, ...wire(b, startedAt),
    note_clicks: "compare clicks_created_during_cut with the number you clicked; callbacks are not redelivered by Feishu (docs), so a shortfall is expected on both backends",
    pass: {
      through_proxy: proxy.tunnels > 0,   // false = the backend ignored the proxy, so nothing was cut and the run proves nothing
      reconnected: after.length > 0,
      no_message_lost: history === "unavailable" ? "unknown" : Object.values(byPhase).every((p) => p.missing === 0),
      no_duplicate_after_dedupe: dupMsg === 0,
    },
    notes: b.notes(),
  };
}

// ---- 3. CardKit streaming --------------------------------------------------------------------------------------------

export async function runStream(b: Backend, o: { chatId: string; durationMs: number; perSec: number; cards?: number; pipeline?: boolean; say: Say }): Promise<Report> {
  const { say } = o;
  const cards = Math.max(1, o.cards ?? 1);
  const total = Math.round((o.durationMs / 1000) * o.perSec), gap = 1000 / o.perSec;
  const ids: string[] = [];
  for (let c = 0; c < cards; c++) {
    const created = await b.api("POST", "/open-apis/cardkit/v1/cards", { type: "card_json", data: JSON.stringify(streamCard(cards > 1 ? `card ${c + 1}/${cards}` : "start", true)) });
    if (!created.card_id) throw new Error("no card_id");
    ids.push(created.card_id);
    await b.api("POST", "/open-apis/im/v1/messages", { receive_id: o.chatId, msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: created.card_id } }) }, { receive_id_type: "chat_id" });
  }
  say(`streaming ${total} updates per card at ${o.perSec}/s for ${Math.round(o.durationMs / 1000)} s on ${cards} card(s) (${Math.round(cards * o.perSec * 60)}/min together)`);
  let ok = 0, failed = 0, throttled = 0, late = 0;
  let firstThrottleS: number | null = null;
  const codes: Record<string, number> = {}, lat: number[] = [];
  const perCard: { ok: number; throttled: number }[] = ids.map(() => ({ ok: 0, throttled: 0 }));
  const t0 = Date.now();
  // one sequential loop per card (sequence must strictly increase per card); the cards run side by side
  const closed = await Promise.all(ids.map(async (cardId, c) => {
    let seq = 0, text = "";
    const inflight: Promise<void>[] = [];
    for (let i = 0; i < total; i++) {
      const wait = t0 + i * gap + (c * gap) / cards - Date.now();
      if (wait > 0) await sleep(wait); else if (wait < -gap) late++;
      text += `line ${i + 1} ${"·".repeat(20)}\n`;
      const t = Date.now(), body = { content: text, sequence: ++seq };
      // --pipeline: fire on schedule without waiting for the previous answer (the link is ~250 ms RTT from SG); sequence
      // still increases per card, but requests may land out of order — the error codes show whether Feishu minds
      const call = b.api("PUT", `/open-apis/cardkit/v1/cards/${cardId}/elements/md/content`, body).then(() => { ok++; perCard[c]!.ok++; }, (e) => {
        failed++; bump(codes, codeOf(e));
        if (THROTTLE(e)) { throttled++; perCard[c]!.throttled++; firstThrottleS ??= Math.round((Date.now() - t0) / 100) / 10; }
      }).finally(() => { lat.push(Date.now() - t); });
      if (o.pipeline) inflight.push(call); else await call;
    }
    await Promise.all(inflight);
    try { await b.api("PATCH", `/open-apis/cardkit/v1/cards/${cardId}/settings`, { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: ++seq }); return true; } catch { return false; }
  }));
  const elapsed = Date.now() - t0;
  const planned = total * cards;
  return {
    scenario: "stream", backend: b.name, cards, pipeline: !!o.pipeline, planned, ok, failed, throttled, first_throttle_s: firstThrottleS, error_codes: codes, late_ticks: late,
    elapsed_s: Math.round(elapsed / 100) / 10, achieved_per_s: Math.round((ok / (elapsed / 1000)) * 100) / 100,
    achieved_per_min_all_cards: Math.round((ok / (elapsed / 60000))), call_ms: summarize(lat), streaming_closed: closed.every(Boolean),
    per_card: cards > 1 ? perCard : undefined,
    pass: { all_ok: ok === planned, not_throttled: throttled === 0, kept_pace: elapsed <= o.durationMs * 1.1 },
    notes: b.notes(),
  };
}
