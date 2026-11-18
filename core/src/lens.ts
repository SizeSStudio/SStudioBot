// Lenses and the 解读账本 (DESIGN §4.5, §15.7). A lens is a view, to be felt against life: no scoring, no hit rate.
//
// A reading is requested (by the main agent in the owner's conversation, or by the day / week / month jobs), queued here and run as
// a restricted worker: Claude Agent SDK on the pinned CLI as sbot-w, sandboxed, egress proxy with an EMPTY allowlist
// (the run holds birth data, so it has no way out), skills only from the read-only plugin /opt/sbot/plugins/sbot-lens
// with an explicit allowlist per lens. Input is a task dir with only what this lens needs: a slice of config/self.yaml,
// the frozen chart files for this profile_version, and self/lens-notes/<lens>.md. Output comes back through
// submit_reading in one format the core understands for every lens; it is stored before the fact and never edited.
// Revisits are appended (reading_revisit) from the owner's own words, in reviews or whenever he brings it up.
//
//   queued ─► running ─┬─ submit_reading ─► done ─► event into the origin lane (unless the month job asked: silent)
//                      └─ error / timeout ─► failed ─► short notice into the origin lane

import { query, tool, createSdkMcpServer, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { stringify } from "yaml";
import { all, one, run, signal } from "./db.ts";
import { P, PROXY_BASE, log, ownerName, selfLensConf, tierConf } from "./config.ts";
import { birthReady, chartInput } from "./birth.ts";
import { isoWeek, monthOf, periodOk, today } from "./life.ts";
import { issueToken, revokeToken } from "./proxy.ts";
import { openEgress } from "./egress.ts";
import { appendJournal, localNow, localStamp } from "./memory.ts";
import { hooks } from "./approvals.ts";
import { OWNER_DM_LANE } from "./feishu.ts";

const CLI = process.env.SBOT_CLAUDE_CLI ?? "/opt/sbot/claude-code/current/claude";
const WRAPPER = "/usr/local/lib/sbot/worker-exec";
const MKDIR = "/usr/local/lib/sbot/task-mkdir";
const PLUGIN = process.env.SBOT_LENS_PLUGIN ?? "/opt/sbot/plugins/sbot-lens";
const TIMEOUT_MS = 15 * 60_000, BUDGET = 60_000, MAX_TURNS = 60;

interface LensDef { zh: string; skills: string[]; methods: Record<string, { zh: string; birth: boolean; horizon?: string }> }
export const LENSES: Record<string, LensDef> = {
  ziwei: {
    zh: "紫微", skills: ["sbot-lens:ziwei-chart", "sbot-lens:ziwei-natal", "sbot-lens:ziwei-zhanbu"],
    methods: {
      natal: { zh: "本命盘：围绕一个问题看本命", birth: true },
      month: { zh: "流月：这个月的留意点（月前瞻用）", birth: true, horizon: "month" },
      zhanbu: { zh: "紫占：用起念时间看一件具体的事", birth: false },
    },
  },
  liuyao: {
    zh: "六爻", skills: ["sbot-lens:liuyao-guanxiang"],
    methods: {
      cast: { zh: "观象系辞：为一件具体的事起卦", birth: false },
      day: { zh: "日运：为这一天起一卦", birth: false, horizon: "day" },
      week: { zh: "周运：为这一周起一卦", birth: false, horizon: "week" },
      month: { zh: "月运：为这个月起一卦", birth: false, horizon: "month" },
    },
  },
};
/** how the 六爻 script may cast (qigua.mjs methods that need nothing from him); dayan is the skill's own default */
export const CAST_METHODS: Record<string, string> = { dayan: "大衍筮法", coins: "三钱法", time: "时间起卦", random: "程序随机" };
const HORIZON_ZH: Record<string, string> = { day: "当日", week: "本周", month: "本月" };
/**
 * 渎则不告: asking again about the same matter is what the school refuses, so these stay one per matter unless the matter
 * itself changed. A routine day / week / month cast is a different question each period and is not affected; it has its
 * own rule below, one per period and version.
 */
const ONE_PER_MATTER = new Set(["liuyao:cast", "ziwei:zhanbu"]);

const pluginVersion = () => { try { return JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version ?? "?"; } catch { return "?"; } };

/** §15.7 版本冻结: chart parameters (and the birth data they use) → a new version; the ledger is split by it */
export function profileVersion(lens: string, method: string): string {
  const { birth, lenses } = selfLensConf();
  const needs = LENSES[lens]?.methods[method]?.birth;
  const h = createHash("sha256").update(JSON.stringify({ lens, profile: lenses[lens]?.profile ?? {}, birth: needs ? birth ?? null : null, plugin: pluginVersion() })).digest("hex");
  return `${lens}-${h.slice(0, 10)}`;
}

export interface ReadingRequest {
  lens: string; method: string; question: string; horizon?: string | null; period?: string | null; matterId?: number | null;
  changedBecause?: string; originLane?: string; originTurn?: string | null; requestedBy: string;
}

export function requestReading(r: ReadingRequest): number {
  const def = LENSES[r.lens];
  if (!def) throw new Error(`没有这门镜头：${r.lens}（有：${Object.keys(LENSES).join("、")}）`);
  const m = def.methods[r.method];
  if (!m) throw new Error(`${def.zh}没有 ${r.method}（有：${Object.entries(def.methods).map(([k, v]) => `${k}=${v.zh}`).join("；")}）`);
  const { birth, lenses } = selfLensConf();
  if (lenses[r.lens]?.enabled === false) throw new Error(`${def.zh}在 self.yaml 里关掉了`);
  if (m.birth && !birthReady(birth)) throw new Error("出生信息还没填全（要日期、时间、性别、出生地经度）。他在私聊里说，用 self_profile 记；或者去控制台「生活 › 出生信息」填。不需要生辰的六爻、紫占现在就能看。");
  const horizon = m.horizon ?? r.horizon ?? null;
  if (horizon && !periodOk(horizon, r.period ?? "")) throw new Error(`${HORIZON_ZH[horizon] ?? horizon}看法的 period 不对，要像 ${{ day: "2026-12-03", week: "2026-W49", month: "2026-12" }[horizon] ?? "2026-12"}`);
  // per version: after a corrected birth time the old month view must not block the new chart's (§15.7)
  if (horizon && !r.changedBecause && one("SELECT id FROM readings WHERE lens=? AND method=? AND horizon=? AND period=? AND profile_version=? AND status!='failed'", r.lens, r.method, horizon, r.period, profileVersion(r.lens, r.method)))
    throw new Error(`${def.zh} ${r.period} 的看法已经有了（写下后不改，回看用 reading_revisit）。这段时间里事情本身变了才再看，在 changed_because 里写清楚。`);
  if (r.matterId && ONE_PER_MATTER.has(`${r.lens}:${r.method}`) && !r.changedBecause) {
    const prev = one("SELECT id FROM readings WHERE lens=? AND method=? AND matter_id=? AND status!='failed'", r.lens, r.method, r.matterId);
    if (prev) throw new Error(`这件事已经看过一次（解读 #${prev.id}），以第一次为准（渎则不告）。只有事情本身变了（换了对象、换了时间段）才再看，并在 changed_because 里写清楚变在哪。`);
  }
  const id = Number(run(`INSERT INTO readings(ts, lens, method, profile_version, question, horizon, period, matter_id, status, origin_lane, origin_turn_json, requested_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, Date.now(), r.lens, r.method, profileVersion(r.lens, r.method), r.question + (r.changedBecause ? `\n（再看的原因：${r.changedBecause}）` : ""),
    horizon, r.period ?? null, r.matterId ?? null, "queued", r.originLane ?? OWNER_DM_LANE, r.originTurn ?? null, r.requestedBy).lastInsertRowid);
  log("lens", "queued", { id, lens: r.lens, method: r.method, by: r.requestedBy });
  engine?.kick();
  return id;
}

// ───────────── the ledger, as text for the agent ─────────────

interface Claim { claim: string; revisit_at?: string; look_for?: string }
export function readingText(r: Record<string, any>, full = true): string {
  const def = LENSES[r.lens];
  const claims: Claim[] = JSON.parse(r.claims_json ?? "[]"), notice: string[] = JSON.parse(r.notice_json ?? "[]");
  const rv = all("SELECT claim_idx, text, ts FROM reading_revisits WHERE reading_id=? ORDER BY id", r.id);
  const head = `解读 #${r.id} · ${def?.zh ?? r.lens} ${def?.methods[r.method]?.zh ?? r.method}${r.period ? ` · ${r.period}` : ""}${r.matter_id ? ` · 事 #${r.matter_id}` : ""} · ${localStamp(r.ts).slice(0, 10)} 写下`;
  if (r.status !== "done") return `${head}（${r.status}${r.error ? `：${r.error}` : ""}）`;
  return [head, `问：${r.question}`,
    full ? `看法：${r.reading}` : `看法（摘）：${String(r.reading ?? "").slice(0, 200)}…`,
    notice.length ? `留意：${notice.join("；")}` : "",
    claims.length ? `到时回看：\n${claims.map((c, i) => `  [${i}] ${c.claim}${c.revisit_at ? `（${c.revisit_at}）` : ""}${c.look_for ? `，留意：${c.look_for}` : ""}`).join("\n")}` : "",
    rv.length ? `他回看时说：\n${rv.map((x) => `  ${localStamp(x.ts).slice(0, 10)}${x.claim_idx != null ? ` [${x.claim_idx}]` : ""}：${x.text}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

/** readings to bring out in a review: those for this period / matter, and claims whose revisit date falls in [from, to) */
export function readingsForReview(o: { period?: string; matterId?: number; from?: number; to?: number }): string {
  const rows = new Map<number, Record<string, any>>();
  if (o.period) for (const r of all("SELECT * FROM readings WHERE period=? AND status='done'", o.period)) rows.set(r.id, r);
  if (o.matterId) for (const r of all("SELECT * FROM readings WHERE matter_id=? AND status='done'", o.matterId)) rows.set(r.id, r);
  if (o.from != null && o.to != null) {
    const a = localStamp(o.from).slice(0, 10), b = localStamp(o.to).slice(0, 10);
    // routine day / week views come back in their own period's review; by date they would flood the bigger ones
    for (const r of all("SELECT * FROM readings WHERE status='done' AND claims_json IS NOT NULL AND (horizon IS NULL OR horizon NOT IN ('day','week'))")) {
      if ((JSON.parse(r.claims_json) as Claim[]).some((c) => c.revisit_at && c.revisit_at >= a && c.revisit_at < b)) rows.set(r.id, r);
    }
  }
  return [...rows.values()].sort((x, y) => x.id - y.id).map((r) => readingText(r)).join("\n\n") || "（没有）";
}

/** every view for one period, whatever state it is in, so the morning report can say one failed or isn't out yet */
export function periodReadingsText(period: string): string | undefined {
  const rows = all("SELECT * FROM readings WHERE period=? ORDER BY id", period);
  return rows.length ? rows.map((r) => readingText(r)).join("\n\n") : undefined;
}

export function readingsQuery(o: { lens?: string; period?: string; matterId?: number; limit?: number; full?: boolean }): string {
  const where = ["1=1"], args: any[] = [];
  if (o.lens) { where.push("lens=?"); args.push(o.lens); }
  if (o.period) { where.push("period=?"); args.push(o.period); }
  if (o.matterId) { where.push("matter_id=?"); args.push(o.matterId); }
  const rows = all(`SELECT * FROM readings WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...args, Math.min(o.limit ?? 10, 30));
  return rows.map((r) => readingText(r, o.full || rows.length <= 3)).join("\n\n") || "（没有）";
}

export function revisitReading(id: number, claimIdx: number | undefined, text: string, src: string, runId: string) {
  const r = one("SELECT * FROM readings WHERE id=?", id);
  if (!r) throw new Error(`no reading #${id}`);
  if (r.status !== "done") throw new Error(`解读 #${id} 还没出结果（${r.status}）`);
  const n = (JSON.parse(r.claims_json ?? "[]") as Claim[]).length;
  if (claimIdx != null && (claimIdx < 0 || claimIdx >= n)) throw new Error(`解读 #${id} 只有 ${n} 条回看点（0～${n - 1}）`);
  run("INSERT INTO reading_revisits(reading_id, claim_idx, ts, text, src, run_id) VALUES(?,?,?,?,?,?)", id, claimIdx ?? null, Date.now(), text.trim(), src, runId);
  appendJournal(`回看解读 #${id}（${LENSES[r.lens]?.zh ?? r.lens}${claimIdx != null ? ` [${claimIdx}]` : ""}）他说：${text}`, src);
  signal("reading_revisit", { role: "lens", run_id: runId, value: { reading: id, lens: r.lens, claim: claimIdx ?? null } });
}

// ───────────── the restricted worker ─────────────

let engine: LensEngine | undefined;

export class LensEngine {
  private busy = false;
  private timer?: NodeJS.Timeout;
  private ac?: AbortController;
  constructor() { engine = this; }
  start() {
    run("UPDATE readings SET status='queued' WHERE status='running'");
    this.timer = setInterval(() => this.kick(), 60_000);
    this.kick();
  }
  stop() { clearInterval(this.timer); this.ac?.abort(); }

  kick() {
    if (this.busy) return;
    const r = one("SELECT * FROM readings WHERE status='queued' ORDER BY id LIMIT 1");
    if (!r) return;
    this.busy = true;
    run("UPDATE readings SET status='running' WHERE id=?", r.id);
    void this.runOne(r).catch((e) => this.fail(r, String(e?.message ?? e))).finally(() => { this.busy = false; this.kick(); });
  }

  private fail(r: Record<string, any>, err: string) {
    log("lens", "failed", { id: r.id, err: err.slice(0, 300) });
    run("UPDATE readings SET status='failed', error=?, done_at=? WHERE id=?", err.slice(0, 500), Date.now(), r.id);
    if (r.requested_by !== "job") notify(r, `【镜头没看成：解读 #${r.id}】${LENSES[r.lens]?.zh} ${r.method}：${err.slice(0, 200)}\n简单告诉他一声就好。`);
  }

  private async runOne(r: Record<string, any>) {
    const def = LENSES[r.lens], m = def.methods[r.method];
    const runId = `lens_${r.id}`;
    const dir = await new Promise<string>((ok, bad) => execFile("/usr/bin/sudo", ["-n", MKDIR, `lens-${r.id}-${Number(r.ts).toString(36)}`], { timeout: 30_000 },
      (e, out, err) => e ? bad(new Error(`task-mkdir: ${String(err || e.message).trim()}`)) : ok(out.trim())));
    const put = (rel: string, text: string) => { const f = join(dir, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, text); chmodSync(f, 0o640); };
    const { birth, lenses } = selfLensConf();
    const profile = lenses[r.lens]?.profile ?? {};
    if (m.birth) {
      if (!birthReady(birth)) throw new Error("出生信息不全");
      put("self.yaml", stringify({ birth, chart_input: chartInput(birth), profile }));
    }
    const notes = join(P.agentHome, "self", "lens-notes", `${r.lens}.md`);
    put("lens-notes.md", existsSync(notes) ? readFileSync(notes, "utf8") : "（还没有笔记）\n");
    const charts = join(P.agentHome, "self", "charts", r.lens, r.profile_version);
    if (existsSync(charts)) for (const f of readdirSync(charts)) put(join("charts", f), readFileSync(join(charts, f), "utf8"));
    const matter = r.matter_id ? one("SELECT title, file_path FROM matters WHERE id=?", r.matter_id) : undefined;

    let submitted: any;
    const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const sbot = createSdkMcpServer({ name: "sbot", version: "1.0.0", tools: [
      tool("submit_reading", "Submit the reading in the unified format. Call exactly once, at the end. reading: the view in plain Chinese (what the lens says, how it gets there, in a few paragraphs). notice: 1–3 short things worth paying attention to. claims: what to look back at later, each with a date (YYYY-MM-DD) and what to watch for. keep_files: chart files in the current directory worth keeping as the frozen chart for this profile (natal / chart output only).",
        {
          reading: z.string().min(20).max(6000), notice: z.array(z.string().min(2).max(300)).max(5).default([]),
          claims: z.array(z.object({ claim: z.string().min(2).max(500), revisit_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), look_for: z.string().max(300).optional() })).max(6).default([]),
          keep_files: z.array(z.string()).max(8).default([]),
        },
        async (a) => { submitted = a; return ok("收到。可以结束了。"); }),
    ] });
    const token = issueToken({ runId, tier: "work", requester: `lens:${r.lens}`, budgetOutput: BUDGET, ttlMs: TIMEOUT_MS + 5 * 60_000 });
    run(`INSERT INTO runs(id, lane, session_key, role, tier, model, status, started, versions_json) VALUES(?,?,?,?,?,?,?,?,?)`,
      runId, `lens:${r.id}`, null, "lens", "work", tierConf("work").model, "running", Date.now(),
      JSON.stringify({ cli: CLI, plugin: pluginVersion(), profile: r.profile_version }));
    run("UPDATE readings SET run_id=? WHERE id=?", runId, r.id);
    const eg = await openEgress(`lens-${r.id}`, []);   // nothing allowed: attempts are only logged
    const ac = this.ac = new AbortController();
    const dog = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const model = "sbot-work";
    const cast = CAST_METHODS[profile.cast] ? profile.cast : "dayan";
    const routine = m.horizon && !m.birth;
    const prompt = [
      `现在 ${localNow()}。你是${ownerName()}的「${def.zh}」镜头。用对应的 skill（${def.skills.join("、")}）按它的方法看，最后用 mcp__sbot__submit_reading 交回。`,
      `方法：${m.zh}（${r.method}）`,
      r.horizon ? `这是${HORIZON_ZH[r.horizon] ?? r.horizon}看法，时间段：${r.period}。留意点和回看日期都落在这个时间段里。` : "",
      routine ? `这是按时间段的例行起卦：所问之事就是这段时间本身，不用收窄问题，也不用注明问题较泛。只起一卦，用 ${cast}，不重起。` : "",
      r.lens === "liuyao" && !routine ? `没有别的说法时用 ${cast} 起卦。` : "",
      r.horizon === "day" ? "写短：看法 300 字以内，留意点 1 条，回看点最多 1 条。" : r.horizon === "week" ? "看法 600 字以内，留意点最多 2 条，回看点最多 2 条。" : "",
      profile.notes ? `他对这门镜头的要求：${profile.notes}` : "",
      `问题：${r.question}`,
      matter ? `这是他的一件事：#${r.matter_id}「${matter.title}」。` : "",
      m.birth ? "出生信息在 ./self.yaml。排盘一律用其中的 chart_input（已是公历，农历已换算好）：ziwei-chart build --datetime <datetime> --longitude <longitude> --gender <gender> --timezone <timezone>，不要自己换算。profile 是这门镜头的设置，按它来。" + (existsSync(charts) ? "./charts/ 里是这个版本已经排好的盘，直接用，不要重排。" : "还没有排好的盘：先用 ziwei-chart 排盘，输出放当前目录，交回时把盘的文件列进 keep_files。") : "",
      "./lens-notes.md 是他以前回看这门镜头时的感受笔记，参考它决定怎么说、说多少。",
      "立场：这是一种看法，给他结合生活去感受，不是判决，不打分。写清楚依据。不需要的文件不要写。没有网络，也不需要网络。",
    ].filter(Boolean).join("\n");
    const options = {
      cwd: dir, model, abortController: ac,
      systemPrompt: { type: "preset", preset: "claude_code", append: `你在 SStudioBot 的镜头沙箱里工作：只在当前目录写文件，没有网络。结果只通过 submit_reading 交回。` },
      pathToClaudeCodeExecutable: CLI,
      tools: ["Bash", "Read", "Write", "Glob", "Grep", "Skill"],
      allowedTools: ["Bash", "Read", "Write", "Glob", "Grep", "Skill", "mcp__sbot__submit_reading"],
      mcpServers: { sbot },
      plugins: [{ type: "local", path: PLUGIN }],
      skills: def.skills,   // always explicit: the CLI also discovers ~16 bundled skills
      permissionMode: "dontAsk", settingSources: [], maxTurns: MAX_TURNS,
      sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { httpProxyPort: eg.port } },
      settings: { skipWebFetchPreflight: true, env: { HTTPS_PROXY: `http://127.0.0.1:${eg.port}`, NO_PROXY: "127.0.0.1,localhost" } },
      env: {
        LANG: "C.UTF-8", CLAUDE_CONFIG_DIR: join(dir, ".claude"),
        ANTHROPIC_BASE_URL: PROXY_BASE, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "sbot-light", ANTHROPIC_SMALL_FAST_MODEL: "sbot-light",
        ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      },
      spawnClaudeCodeProcess: (o: any) => {
        const args = o.command === CLI ? o.args : o.args?.[0] === CLI ? o.args.slice(1) : null;
        if (!args) throw new Error(`unexpected CLI spawn: ${o.command}`);
        return spawn("/bin/sh", ["-c", `umask 027; exec /usr/bin/sudo -n ${WRAPPER} "$@"`, "sh", ...args],
          { cwd: o.cwd ?? dir, env: o.env, stdio: ["pipe", "pipe", "inherit"], signal: o.signal }) as any;
      },
    } as unknown as Options;
    let err: string | undefined, result: any;
    log("lens", "run start", { id: r.id, lens: r.lens, method: r.method });
    try {
      for await (const msg of query({ prompt, options }) as AsyncIterable<any>) if (msg.type === "result") result = msg;
    } catch (e: any) { err = String(e?.message ?? e); }
    finally { clearTimeout(dog); eg.close(); revokeToken(token); this.ac = undefined; }
    if (eg.log.length) log("lens", "network attempts blocked", { id: r.id, n: eg.log.length });
    run("UPDATE runs SET status=?, ended=?, stop_reason=? WHERE id=?", submitted ? "done" : "failed", Date.now(), result?.subtype ?? err?.slice(0, 200) ?? null, runId);
    if (!submitted) throw new Error(err ? err.slice(0, 300) : ac.signal.aborted ? "超时" : "没有交回结果");

    // frozen chart for this profile_version: only the first time, only plain files inside the task dir
    let chartRef: string | null = existsSync(charts) ? `self/charts/${r.lens}/${r.profile_version}` : null;
    if (!chartRef && m.birth && submitted.keep_files.length) {
      mkdirSync(charts, { recursive: true });
      for (const rel of submitted.keep_files as string[]) {
        const src = normalize(join(dir, rel));
        if (!src.startsWith(dir + "/") || !existsSync(src) || !statSync(src).isFile() || statSync(src).size > 2_000_000) continue;
        copyFileSync(src, join(charts, rel.replace(/[\/\\]/g, "_")));
      }
      writeFileSync(join(charts, "README.md"), `---\nvisibility: owner\n---\n# ${def.zh} 事实盘 ${r.profile_version}\n\n冻结版本：排盘参数或出生信息变了会生成新版本，这里不改。来自解读 #${r.id}。\n`);
      chartRef = `self/charts/${r.lens}/${r.profile_version}`;
    }
    run("UPDATE readings SET status='done', reading=?, notice_json=?, claims_json=?, chart_ref=?, done_at=? WHERE id=?",
      submitted.reading, JSON.stringify(submitted.notice), JSON.stringify(submitted.claims), chartRef, Date.now(), r.id);
    appendJournal(`解读 #${r.id}（${def.zh} ${r.method}${r.period ? ` ${r.period}` : ""}）写下：${submitted.notice.join("；") || submitted.reading.slice(0, 120)}`, "lens");
    signal("reading_done", { role: "lens", run_id: runId, value: { reading: r.id, lens: r.lens, method: r.method } });
    log("lens", "done", { id: r.id, claims: submitted.claims.length });
    const surface = JSON.parse(r.origin_turn_json ?? "null")?.surface ?? "feishu:dm";
    if (r.requested_by !== "job") notify(getReading(r.id)!, `【镜头结果：解读 #${r.id}】下面是${def.zh}的看法，已经写进解读账本（写下后不改）。

${readingText(getReading(r.id)!)}

怎么说：这是一种看法，给他结合生活去感受，不是结论。${surface === "feishu:dm" || surface === "console"
    ? `这是他的私聊，把看法直接给他看，问他有没有什么感觉。${chartRef ? `盘面在 ${chartRef}，他要看就用 self_page 读出来贴给他。` : ""}`
    : "这里不是他的私聊：只说一两句留意点，全文和盘面请他到私聊或控制台看。"}到了回看日期，复盘时会拿出来。`);
  }
}

export const getReading = (id: number) => one("SELECT * FROM readings WHERE id=?", id);

function notify(r: Record<string, any>, text: string) {
  run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
    r.origin_lane ?? OWNER_DM_LANE, "timer", "lens", `${r.id}:${r.status ?? "done"}:${Date.now()}`, r.origin_turn_json ?? null,
    JSON.stringify({ text, ts: Date.now(), quota: false }), "received", Date.now());
  hooks.kickDispatcher();
}

const PERIOD_ASK: Record<string, (p: string) => string> = {
  day: (p) => `${p} 这一天最该留意什么（工作、家庭、身体、心）`,
  week: (p) => `${p} 这一周最该留意什么（工作、家庭、身体、心）`,
  month: (p) => `${p} 这个月整体的留意点（工作、家庭、身体、心）`,
};
/** which period a job firing now is about. On Sunday the week job looks at the coming week, like the Sunday review. */
export function periodFor(horizon: "day" | "week" | "month", now = Date.now()): string {
  if (horizon === "day") return today(now);
  if (horizon === "month") return monthOf(now);
  return isoWeek(new Date(`${today(now)}T12:00:00Z`).getUTCDay() === 0 ? now + 2 * 86400_000 : now);
}

/** jobs lens_day / lens_week / lens_month: every lens with a method for this horizon and the data it needs; silent */
export function queueHorizonReadings(horizon: "day" | "week" | "month", now = Date.now()): number[] {
  const period = periodFor(horizon, now), ids: number[] = [];
  const { birth, lenses } = selfLensConf();
  for (const [lens, def] of Object.entries(LENSES)) for (const [method, m] of Object.entries(def.methods)) {
    if (m.horizon !== horizon || lenses[lens]?.enabled === false || (m.birth && !birthReady(birth))) continue;
    try { ids.push(requestReading({ lens, method, question: PERIOD_ASK[horizon](period), period, requestedBy: "job" })); }
    catch (e: any) { log("lens", "period reading skipped", { lens, method, err: String(e?.message ?? e).slice(0, 120) }); }
  }
  return ids;
}
