// Config forms smoke (DESIGN §触5.6) on the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh config-form-smoke.ts 7829
//
// No model and no Feishu: a stand-in lark-cli records what the admin group would receive. All names and IDs are made up.
//   every form file: one edit → comments kept, smallest diff, git commit "(via console)", config_changes, admin notice
//   widenings need a confirmation and get the ⚠️ notice; a stale hash is refused; bad values come back readable;
//   keys the form doesn't know survive and are listed; secrets never appear; only owners can write

import http from "node:http";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HOME = process.env.SBOT_HOME ?? "";
if (!HOME || HOME === "/srv/sbot" || !/testhomes|tmp/.test(HOME)) { console.error("run on a throwaway SBOT_HOME (see vps-test-home.sh)"); process.exit(2); }
const SOCKS = join(HOME, "socks"), SENT = join(HOME, "lark-sent.log"), FAKE = join(HOME, "fake-lark");
mkdirSync(join(SOCKS, "tn"), { recursive: true }); mkdirSync(join(SOCKS, "web"), { recursive: true });
process.env.SBOT_SECRETS = join(HOME, "secrets-test.env");
process.env.SBOT_CONSOLE_SOCK = join(SOCKS, "tn", "console.sock");
process.env.SBOT_CONSOLE_WEB_SOCK = join(SOCKS, "web", "console.sock");
process.env.SBOT_LARK_CLI = FAKE;
delete process.env.SBOT_CONSOLE_PORT;
writeFileSync(process.env.SBOT_SECRETS, "", { mode: 0o600 });
writeFileSync(SENT, "");
writeFileSync(FAKE, `#!/bin/sh\n{ printf '%s\\n' "$*"; cat; printf '\\n'; } >> '${SENT}'\nprintf '{"code":0,"data":{"message_id":"om_test"}}'\n`);
chmodSync(FAKE, 0o755);

const realLog = console.log;
console.log = () => {};
const ok = (cond: unknown, what: string) => { realLog(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };

const here = dirname(fileURLToPath(import.meta.url));
const { P, jobsConf, writeSecret } = await import("../src/config.ts");
const { ensureAgentHome, git, commitIfDirty } = await import("../src/memory.ts");
const { all, one, run } = await import("../src/db.ts");
const { specProblems, formSpec } = await import("../src/config-form.ts");
for (const d of [P.sessions, P.logs, P.config]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));

const OWNER = "owner@localhost", SECRET_VALUE = "not-a-real-secret-value-7f3a";
const FILES: Record<string, string> = {
  "gate.yaml": `# 闸门示例：这行注释要留下
proactive_daily_cap: 6   # 每天主动消息
send_by_hours: 2

# 敏感词也有注释
sensitive_words: [HR, 人事]
attention:
  wait_minutes: 30  # 等待
future_knob:    # 以后才有的项
  depth: 3
`,
  "jobs.yaml": `# 定时任务示例
morning: { every: day, at: "08:30", do: morning }   # 早报
note_week:
  every: week   # 每周
  weekday: 1
  at: "09:00"
  do: event
  text: 看一下周报
  mystery: 42
`,
  "groups.yaml": `# 群设置示例
reviewed: true
default: when_mentioned  # 默认档
groups:
  oc_alpha: { name: 甲组, activation: digest }  # 甲
`,
  "sources.yaml": `# 信息源示例
feishu:
  dm: false   # 私聊
sources:
  - id: notes   # 笔记网页
    kind: fetch
    url: https://example.test/notes
    every: 1h
`,
  "people.yaml": `# 人员示例
owner:
  name: 测试主人   # 称呼
  ids:
    feishu: ou_owner_example
xiaoming:
  name: 小明
  ids: { feishu: ou_xiaoming_example }
  relation: 朋友  # 关系
`,
  "feishu.yaml": `# 飞书示例
admin_chat: oc_admin  # 管理群
workbench_chat: oc_work
`,
  "repos.yaml": `# 仓库示例
demo:
  url: https://example.test/team/demo.git  # 地址
  branch: main
`,
  "console.yaml": `# 控制台示例
owners:
  - ${OWNER}   # 主人
  - second@localhost
`,
  "models.yaml": `# 模型示例
endpoints:
  main:
    base_url: https://api.example.test   # 端点
    auth: bearer
    key_ref: UPSTREAM_AUTH
tiers:
  chat: { endpoint: main, model: model-chat }   # 总控
  work: { endpoint: main, model: model-work }
  light:
    endpoint: main   # 读取
    model: model-light
budgets:
  daily_cost: 5   # 上限
`,
};
for (const [f, t] of Object.entries(FILES)) writeFileSync(join(P.config, f), t);
if (!existsSync(join(P.config, ".git"))) git(P.config, "init", "-q", "-b", "main");
commitIfDirty(P.config, "initial config");
writeSecret("UPSTREAM_AUTH", SECRET_VALUE);
writeSecret("PLUGIN_TOKEN", SECRET_VALUE);
for (const [id, name] of [["oc_alpha", "甲组"], ["oc_beta", "乙组"], ["oc_admin", "管理测试群"], ["oc_work", "工作台测试群"], ["oc_other", "另一个群"]])
  run("INSERT OR REPLACE INTO chats(chat_id, name, external, muted, chat_mode) VALUES(?,?,0,0,'group')", id, name);

