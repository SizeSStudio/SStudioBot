// Console response plumbing smoke (DESIGN §10.5) on the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh console-perf-smoke.ts 7830
//
// No model, no nginx: talks to both sockets directly, the way tailscale serve and nginx would.
//   static: strong ETag per encoding, 304 for any encoding of the same content, new ETag when the file changes, auth first
//   compression: br / gzip decode to the same bytes, q=0 honoured, small and SSE responses left alone
//   SSE: every connection gets the same computed status
//   git reads: cached until the branch moves, by any kind of commit; config text and its hash are never cached

import http from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const HOME = process.env.SBOT_HOME ?? "";
if (!HOME || HOME === "/srv/sbot" || !/testhomes|tmp/.test(HOME)) { console.error("run on a throwaway SBOT_HOME (see vps-test-home.sh)"); process.exit(2); }
const SOCKS = join(HOME, "socks");
mkdirSync(join(SOCKS, "tn"), { recursive: true }); mkdirSync(join(SOCKS, "web"), { recursive: true });
process.env.SBOT_SECRETS = join(HOME, "secrets-test.env");
process.env.SBOT_CONSOLE_SOCK = join(SOCKS, "tn", "console.sock");
process.env.SBOT_CONSOLE_WEB_SOCK = join(SOCKS, "web", "console.sock");
delete process.env.SBOT_CONSOLE_PORT;
writeFileSync(process.env.SBOT_SECRETS, "", { mode: 0o600 });

