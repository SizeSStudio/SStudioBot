// Android push registration (gated on hub fcm_enabled, inert without google-services.json, four channels, personal
// text privacy, tap route) and Presence throttling/coalescing/background/reconnect. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PresenceReq } from "../../../protocol/api/push.ts";
import { CHANNELS, presentation, PRIVATE_TEXT, PushRegistrar, tapRoute, type PushPref, type TokenSource } from "../src/push/push.ts";
import { Presence, PRESENCE_EVERY_MS, VIEWING_EVERY_MS } from "../src/conn/presence.ts";

test("four Android notification channels match 07-clients", () => {
  assert.deepEqual(CHANNELS.map((c) => c.id), ["wait", "approval", "task", "fyi"]);
  assert.deepEqual(CHANNELS.map((c) => c.importance), ["high", "high", "default", "low"]);
});

test("presentation enforces 「有一条私人的」 on personal pushes and tapRoute opens /item/<ref> only", () => {
  const priv = presentation(
    { ref: "thread:th_priv1", cat: "reply", channel: "wait", personal: "1", push_id: "42" },
    "绝密标题不该出现",
    "绝密正文也不该出现",
  );
  assert.deepEqual(priv, { title: PRIVATE_TEXT, body: "", ref: "thread:th_priv1", channel: "wait" });

  const work = presentation(
    { ref: "approval:ap_7", cat: "approval", channel: "approval", personal: "0", push_id: "43" },
    "发邮件审批",
    "等我点一下",
  );
  assert.deepEqual(work, { title: "发邮件审批", body: "等我点一下", ref: "approval:ap_7", channel: "approval" });

  // Unparseable payload falls back safely without leaking untrusted text
  const bad = presentation({ ref: "not a ref", personal: "0" }, "恶标题", "恶正文");
  assert.equal(bad.ref, null);
  assert.equal(bad.channel, "fyi");
  assert.notEqual(bad.title, "恶标题");

  assert.equal(tapRoute({ ref: "approval:ap_7", cat: "approval", channel: "approval", personal: "0", push_id: "43" }), "/item/approval%3Aap_7");
  assert.equal(tapRoute({ ref: "thread:th_priv1", cat: "reply", channel: "wait", personal: "1", push_id: "42" }), "/item/thread%3Ath_priv1");
  assert.equal(tapRoute({ bad: true }), "/");
});

function fakePush(opts: { available?: boolean; granted?: boolean; tok?: string; pref?: boolean | null; hasToken?: boolean; fcmEnabled?: boolean } = {}) {
  let pref = opts.pref ?? null;
  let has = opts.hasToken ?? false;
  let permCalls = 0, tokCalls = 0;
  let listener: ((t: string) => void) | null = null;
  const sent: (string | null)[] = [];
  const source: TokenSource = {
    available: opts.available ?? true,
    permission: async () => { permCalls++; return opts.granted ?? true; },
    token: async () => { tokCalls++; return opts.tok ?? "fcm_tok_initial"; },
    onToken: (cb) => { listener = cb; return () => { listener = null; }; },
  };
  const pushPref: PushPref = { get: async () => pref, set: async (on) => { pref = on; } };
  const fcmEnabled = opts.fcmEnabled ?? true;
  const reg = new PushRegistrar({
    source, pref: pushPref,
    hasToken: () => has,
    send: async (token) => {
      sent.push(token);
      has = token !== null;
      return { ok: true, body: { has_token: has, fcm_enabled: fcmEnabled } };
    },
  });
  return { reg, sent, get permCalls() { return permCalls; }, get tokCalls() { return tokCalls; }, refresh: (t: string) => listener?.(t), hasListener: () => listener !== null };
}

test("PushRegistrar: inert when unavailable (no google-services.json)", async () => {
  const f = fakePush({ available: false });
  await f.reg.sync();
  assert.deepEqual(f.reg.state, { s: "unavailable" });
  assert.equal(f.sent.length, 0);
  assert.equal(f.permCalls, 0);
  assert.equal(f.tokCalls, 0);
});

