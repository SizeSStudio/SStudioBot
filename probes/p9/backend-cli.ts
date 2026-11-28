// Backend B: lark-cli as a subprocess. Events: one `event consume <key>` process per key (NDJSON on stdout, restarted
// with backoff like core/src/feishu.ts). REST: one `lark-cli api` process per call.
// Everything runs in a throw-away HOME and config dir. The credentials go in once, `config init --app-secret-stdin`, into
// that config dir: lark-cli 1.0.98 answers REST with token_missing on the env provider (LARKSUITE_CLI_APP_ID/SECRET) and,
// with those set, refuses `config` (found in the live run). Never in the env, on a command line or printed. The CLI acks Feishu before it hands us the line, so the handler's return
// value goes nowhere: card updates must use the REST path after the click.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ApiError, describeError, makeRedactor, routeOf, sleep } from "./core.ts";
import type { Backend, Creds, Handler, Incoming, Say } from "./core.ts";

export type CliOpts = { creds: Creds; say: Say; bin: string; proxyUrl?: string; env?: Record<string, string>; readyTimeoutMs?: number };
const KEYS = ["card.action.trigger", "im.message.receive_v1"] as const;

export class CliBackend implements Backend {
  readonly name = "cli" as const;
  readonly ackSemantics = "before-delivery" as const;
  private o: CliOpts;
  private dir: string;
  private env: Record<string, string>;
  private redact: (s: string) => string;
  private children = new Map<string, ReturnType<typeof spawn>>();
  private closing = false;
  private tl: { at: number; ev: string }[] = [];
  private callMs: number[] = [];
  private spawned = 0;
  private handler: Handler = () => {};
  private inited?: Promise<void>;

  constructor(o: CliOpts) {
    this.o = o;
    this.dir = mkdtempSync(join(tmpdir(), "p9-cli-"));
    mkdirSync(join(this.dir, "cfg")); mkdirSync(join(this.dir, "data"));
    const { creds } = o;
    this.redact = makeRedactor([creds.app_secret, creds.app_id]);
    this.env = {
      PATH: process.env.PATH ?? "", HOME: this.dir,
      LARKSUITE_CLI_CONFIG_DIR: join(this.dir, "cfg"), LARKSUITE_CLI_DATA_DIR: join(this.dir, "data"),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      ...(creds.domain!.includes("larksuite") ? { LARKSUITE_CLI_BRAND: "lark" } : {}),
      ...(o.proxyUrl ? { HTTPS_PROXY: o.proxyUrl, HTTP_PROXY: o.proxyUrl } : {}),
      ...(o.env ?? {}),
    };
  }

  private mark(ev: string) { this.tl.push({ at: Date.now(), ev }); }

  // the app secret goes in on stdin, into our own config dir; once per backend
  private init(): Promise<void> {
    return this.inited ??= new Promise((resolve, reject) => {
      this.spawned++;
      const c = execFile(this.o.bin, ["config", "init", "--app-id", this.o.creds.app_id, "--app-secret-stdin",
        ...(this.o.creds.domain!.includes("larksuite") ? ["--brand", "lark"] : [])], { env: this.env, timeout: 30_000 },
        (err) => err ? reject(new Error(`lark-cli config init: ${this.redact(describeError(err))}`)) : resolve());
      c.stdin!.end(this.o.creds.app_secret + "\n");
    });
  }