const realLog = console.log;
console.log = () => {};
const ok = (cond: unknown, what: string) => { realLog(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };

const here = dirname(fileURLToPath(import.meta.url)), STATIC = join(here, "..", "console");
const { P, writeSecret } = await import("../src/config.ts");
const { ensureAgentHome, git, gitRead, commitIfDirty } = await import("../src/memory.ts");
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
if (!existsSync(join(P.config, ".git"))) { git(P.config, "init", "-q", "-b", "main"); commitIfDirty(P.config, "initial config"); }
const W = await import("../src/console-web.ts");
const { startConsole } = await import("../src/console.ts");

const ORIGIN = "https://console.example.test", PW = "correct horse battery", OWNER = "owner@localhost";
// padded so its JSON is well over the compression threshold on a fresh home
writeFileSync(join(P.config, "console.yaml"), `owners: [${OWNER}]\nweb:\n  origin: ${ORIGIN}\n${"# padding\n".repeat(300)}`);
writeSecret(W.PASS_SECRET, await W.hashPassword(PW));
writeSecret(W.KEY_SECRET, "k".repeat(64));
commitIfDirty(P.config, "console.yaml");

const srv = startConsole({ startedAt: Date.now() });
await new Promise((r) => setTimeout(r, 300));
const TN = process.env.SBOT_CONSOLE_SOCK!, WEB = process.env.SBOT_CONSOLE_WEB_SOCK!;
const ME = { "tailscale-user-login": OWNER };

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
function call(path: string, headers: Record<string, string> = {}, o: { sock?: string; method?: string; send?: string; who?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: o.sock ?? TN, method: o.method ?? "GET", path, headers: { ...(o.who ?? ME), ...(o.send ? { "content-length": String(Buffer.byteLength(o.send)) } : {}), ...headers } }, (res) => {
      const c: Buffer[] = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on("error", reject);
    if (o.send) r.write(o.send);
    r.end();
  });
}
const decoded = (r: Res) => r.headers["content-encoding"] === "br" ? brotliDecompressSync(r.body) : r.headers["content-encoding"] === "gzip" ? gunzipSync(r.body) : r.body;
const until = async (f: () => Promise<boolean>, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

// ── static ──
const file = readFileSync(join(STATIC, "lib", "core.js"));
ok(await until(async () => (await call("/lib/core.js", { "accept-encoding": "br" })).headers["content-encoding"] === "br"), "brotli for a module is ready soon after startup");
ok(await until(async () => (await call("/lib/core.js", { "accept-encoding": "gzip" })).headers["content-encoding"] === "gzip"), "gzip too");
const plain = await call("/lib/core.js"), br = await call("/lib/core.js", { "accept-encoding": "gzip, deflate, br" }), gz = await call("/lib/core.js", { "accept-encoding": "gzip" });
ok(plain.status === 200 && !plain.headers["content-encoding"] && plain.body.equals(file), "no Accept-Encoding: the file as is");
ok(br.headers["content-encoding"] === "br" && br.body.length < file.length / 2 && decoded(br).equals(file), "br decodes to the same bytes and is much smaller");
ok(gz.headers["content-encoding"] === "gzip" && decoded(gz).equals(file), "gzip decodes to the same bytes");
ok(new Set([plain, br, gz].map((r) => r.headers.etag)).size === 3 && [plain, br, gz].every((r) => /^"[0-9a-f]{24}(-br|-gz)?"$/.test(String(r.headers.etag))), "a strong ETag per encoding");
ok(br.headers.vary === "Accept-Encoding" && br.headers["cache-control"] === "no-cache" && Number(br.headers["content-length"]) === br.body.length, "Vary, no-cache and the compressed length");
ok(br.headers["content-security-policy"] === plain.headers["content-security-policy"] && !!br.headers["content-security-policy"] && br.headers["x-content-type-options"] === "nosniff", "security headers unchanged");
ok((await call("/lib/core.js", { "accept-encoding": "br;q=0, gzip" })).headers["content-encoding"] === "gzip", "br;q=0 is not used");
ok(!(await call("/lib/core.js", { "accept-encoding": "identity" })).headers["content-encoding"], "identity only: not compressed");

const nm = await call("/lib/core.js", { "accept-encoding": "br", "if-none-match": String(br.headers.etag) });
ok(nm.status === 304 && nm.body.length === 0 && nm.headers.etag === br.headers.etag, "matching ETag → 304, empty");
ok(!!nm.headers["content-security-policy"] && nm.headers["cache-control"] === "no-cache" && nm.headers.vary === "Accept-Encoding", "304 keeps the security and cache headers");
ok((await call("/lib/core.js", { "accept-encoding": "br", "if-none-match": String(gz.headers.etag) })).status === 304, "another encoding of the same content → 304");
ok((await call("/lib/core.js", { "if-none-match": `"x", W/${plain.headers.etag}` })).status === 304, "weak form inside a list → 304");
ok((await call("/lib/core.js", { "if-none-match": '"000000000000000000000000"' })).status === 200, "other ETag → 200");
ok((await call("/", { "accept-encoding": "br" })).headers["content-type"]?.startsWith("text/html"), "/ is the shell");
ok(decoded(await call("/some/route", { "accept-encoding": "gzip" })).toString().includes('rel="modulepreload"'), "route-like path still gets the shell, with modulepreload");
for (const m of [...readFileSync(join(STATIC, "index.html"), "utf8").matchAll(/rel="modulepreload" href="([^"]+)"/g)]) ok((await call(m[1])).status === 200, `preload ${m[1]} exists`);
ok((await call("/lib/nope.js")).status === 404, "missing module is still a 404");
ok(!(await call("/../src/config.ts")).body.toString().includes("SBOT_SECRETS"), "no way out of the static directory");

const tmp = join(STATIC, "_perf_test.js");
writeFileSync(tmp, "// one\n".repeat(400));
const v1 = await call("/_perf_test.js");
writeFileSync(tmp, "// two, longer\n".repeat(400));
const v2 = await call("/_perf_test.js", { "if-none-match": String(v1.headers.etag) });
ok(v2.status === 200 && v2.headers.etag !== v1.headers.etag && v2.body.toString().includes("two"), "a changed file gets a new ETag and the old one stops matching");
rmSync(tmp);
ok((await call("/_perf_test.js")).status === 404, "a removed file is gone");

// ── auth still comes first ──
const anon = await call("/lib/core.js", { "if-none-match": String(plain.headers.etag) }, { who: {} });
ok(anon.status === 403 && !anon.headers.etag, "tailnet without identity: 403, no ETag, even with a valid If-None-Match");
const webAnon = await call("/lib/core.js", { "if-none-match": String(plain.headers.etag) }, { sock: WEB, who: {} });
ok(webAnon.status === 303 && !webAnon.headers.etag, "web without a session: login redirect, not 304");
const login = await call("/_auth", { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "x-real-ip": "198.51.100.7" }, { sock: WEB, who: {}, method: "POST", send: `password=${encodeURIComponent(PW)}` });
const cookie = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0];
ok(!!cookie, "web login works");
const webHit = await call("/lib/core.js", { cookie, "accept-encoding": "br", "if-none-match": String(br.headers.etag) }, { sock: WEB, who: {} });
ok(webHit.status === 304 && webHit.headers["referrer-policy"] === "same-origin", "web entrance: 304 with its own headers");

// ── JSON ──
const BIG = "/api/config/console.yaml";
const st = await call(BIG, { "accept-encoding": "br" }), stGz = await call(BIG, { "accept-encoding": "gzip" }), stPlain = await call(BIG);
ok(st.headers["content-encoding"] === "br" && st.body.length < stPlain.body.length && decoded(st).equals(stPlain.body), "JSON in br decodes to the same bytes");
ok(stGz.headers["content-encoding"] === "gzip" && decoded(stGz).equals(stPlain.body), "JSON in gzip too");
ok(!stPlain.headers["content-encoding"] && !!JSON.parse(stPlain.body.toString()).text, "plain without Accept-Encoding");
ok(st.headers["cache-control"] === "no-store" && st.headers.vary === "Accept-Encoding" && !!st.headers["content-security-policy"], "JSON stays no-store, with security headers");
ok(!(await call("/api/me", { "accept-encoding": "br" })).headers["content-encoding"], "tiny JSON is left alone");
const nf = await call("/api/nope", { "accept-encoding": "br" });
ok(nf.status === 404 && !!JSON.parse(decoded(nf).toString()).error, "errors are still JSON with their status");

// ── SSE ──
function sse(ms: number) {
  return new Promise<{ headers: http.IncomingHttpHeaders; nows: number[]; flow: number; first: number }>((resolve, reject) => {
    const t0 = Date.now(); let text = "", first = 0;
    const r = http.request({ socketPath: TN, path: "/api/events", headers: { ...ME, "accept-encoding": "br, gzip" } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => { if (!first) first = Date.now() - t0; text += c; });
      setTimeout(() => {
        const nows = [...text.matchAll(/event: status\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).now);
        resolve({ headers: res.headers, nows, flow: (text.match(/event: flow/g) ?? []).length, first }); r.destroy();
      }, ms);
    });
    r.on("error", (e: any) => { if (e.code !== "ECONNRESET") reject(e); });
    r.end();
  });
}
const streams = await Promise.all([sse(7500), sse(7500), sse(7500)]);
ok(streams.every((s) => s.headers["content-type"] === "text/event-stream" && !s.headers["content-encoding"]), "SSE is never compressed");
ok(streams.every((s) => s.first < 1500 && s.nows.length >= 2 && s.flow === 1), "each stream gets status at once, then ticks, and the flow head once");
const sets = streams.map((s) => s.nows.slice(-2).join());
ok(new Set(sets).size === 1, "all streams carry the same computed status (one status() per tick)");
const late = await sse(500);
ok(late.nows.length === 1 && late.first < 1500, "a stream opened after the others closed starts again");