test("PushRegistrar: probes hub fcm_enabled before asking permission or token", async () => {
  const f = fakePush({ fcmEnabled: false, hasToken: false });
  await f.reg.sync();
  assert.deepEqual(f.reg.state, { s: "hub_off" });
  assert.deepEqual(f.sent, [null]);
  assert.equal(f.permCalls, 0, "never prompts Android when hub has FCM disabled");
  assert.equal(f.tokCalls, 0);
});

test("PushRegistrar: registers when fcm_enabled, handles token refresh and user toggle off/on", async () => {
  const f = fakePush({ fcmEnabled: true, granted: true, tok: "fcm_tok_1" });
  await f.reg.sync();
  assert.deepEqual(f.reg.state, { s: "on" });
  assert.deepEqual(f.sent, [null, "fcm_tok_1"]);
  assert.equal(f.hasListener(), true);

  // Token rotates: sent automatically
  f.refresh("fcm_tok_2");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.sent, [null, "fcm_tok_1", "fcm_tok_2"]);

  // User turns phone notifications off: clears token on hub and stops watching
  await f.reg.setEnabled(false);
  assert.deepEqual(f.reg.state, { s: "off" });
  assert.equal(f.hasListener(), false);
  assert.deepEqual(f.sent, [null, "fcm_tok_1", "fcm_tok_2", null]);

  // Turning back on probes and registers again
  await f.reg.setEnabled(true);
  assert.deepEqual(f.reg.state, { s: "on" });
});

test("PushRegistrar: denied permission clears existing token and reports denied", async () => {
  const f = fakePush({ fcmEnabled: true, granted: false, hasToken: true });
  await f.reg.sync();
  assert.deepEqual(f.reg.state, { s: "denied" });
  assert.deepEqual(f.sent, [null]);
  assert.equal(f.tokCalls, 0);
});

test("Presence: 30s activity throttle, 2s viewing coalesce, immediate background, reconnect re-emit", () => {
  let now = 10_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextT = 1;
  const sent: PresenceReq[] = [];
  const p = new Presence({
    send: (req) => sent.push(req),
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextT++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };

  // Activity throttled to 30 s
  p.activity();
  assert.deepEqual(sent, [{ foreground: true, viewing: null }]);
  advance(10_000);
  p.activity();
  assert.equal(sent.length, 1);
  advance(PRESENCE_EVERY_MS - 10_000);
  p.activity();
  assert.equal(sent.length, 2);

  // Rapid screen changes coalesce within 2 s and send the last ref
  p.view("thread:th_1");
  assert.deepEqual(sent[2], { foreground: true, viewing: "thread:th_1" });
  advance(500);
  p.view("thread:th_2");
  p.view("approval:ap_9");
  assert.equal(sent.length, 3, "coalesced inside 2 s window");
  advance(VIEWING_EVERY_MS);
  assert.deepEqual(sent[3], { foreground: true, viewing: "approval:ap_9" });

  // Background sends immediately and suppresses activity/view; subscribe fires
  let fgChanges = 0;
  const unsub = p.subscribe(() => fgChanges++);
  p.foreground(false);
  assert.equal(fgChanges, 1);
  assert.deepEqual(sent[4], { foreground: false });
  advance(PRESENCE_EVERY_MS);
  p.activity();
  p.view("thread:th_3");
  assert.equal(sent.length, 5, "nothing sent while backgrounded");

  // Returning to foreground sends current viewing
  p.foreground(true);
  assert.equal(fgChanges, 2);
  assert.deepEqual(sent[5], { foreground: true, viewing: "thread:th_3" });
  unsub();

  // Reconnect re-emits immediately even inside throttle window
  p.reconnected();
  assert.deepEqual(sent[6], { foreground: true, viewing: "thread:th_3" });
});