const { startConsole } = await import("../src/console.ts");
const srv = startConsole({ startedAt: Date.now() });
await new Promise((r) => setTimeout(r, 300));

type Res = { status: number; j: any; text: string };
function call(method: string, path: string, body?: unknown, o: { who?: string | null; csrf?: boolean } = {}): Promise<Res> {
  const send = body === undefined ? undefined : JSON.stringify(body), who = o.who === undefined ? OWNER : o.who;
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: process.env.SBOT_CONSOLE_SOCK, method, path: `/api${path}`, headers: {
      ...(who ? { "tailscale-user-login": who } : {}), ...(o.csrf === false ? {} : { "x-sbot-console": "1" }),
      ...(send ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(send)) } : {}) } }, (res) => {
      const c: Buffer[] = []; res.on("data", (d) => c.push(d));
      res.on("end", () => { const text = Buffer.concat(c).toString(); let j: any = null; try { j = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode ?? 0, j, text }); });
    });
    r.on("error", reject);
    if (send) r.write(send);
    r.end();
  });
}
const form = async (f: string) => (await call("GET", `/config/${f}/form`)).j;
const preview = async (f: string, values: unknown, hash: string) => (await call("POST", `/config/${f}/form/preview`, { values, hash })).j;
const put = (f: string, values: unknown, hash: string, ack: string[] = []) => call("PUT", `/config/${f}/form`, { values, hash, ack });
const onDisk = (f: string) => readFileSync(join(P.config, f), "utf8");
const parsed = (f: string) => parseYaml(onDisk(f));
const comments = (t: string) => [...t.matchAll(/#\s.*$/gm)].map((m) => m[0].trim());
const head = () => git(P.config, "rev-parse", "HEAD").trim();
const subject = () => git(P.config, "log", "-1", "--format=%s").trim();
const numstat = (f: string) => git(P.config, "show", "--numstat", "--format=", "HEAD", "--", f).trim().split(/\s+/).slice(0, 2).join("/");
const sent = () => readFileSync(SENT, "utf8");
async function heard(text: string, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (sent().includes(text)) return true; await new Promise((r) => setTimeout(r, 50)); } return false; }
const changes = (f: string) => one("SELECT COUNT(*) n FROM config_changes WHERE file=? AND source='console'", f)!.n as number;

// ── the description matches the schema, and only the agreed files have one ──
ok(specProblems().length === 0, `form descriptions match the zod schemas${specProblems().length ? `: ${specProblems().join("; ")}` : ""}`);
ok(Object.keys(FILES).every((f) => formSpec(f)), "every file under test has a form");
ok((await call("GET", "/config/self.yaml/form")).status === 404, "self.yaml has no form yet");
ok((await call("GET", "/config/nope.yaml/form")).status === 404, "unknown file → 404");
const listed = (await call("GET", "/config")).j;
ok(listed.find((x: any) => x.file === "gate.yaml")?.title === "限额与闸门" && !!listed.find((x: any) => x.file === "gate.yaml")?.summary, "the config list carries form titles");

// ── who can write ──
{
  const f = await form("gate.yaml"), before = head();
  ok((await call("PUT", "/config/gate.yaml/form", { values: { send_by_hours: 9 }, hash: f.hash }, { who: "stranger@localhost" })).status === 403, "not an owner → 403");
  ok((await call("PUT", "/config/gate.yaml/form", { values: { send_by_hours: 9 }, hash: f.hash }, { csrf: false })).status === 403, "no CSRF header → 403");
  ok((await call("POST", "/config/gate.yaml/form/preview", { values: {}, hash: f.hash }, { who: null })).status === 403, "preview needs an identity too");
  ok(head() === before && !onDisk("gate.yaml").includes("send_by_hours: 9"), "refused writes change nothing");
}

// ── one edit per file ──
const EDITS: Record<string, { edit: (v: any) => void; lines: string; check: (y: any) => boolean }> = {
  "gate.yaml": { edit: (v) => { v.send_by_hours = 3; }, lines: "1/1", check: (y) => y.send_by_hours === 3 },
  "jobs.yaml": { edit: (v) => { v.morning.at = "08:40"; }, lines: "1/1", check: (y) => y.morning.at === "08:40" },
  "groups.yaml": { edit: (v) => { v.default = "digest"; }, lines: "1/1", check: (y) => y.default === "digest" },
  "sources.yaml": { edit: (v) => { v.sources[0].every = "2h"; }, lines: "1/1", check: (y) => y.sources[0].every === "2h" },
  "people.yaml": { edit: (v) => { v.xiaoming.relation = "同事"; }, lines: "1/1", check: (y) => y.xiaoming.relation === "同事" },
  "feishu.yaml": { edit: (v) => { v.workbench_chat = "oc_other"; }, lines: "1/1", check: (y) => y.workbench_chat === "oc_other" },
  "repos.yaml": { edit: (v) => { v.demo.branch = "develop"; }, lines: "1/1", check: (y) => y.demo.branch === "develop" },
  "console.yaml": { edit: (v) => { v.owners = [OWNER]; }, lines: "0/1", check: (y) => y.owners.length === 1 },
  "models.yaml": { edit: (v) => { v.tiers.light.model = "model-light-2"; }, lines: "1/1", check: (y) => y.tiers.light.model === "model-light-2" },
};
for (const [file, e] of Object.entries(EDITS)) {
  const f = await form(file), keep = comments(onDisk(file)).filter((c) => file !== "console.yaml" || !c.includes("second")), n = changes(file), before = head();
  e.edit(f.values);
  const p = await preview(file, f.values, f.hash);
  ok(p.changed && !p.errors.length && !p.stale && p.diff.length > 0, `${file}: preview shows the change`);
  ok(head() === before, `${file}: preview writes nothing`);
  const r = await put(file, f.values, f.hash, p.widened);
  ok(r.status === 200 && r.j.changed === true, `${file}: form save accepted${r.status === 200 ? "" : ` (${r.status} ${r.text.slice(0, 200)})`}`);
  ok(e.check(parsed(file)), `${file}: the value landed`);
  ok(keep.every((c) => onDisk(file).includes(c)), `${file}: comments kept`);
  ok(numstat(file) === e.lines, `${file}: smallest diff (${numstat(file)}, want ${e.lines})`);
  ok(subject() === `${file}: edit (via console)`, `${file}: git commit "(via console)"`);
  ok(changes(file) === n + 1, `${file}: recorded in config_changes`);
  ok(await heard(`控制台改了 ${file}`), `${file}: admin group told`);
  ok(r.j.hash !== f.hash && (await form(file)).hash === r.j.hash, `${file}: the reply carries the new hash`);
}

// ── nothing changed → nothing written ──
for (const file of Object.keys(FILES)) {
  const f = await form(file), before = head(), text = onDisk(file);
  const r = await put(file, f.values, f.hash);
  ok(r.status === 200 && r.j.changed === false && head() === before && onDisk(file) === text, `${file}: saving untouched values is a no-op`);
}

// ── widenings: warned before, confirmed, shouted after ──
{
  const f = await form("gate.yaml"), before = head();
  f.values.proactive_daily_cap = 20;
  const p = await preview("gate.yaml", f.values, f.hash);
  ok(p.widened.some((w: string) => w.includes("主动消息上限")) && p.notes.length > 0, "preview names the widening and its consequence");
  const no = await put("gate.yaml", f.values, f.hash);
  ok(no.status === 409 && no.j.need_ack?.length === p.widened.length && head() === before, "no confirmation → 409, nothing written");
  const partial = await put("gate.yaml", f.values, f.hash, ["别的东西"]);
  ok(partial.status === 409 && head() === before, "confirming something else doesn't count");
  const yes = await put("gate.yaml", f.values, f.hash, p.widened);
  ok(yes.status === 200 && parsed("gate.yaml").proactive_daily_cap === 20, "confirmed → saved");
  ok(await heard("放宽了限制") && await heard("主动消息上限 6 → 20"), "⚠️ notice from widening() reaches the admin group");
}
{ // things widening() doesn't know about: the form adds its own notice next to it
  const f = await form("groups.yaml");
  f.values.groups.oc_beta = { activation: "always" };
  const was = await form("groups.yaml");
  const p = await preview("groups.yaml", f.values, f.hash);
  ok(was.values.default === "digest" && p.widened.some((w: string) => w.includes("乙组")), "a group with no entry going to 全部 counts as widening");
  const r = await put("groups.yaml", f.values, f.hash, p.widened);
  ok(r.status === 200 && parsed("groups.yaml").groups.oc_beta.name === "乙组", "new group entry saved with its name");
  ok(await heard("控制台表单，groups.yaml"), "the form's extra ⚠️ notice is sent");
}
{
  const f = await form("feishu.yaml");
  f.values.admin_chat = "oc_other";
  const p = await preview("feishu.yaml", f.values, f.hash);
  ok(p.widened.length > 0, "moving the admin group needs confirming");
  ok((await put("feishu.yaml", f.values, f.hash)).status === 409, "…and is refused without it");
  ok((await put("feishu.yaml", f.values, f.hash, p.widened)).status === 200 && parsed("feishu.yaml").admin_chat === "oc_other", "…and saved with it");
  const told = await heard("这个群以后不再收到审批和通知");
  ok(told, "the old admin group hears that it was replaced");
}
{
  const f = await form("models.yaml");
  f.values.endpoints.main.base_url = "https://elsewhere.example.test";
  ok((await preview("models.yaml", f.values, f.hash)).widened.length > 0, "changing where model requests and keys go counts as widening");
  const g = await form("models.yaml");
  g.values.budgets.daily_cost = null;
  const p = await preview("models.yaml", g.values, g.hash);
  ok(p.widened.some((w: string) => w.includes("不限")), "clearing the daily cost limit counts as widening");
  const j = await form("jobs.yaml");
  j.values.note_week.quota = false;
  ok((await preview("jobs.yaml", j.values, j.hash)).widened.length > 0, "taking a reminder off the proactive quota counts as widening");
  const s = await form("sources.yaml");
  s.values.feishu.dm = true;
  ok((await preview("sources.yaml", s.values, s.hash)).widened.some((w: string) => w.includes("私聊")), "turning on DM reading counts as widening");
  const c = await form("console.yaml");
  c.values.web = { origin: "https://console.example.test" };
  ok((await preview("console.yaml", c.values, c.hash)).widened.some((w: string) => w.includes("公网入口")), "opening the public entrance counts as widening");
}

// ── stale hash ──
{
  const f = await form("repos.yaml");
  const raw = await call("GET", "/config/repos.yaml");
  ok((await call("PUT", "/config/repos.yaml", { text: raw.j.text.replace("develop", "release"), hash: raw.j.hash })).status === 200, "someone edits the file meanwhile");
  const text = onDisk("repos.yaml"), before = head();
  f.values.demo.branch = "other";
  ok((await preview("repos.yaml", f.values, f.hash)).stale === true, "preview says the file moved on");
  const r = await put("repos.yaml", f.values, f.hash);
  ok(r.status === 409 && /改过/.test(r.j.error) && !r.j.need_ack, "stale hash → 409 with the usual message");
  ok(onDisk("repos.yaml") === text && head() === before, "stale save writes nothing");
}

// ── values the schema refuses come back in words, on the right field ──
const BAD: [string, (v: any) => void, string[], RegExp][] = [
  ["gate.yaml", (v) => { v.expert_daily_limit = -1; }, ["expert_daily_limit"], /不能小于 0/],
  ["gate.yaml", (v) => { v.expert_daily_limit = 1.5; }, ["expert_daily_limit"], /整数/],
  ["gate.yaml", (v) => { v.attention.wait_minutes = 5000; }, ["attention", "wait_minutes"], /不能大于 1440/],
  ["jobs.yaml", (v) => { v.morning.at = "早上"; }, ["morning", "at"], /[一-鿿]/],
  ["console.yaml", (v) => { v.web = { origin: "http://plain.example.test/x" }; }, ["web", "origin"], /https:\/\/主机名/],
  ["sources.yaml", (v) => { v.sources.push({ id: "x y", kind: "fetch", url: "https://example.test" }); }, ["sources", 1, "id"], /小写字母开头/],
  ["sources.yaml", (v) => { v.sources.push({ id: "new-one", kind: "fetch" }); }, ["sources", 1, "url"], /[一-鿿]/],
  ["sources.yaml", (v) => { v.sources.push({ id: "notes", kind: "fetch", url: "https://example.test/b" }); }, ["sources"], /重复/],
  ["models.yaml", (v) => { v.tiers.work.endpoint = "nowhere"; }, ["tiers", "work", "endpoint"], /[一-鿿]/],
];
for (const [file, edit, path, msg] of BAD) {
  const f = await form(file), text = onDisk(file), name = `${file} ${path.join(".")}`;
  edit(f.values);
  const r = await put(file, f.values, f.hash);
  const e = r.j?.errors?.find((x: any) => JSON.stringify(x.path) === JSON.stringify(path));
  ok(r.status === 422 && !!e, `${name}: refused on that field${e ? "" : ` (${r.status} ${r.text.slice(0, 200)})`}`);
  ok(!!e && msg.test(e.message) && !!e.label && !/Invalid|Too small|Too big|expected/.test(e.message), `${name}: readable message (${e?.label}：${e?.message})`);
  ok(onDisk(file) === text, `${name}: nothing written`);
  ok((await preview(file, f.values, f.hash)).errors.length > 0, `${name}: preview shows it as well`);
}
{
  const f = await form("console.yaml");
  f.values.owners = ["someone-else@localhost"];
  const p = await preview("console.yaml", f.values, f.hash), r = await put("console.yaml", f.values, f.hash, p.widened);
  ok(r.status === 400 && /owners/.test(r.j.error) && parsed("console.yaml").owners.includes(OWNER), "the owner-lockout check in saveConfig still stands");
}

// ── keys the form doesn't know ──
{
  const f = await form("gate.yaml");
  ok(f.unknown.some((u: any) => u.path === "future_knob"), "gate: unknown top-level key is listed");
  const j = await form("jobs.yaml");
  ok(j.unknown.some((u: any) => u.path === "note_week.mystery"), "jobs: unknown key inside a row is listed");
  f.values.send_by_hours = 4; delete f.values.future_knob;
  ok((await put("gate.yaml", f.values, f.hash)).status === 200, "gate: saved without mentioning the unknown key");
  ok(parsed("gate.yaml").future_knob?.depth === 3 && onDisk("gate.yaml").includes("# 以后才有的项"), "gate: unknown key and its comment are still there");
  const g = await form("gate.yaml");
  g.values.smuggled = 1; g.values.future_knob = { depth: 9 };
  const r = await put("gate.yaml", g.values, g.hash);
  ok(r.status === 200 && r.j.changed === false && !("smuggled" in parsed("gate.yaml")) && parsed("gate.yaml").future_knob.depth === 3, "a draft can't write keys outside the description");
  j.values.note_week.text = "换一句话";
  ok((await put("jobs.yaml", j.values, j.hash)).status === 200 && parsed("jobs.yaml").note_week.mystery === 42, "jobs: unknown key in a row survives an edit of that row");
}

// ── lists and maps ──
{
  let f = await form("sources.yaml");
  f.values.sources.push({ id: "repo-feed", kind: "git", repo: "demo", every: "30m", domain: "work" });
  let p = await preview("sources.yaml", f.values, f.hash);
  ok(p.widened.some((w: string) => w.includes("repo-feed")), "a new source counts as widening");
  ok((await put("sources.yaml", f.values, f.hash, p.widened)).status === 200 && parsed("sources.yaml").sources.length === 2, "a source can be added");
  ok(onDisk("sources.yaml").includes("# 笔记网页"), "the comment on the first entry stays");
  f = await form("sources.yaml");
  f.values.sources = f.values.sources.filter((s: any) => s.id !== "repo-feed");
  ok((await put("sources.yaml", f.values, f.hash)).status === 200 && parsed("sources.yaml").sources.length === 1, "a source can be removed");
  const r = await form("repos.yaml");
  r.values.extra = { url: "https://example.test/team/extra.git" };
  p = await preview("repos.yaml", r.values, r.hash);
  ok(p.widened.some((w: string) => w.includes("extra")) && (await put("repos.yaml", r.values, r.hash, p.widened)).status === 200, "a repo can be added, as a widening");
  const partial = await form("repos.yaml");
  ok((await put("repos.yaml", { extra: { branch: "dev" } }, partial.hash)).status === 200 && !!parsed("repos.yaml").demo && parsed("repos.yaml").extra.branch === "dev", "a partial draft leaves the other entries alone");
  const gone = await form("repos.yaml");
  ok((await put("repos.yaml", { extra: null }, gone.hash)).status === 200 && !parsed("repos.yaml").extra && !!parsed("repos.yaml").demo, "null removes a map entry");
  const g = await form("groups.yaml");
  g.values.groups.oc_alpha.activation = null;
  ok((await put("groups.yaml", g.values, g.hash)).status === 200 && !parsed("groups.yaml").groups?.oc_alpha, "back to 默认 drops a group entry that holds only a name");
}

// ── pausing a job ──
{
  ok(typeof (await form("jobs.yaml")).context.jobs.morning.next === "number", "a job shows its next run before anything is edited");
  ok("note_week" in jobsConf(), "the job runs while enabled");
  const f = await form("jobs.yaml");
  f.values.note_week.enabled = false;
  const p = await preview("jobs.yaml", f.values, f.hash);
  ok(p.computed.next.note_week === null && typeof p.computed.next.morning === "number", "preview: a paused job has no next run, the others do");
  ok((await put("jobs.yaml", f.values, f.hash, p.widened)).status === 200 && parsed("jobs.yaml").note_week.at === "09:00", "paused, settings kept");
  ok(!("note_week" in jobsConf()) && "morning" in jobsConf(), "a paused job is gone from the schedule");
}

// ── secrets stay write-only ──
{
  const m = await call("GET", "/config/models.yaml/form"), s = await call("GET", "/config/sources.yaml/form");
  ok(m.j.context.options.secrets.some((x: any) => x.value === "UPSTREAM_AUTH"), "models: secret names are offered");
  ok(!m.text.includes(SECRET_VALUE) && !s.text.includes(SECRET_VALUE), "secret values are never in a form");
  const names = s.j.context.options.plugin_secrets.map((x: any) => x.value);
  ok(names.includes("PLUGIN_TOKEN") && !names.includes("UPSTREAM_AUTH"), "a plugin can't be offered a model key");
  ok(!sent().includes(SECRET_VALUE), "no secret value reached Feishu");
}

// ── a broken file: the form steps aside. saveConfig can't compare against it either, so the repair happens on the server ──
{
  writeFileSync(join(P.config, "repos.yaml"), "demo: [unclosed\n");
  const f = await form("repos.yaml");
  ok(!!f.broken, "a file that doesn't parse is reported");
  const r = await put("repos.yaml", {}, f.hash);
  ok(r.status === 400 && /服务器/.test(r.j.error) && onDisk("repos.yaml") === "demo: [unclosed\n", "the form refuses and says where to fix it");
  writeFileSync(join(P.config, "repos.yaml"), "demo:\n  url: https://example.test/team/demo.git\n");
  commitIfDirty(P.config, "repaired by hand");
  ok(!(await form("repos.yaml")).broken, "the form is back once the file is repaired");
}

// ── a file that doesn't exist yet: its defaults show, the first save creates it ──
{
  rmSync(join(P.config, "gate.yaml"));
  commitIfDirty(P.config, "gate.yaml removed");
  const f = await form("gate.yaml");
  ok(f.exists === false && !f.broken && Object.keys(f.values).length === 0, "a missing file opens as an empty form");
  const words = f.spec.sections.flatMap((s: any) => s.fields).find((x: any) => x.key === "sensitive_words").default;
  const p = await preview("gate.yaml", { sensitive_words: words.slice(1) }, f.hash);
  ok(p.widened.some((w: string) => w.includes(words[0])), "dropping a default sensitive word counts as widening even with no file");
  const r = await put("gate.yaml", { proactive_daily_cap: 3 }, f.hash);
  ok(r.status === 200 && r.j.changed === true && r.j.exists === true && parsed("gate.yaml").proactive_daily_cap === 3, "the first save creates the file");
  ok(Object.keys(parsed("gate.yaml")).length === 1 && subject() === "gate.yaml: edit (via console)", "with only what was set, committed the usual way");
}

ok(all("SELECT file FROM config_changes WHERE source<>'console'").length === 0, "every recorded change came through the console path");
ok(!sent().includes("undefined"), "no notice printed undefined");
srv?.close?.();
realLog(process.exitCode ? "SOME FAILED" : "ALL PASS");
process.exit(process.exitCode ?? 0);