// ── git reads ──
const repo = join(HOME, "gitread"); mkdirSync(repo);
git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "a"), "1"); commitIfDirty(repo, "one");
git(repo, "config", "x.y", "1");
ok(gitRead(repo, "config", "x.y").trim() === "1", "first read runs git");
git(repo, "config", "x.y", "2");
ok(gitRead(repo, "config", "x.y").trim() === "1", "second read comes from the cache");
writeFileSync(join(repo, "a"), "2"); commitIfDirty(repo, "two");
ok(gitRead(repo, "config", "x.y").trim() === "2", "a commit invalidates it");
git(repo, "config", "x.y", "3"); gitRead(repo, "config", "x.y"); git(repo, "config", "x.y", "4");
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "by hand"]);
ok(gitRead(repo, "config", "x.y").trim() === "4", "so does a commit made outside the core");
git(repo, "config", "x.y", "5"); gitRead(repo, "config", "x.y"); git(repo, "config", "x.y", "6"); git(repo, "pack-refs", "--all");
ok(gitRead(repo, "config", "x.y").trim() === "6", "and packing refs (a miss, never a stale answer)");
let threw = false; try { gitRead(repo, "log", "--no-such-flag"); } catch { threw = true; }
ok(threw, "a failing command still throws");

const log = async () => JSON.parse((await call("/api/memory/log")).body.toString());
const before = await log();
writeFileSync(join(P.agentHome, "perf-test.md"), "x"); commitIfDirty(P.agentHome, "perf: new commit");
const after = await log();
ok(after[0].subject === "perf: new commit" && after.length === before.length + 1, "memory log shows a new commit at once");
git(P.agentHome, "revert", "--no-edit", "HEAD");
ok((await log())[0].subject.startsWith("Revert "), "and a revert");

const cfg = async () => JSON.parse((await call("/api/config/console.yaml")).body.toString());
const c1 = await cfg();
writeFileSync(join(P.config, "console.yaml"), c1.text + "# edited by hand\n");
const c2 = await cfg();
ok(c2.text.includes("edited by hand") && c2.hash !== c1.hash, "config text and hash are read fresh, uncommitted edits included");
const stale = await call("/api/config/console.yaml", { "x-sbot-console": "1", "content-type": "application/json" }, { method: "PUT", send: JSON.stringify({ text: c1.text + "# x\n", hash: c1.hash }) });
ok(stale.status === 409, "a save against the old hash is still refused");
const saved = await call("/api/config/console.yaml", { "x-sbot-console": "1", "content-type": "application/json" }, { method: "PUT", send: JSON.stringify({ text: c2.text + "# saved\n", hash: c2.hash }) });
const s = JSON.parse(saved.body.toString());
ok(saved.status === 200 && s.history[0].subject.includes("via console"), "a save shows up in history at once");

srv.close();
realLog(process.exitCode ? "SOME FAILED" : "ALL PASSED");
process.exit(process.exitCode ?? 0);