  async start(h: Handler): Promise<void> {
    this.handler = h;
    await this.init();
    const ready = KEYS.map((k) => this.consume(k));
    const to = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("lark-cli event consume not ready in time")), this.o.readyTimeoutMs ?? 30_000).unref());
    await Promise.race([Promise.all(ready), to]);
  }

  private consume(key: string, backoff = 1000): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = spawn(this.o.bin, ["event", "consume", key, "--as", "bot"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      this.spawned++;
      this.children.set(key, child);
      let healthy = false;
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (!line.trim()) return;
        healthy = true;
        const recvAt = Date.now();
        let j: any;
        try { j = JSON.parse(line); } catch { this.o.say(`[cli] unparseable event line (${line.length} chars)`); return; }
        const e = this.toIncoming(key, j, recvAt);
        if (e) Promise.resolve(this.handler(e)).catch((err) => this.o.say(`[cli] handler failed: ${describeError(err)}`));
      });
      createInterface({ input: child.stderr! }).on("line", (line) => {
        if (/\[event\] ready/.test(line)) { this.mark(`ready:${key}`); resolve(); }
        else if (/error|fail|drop|reconnect|online_instance_cnt/i.test(line)) this.o.say(`[cli ${key}] ${this.redact(line).slice(0, 200)}`);
      });
      child.on("error", (err) => { this.o.say(`[cli] spawn failed: ${describeError(err)}`); resolve(); });
      child.on("exit", (code, sig) => {
        this.mark(`exit:${key}`);
        if (this.closing) return;
        const wait = healthy ? 1000 : backoff;
        this.o.say(`[cli ${key}] exited (code=${code} sig=${sig}), restart in ${wait} ms`);
        setTimeout(() => { if (!this.closing) { this.mark(`restart:${key}`); void this.consume(key, Math.min(wait * 2, 60_000)); } }, wait);
      });
    });
  }

  private toIncoming(key: string, j: any, recvAt: number): Incoming | null {
    const eventTs = Number(j.timestamp ?? j.create_time) || undefined;
    if (key === "card.action.trigger") {
      let value: any = j.action_value;
      if (typeof value === "string") { try { value = JSON.parse(value); } catch {} }
      return { kind: "card", eventId: String(j.event_id ?? ""), operatorId: j.operator_id || undefined, messageId: j.message_id, chatId: j.chat_id, value, token: j.token, eventTs, recvAt };
    }
    return { kind: "message", eventId: String(j.event_id ?? ""), operatorId: j.sender_id || undefined, messageId: j.message_id ?? j.id, chatId: j.chat_id, eventTs, recvAt };
  }

  async api(method: string, path: string, data?: unknown, params?: Record<string, string>): Promise<any> {
    await this.init();
    const route = `${method} ${routeOf(path)}`;
    const args = ["api", method, path, "--as", "bot", "--format", "json"];
    if (params) args.push("--params", JSON.stringify(params));
    if (data !== undefined) args.push("--data", "-");
    const t0 = Date.now();
    this.spawned++;
    return new Promise((resolve, reject) => {
      const c = execFile(this.o.bin, args, { env: this.env, maxBuffer: 16 << 20, timeout: 60_000 }, (err, stdout, stderr) => {
        this.callMs.push(Date.now() - t0);
        const text = (stdout || stderr || "").trim();
        let j: any; try { j = JSON.parse(text); } catch {}
        if (!err && j?.ok !== false) return resolve(j?.data ?? j ?? {});
        const eobj = j?.error;
        reject(new ApiError(`${route}: ${eobj ? `${eobj.type ?? "error"}${eobj.subtype ? "/" + eobj.subtype : ""}` : describeError(err)}`, undefined, eobj?.code));
      });
      if (data !== undefined) c.stdin!.end(JSON.stringify(data)); else c.stdin!.end();
    });
  }

  ackMs() { return []; }
  state() { return [...this.children.values()].every((c) => c.exitCode === null && c.signalCode === null) ? "connected" : "degraded"; }
  timeline() { return this.tl; }
  notes() {
    const s = [...this.callMs].sort((a, b) => a - b);
    return [
      `${this.spawned} lark-cli processes spawned (${KEYS.length} long-lived consumers + one per REST call)`,
      s.length ? `REST call wall time: median ${s[Math.floor(s.length / 2)]} ms, max ${s[s.length - 1]} ms over ${s.length} calls` : "no REST calls yet",
      "acked before delivery: no callback response body is possible; events are dropped (after the ack) when the local bus has no consumer or its 100-slot buffer is full",
    ];
  }

  async close() {
    this.closing = true;
    for (const c of this.children.values()) { try { c.stdin?.end(); c.kill("SIGTERM"); } catch {} }
    // the bus daemon is detached and lingers ~30 s after its last consumer; the config dir is ours alone, so --all is safe
    await new Promise<void>((r) => execFile(this.o.bin, ["event", "stop", "--all", "--force"], { env: this.env, timeout: 15_000 }, () => r()));
    await sleep(200);
    rmSync(this.dir, { recursive: true, force: true });
  }
}
