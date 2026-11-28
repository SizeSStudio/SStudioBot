// Acceptance (W1d): kill -9 the hub in the middle of a run and start it again. Nothing is lost and no reply goes out
// twice. A run that already did something is marked interrupted and I'm told how many messages went out; a run that
// did nothing runs again, once. Real hub processes, real pi, a fake upstream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { until, w1dHome } from "./w1d-helpers.ts";
import { fakeLlm, type Step } from "./fake-llm.ts";
import type { Home } from "../src/home.ts";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "kill-child.ts");

function start(h: Home, ingestId?: string): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = { ...process.env, SBOT_HOME: h.root, SBOT_SECRETS: h.secrets, KILL_INGEST: ingestId };
  const c = spawn(process.execPath, [CHILD], { env, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((ok, bad) => {
    c.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("up")) ok(c); });
    c.on("exit", (code) => bad(new Error(`child exited ${code}`)));
  });
}
const kill9 = (c: ChildProcess) => new Promise<void>((ok) => { c.once("exit", () => ok()); c.kill("SIGKILL"); });
const stop = (c: ChildProcess) => new Promise<void>((ok) => { c.once("exit", () => ok()); c.kill("SIGTERM"); });

/** read-only look at the child's db (WAL: readers never block the writer) */
function q<T>(h: Home, sql: string): T[] {
  const db = new DatabaseSync(h.db, { readOnly: true });
  try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
}
const texts = (h: Home) => q<{ payload: string; status: string; run_id: string | null }>(h, "SELECT payload, status, run_id FROM outbox WHERE kind = 'text' ORDER BY id");

test("killed after one message went out: interrupted, I'm told 1 went out, nothing is sent twice", async () => {
  let respond: (b: any, n: number) => Step = (_b, n) => (n === 0 ? { tool: { name: "reply", input: { text: "先说一句：在弄了" } } } : { hang: true });
  const llm = await fakeLlm((b, n) => respond(b, n));
  const h = await w1dHome("kill1", { port: llm.port });
  let c = await start(h, "k1-msg");
  try {
    await until(() => llm.seen.length === 2 && texts(h).some((t) => t.status === "sent"), 30_000, "reply out, second request hanging");
    await kill9(c);
    respond = () => ({ text: "整理完了" });
    c = await start(h);
    await until(() => texts(h).some((t) => t.payload.startsWith("我刚才被重启了") && t.status === "sent"), 20_000, "restart notice");
    await new Promise((r) => setTimeout(r, 2_000));   // room for a wrong rerun to show up
    const out = texts(h);
    assert.equal(out.filter((t) => t.payload === "先说一句：在弄了").length, 1, "the first reply exactly once");
    const notice = out.find((t) => t.payload.startsWith("我刚才被重启了"))!;
    assert.match(notice.payload, /已经发出 1 条消息，不会重发/);
    assert.equal(notice.run_id, null);
    assert.ok(!out.some((t) => t.payload === "整理完了"), "not run again");
    assert.equal(llm.seen.length, 2, "no new model request after the restart");
    assert.deepEqual(q<{ status: string }>(h, "SELECT status FROM inbox").map((r) => r.status), ["interrupted"]);
    assert.deepEqual(q<{ status: string }>(h, "SELECT status FROM runs").map((r) => r.status), ["interrupted"]);
    assert.equal(q<{ n: number }>(h, "SELECT COUNT(*) AS n FROM messages WHERE text = '先说一句：在弄了'")[0]!.n, 1);
    assert.equal(q<{ n: number }>(h, "SELECT COUNT(*) AS n FROM run_tokens WHERE status = 'active'")[0]!.n, 0);
  } finally { await stop(c).catch(() => {}); await llm.close(); }
});

test("killed before anything went out: it runs again, once, and the reply is sent once", async () => {
  let respond: (b: any, n: number) => Step = () => ({ hang: true });
  const llm = await fakeLlm((b, n) => respond(b, n));
  const h = await w1dHome("kill2", { port: llm.port });
  let c = await start(h, "k2-msg");
  try {
    await until(() => llm.seen.length === 1, 30_000, "first request hanging");
    await kill9(c);
    respond = () => ({ text: "整理完了" });
    c = await start(h);
    await until(() => texts(h).some((t) => t.payload === "整理完了" && t.status === "sent"), 30_000, "rerun reply");
    await new Promise((r) => setTimeout(r, 1_500));
    const out = texts(h);
    assert.deepEqual(out.map((t) => t.payload), ["整理完了"], "one reply, no notice");
    assert.deepEqual(q<{ status: string; tries: number }>(h, "SELECT status, tries FROM inbox").map((r) => [r.status, r.tries]), [["done", 2]]);
    assert.deepEqual(q<{ status: string }>(h, "SELECT status FROM runs ORDER BY started").map((r) => r.status), ["interrupted", "done"]);
    assert.equal(llm.seen.length, 2);
    // the rerun starts from the same input
    assert.match(JSON.stringify(llm.seen[1]!.body.messages), /帮我整理一下/);
  } finally { await stop(c).catch(() => {}); await llm.close(); }
});
