// Console entrances smoke (DESIGN §触5.1) on the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh console-web-smoke.ts 7831
//
// No model, no nginx. Starts both entrances on sockets inside the test home and talks to them directly, the way
// tailscale serve and nginx would. Uses its own secrets file in the test home (never the real secrets.env).
//   tailnet: no header / not an owner / write without the CSRF header → 403; a web session cookie counts for nothing
//   web: forged Tailscale-User-Login, no cookie, bad mac, other key, expired, future → refused; login needs our Origin
//        and the right password, rate-limited per IP and overall; writes need cookie + Origin + CSRF header; the
//        password secrets can't be set from the console; no web.origin → 404; console-passwd rotates sessions

import http from "node:http";
import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HOME = process.env.SBOT_HOME ?? "";
if (!HOME || HOME === "/srv/sbot" || !/testhomes|tmp/.test(HOME)) { console.error("run on a throwaway SBOT_HOME (see vps-test-home.sh)"); process.exit(2); }
const SOCKS = join(HOME, "socks");
mkdirSync(join(SOCKS, "tn"), { recursive: true }); mkdirSync(join(SOCKS, "web"), { recursive: true });
process.env.SBOT_SECRETS = join(HOME, "secrets-test.env");
process.env.SBOT_CONSOLE_SOCK = join(SOCKS, "tn", "console.sock");
process.env.SBOT_CONSOLE_WEB_SOCK = join(SOCKS, "web", "console.sock");
delete process.env.SBOT_CONSOLE_PORT;
writeFileSync(process.env.SBOT_SECRETS, "", { mode: 0o600 });

// everything the core logs during the test, to check no password or cookie ever lands in a log line
const logged: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
const ok = (cond: unknown, what: string) => { realLog(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };

const here = dirname(fileURLToPath(import.meta.url));
const { P, writeSecret, secret } = await import("../src/config.ts");
const { ensureAgentHome } = await import("../src/memory.ts");
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
const W = await import("../src/console-web.ts");
const { startConsole } = await import("../src/console.ts");

const ORIGIN = "https://console.example.test", PW = "correct horse battery", OWNER = "owner@localhost";
const consoleYaml = join(P.config, "console.yaml");
const setConsoleYaml = (web: boolean) => writeFileSync(consoleYaml, `owners: [${OWNER}]\n${web ? `web:\n  origin: ${ORIGIN}\n` : ""}`);
setConsoleYaml(true);
writeSecret(W.PASS_SECRET, await W.hashPassword(PW));
writeSecret(W.KEY_SECRET, "k".repeat(64));

const srv = startConsole({ startedAt: Date.now() });
await new Promise((r) => setTimeout(r, 300));
const TN = process.env.SBOT_CONSOLE_SOCK!, WEB = process.env.SBOT_CONSOLE_WEB_SOCK!;

type Res = { status: number; headers: http.IncomingHttpHeaders; text: string };
function call(sock: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sock, method, path, headers: { ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const form = (pw: string) => `password=${encodeURIComponent(pw)}`;
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const login = (pw: string, h: Record<string, string> = {}) => call(WEB, "POST", "/_auth", { ...FORM, origin: ORIGIN, ...h }, form(pw));
const ck = (v: string) => ({ cookie: `${W.COOKIE}=${v}` });
const putSecret = (sock: string, name: string, h: Record<string, string>) =>
  call(sock, "PUT", `/api/secrets/${name}`, { "content-type": "application/json", ...h }, JSON.stringify({ value: "test-value" }));

// ───────── sockets ─────────
ok((statSync(TN).mode & 0o777) === 0o600, "tailnet socket is 0600");
ok((statSync(WEB).mode & 0o777) === 0o660, "web socket is 0660 (the directory's group decides who gets in)");

// ───────── tailnet entrance: unchanged ─────────
ok((await call(TN, "GET", "/api/me")).status === 403, "tailnet: no Tailscale-User-Login → 403");
ok((await call(TN, "GET", "/api/me", { "tailscale-user-login": "intruder@localhost" })).status === 403, "tailnet: login not in owners → 403");
const tme = await call(TN, "GET", "/api/me", { "tailscale-user-login": OWNER });
ok(tme.status === 200 && JSON.parse(tme.text).entry === "tailnet" && JSON.parse(tme.text).login === OWNER, "tailnet: owner → 200, entry tailnet");
ok(tme.headers["referrer-policy"] === "no-referrer", "tailnet: Referrer-Policy still no-referrer");
ok((await putSecret(TN, "SBOT_TEST_A", { "tailscale-user-login": OWNER })).status === 403, "tailnet: write without x-sbot-console → 403");
ok((await putSecret(TN, "SBOT_TEST_A", { "tailscale-user-login": OWNER, "x-sbot-console": "1" })).status === 200 && secret("SBOT_TEST_A") === "test-value", "tailnet: owner write with CSRF header → 200");
const goodCookie = W.signSession("k".repeat(64));
ok((await call(TN, "GET", "/api/me", ck(goodCookie))).status === 403, "tailnet: a valid web session cookie alone → 403");
ok((await call(TN, "GET", "/_login")).status === 403, "tailnet: no login page there");

// ───────── web entrance: who you are ─────────
ok((await call(WEB, "GET", "/api/me")).status === 401, "web: no cookie → 401");
ok((await call(WEB, "GET", "/api/me", { "tailscale-user-login": OWNER })).status === 401, "web: forged Tailscale-User-Login (owner) → 401");
ok((await call(WEB, "GET", "/api/me", { "tailscale-user-login": OWNER, "x-sbot-console": "1", "x-real-ip": "127.0.0.1" })).status === 401, "web: forged identity-ish headers together → 401");
const root = await call(WEB, "GET", "/", { "tailscale-user-login": OWNER });
ok(root.status === 303 && root.headers.location === "/_login", "web: page without cookie → 303 /_login");
const lp = await call(WEB, "GET", "/_login");
ok(lp.status === 200 && /type="password"/.test(lp.text) && /default-src 'none'/.test(String(lp.headers["content-security-policy"])), "web: login page with strict CSP");

const [, , mac] = goodCookie.split(".");
const flipped = goodCookie.slice(0, -1) + (goodCookie.endsWith("0") ? "1" : "0");
ok((await call(WEB, "GET", "/api/me", ck(flipped))).status === 401, "web: cookie with a wrong mac → 401");
ok((await call(WEB, "GET", "/api/me", ck(W.signSession("x".repeat(64))))).status === 401, "web: cookie signed with another key → 401");
ok((await call(WEB, "GET", "/api/me", ck(W.signSession("k".repeat(64), Date.now() - W.TTL * 1000 - 5000)))).status === 401, "web: expired cookie → 401");
ok((await call(WEB, "GET", "/api/me", ck(W.signSession("k".repeat(64), Date.now() + 3600_000)))).status === 401, "web: cookie from the future → 401");
ok((await call(WEB, "GET", "/api/me", ck(`${Math.floor(Date.now() / 1000)}.${"0".repeat(32)}.${mac}`))).status === 401, "web: mac moved onto another nonce → 401");
ok((await call(WEB, "GET", "/api/me", { cookie: `sbot_console=${goodCookie}` })).status === 401, "web: right value under another cookie name → 401");
const wme = await call(WEB, "GET", "/api/me", ck(goodCookie));
ok(wme.status === 200 && JSON.parse(wme.text).entry === "web" && JSON.parse(wme.text).login === W.WEB_LOGIN, "web: valid cookie → 200, entry web");
ok(wme.headers["referrer-policy"] === "same-origin", "web: Referrer-Policy same-origin (so writes carry a real Origin)");

// ───────── web entrance: logging in ─────────
W.resetLimiter();
ok((await login(PW, { origin: "https://evil.example.test" })).status === 403, "login: foreign Origin → 403");
ok((await call(WEB, "POST", "/_auth", FORM, form(PW))).status === 403, "login: no Origin → 403");
ok((await call(WEB, "POST", "/_auth", { ...FORM, origin: "null" }, form(PW))).status === 403, "login: Origin null → 403");
ok((await call(WEB, "POST", "/_auth", { "content-type": "text/plain", origin: ORIGIN }, form(PW))).status === 400, "login: not a form post → 400");
ok((await login("wrong password!!")).status === 401, "login: wrong password → 401");
const good = await login(PW);
const sc = String(good.headers["set-cookie"] ?? "");
ok(good.status === 303 && good.headers.location === "/", "login: right password → 303 /");
ok(sc.startsWith(`${W.COOKIE}=`) && /; Secure/.test(sc) && /; HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\//.test(sc) && !/Domain=/i.test(sc), "login: cookie is __Host-, Secure, HttpOnly, SameSite=Strict, no Domain");
const issued = sc.split(";")[0].split("=").slice(1).join("=");
ok((await call(WEB, "GET", "/api/me", ck(issued))).status === 200, "login: the issued cookie works");
ok((await call(WEB, "GET", "/_login", ck(issued))).status === 303, "login: login page with a session → back to /");

W.resetLimiter();
for (let i = 0; i < 10; i++) await login("nope nope nope", { "x-real-ip": "203.0.113.7" });
ok((await login(PW, { "x-real-ip": "203.0.113.7" })).status === 429, "limit: 10 misses from one IP → even the right password gets 429");
ok((await login("nope nope nope", { "x-real-ip": "198.51.100.9" })).status === 401, "limit: another IP is still let through to the check");
W.resetLimiter();
for (let i = 0; i < 30; i++) await login("nope nope nope", { "x-real-ip": `198.51.100.${i + 10}` });
ok((await login(PW, { "x-real-ip": "192.0.2.1" })).status === 429, "limit: 30 misses overall → everyone waits (X-Real-IP can be forged locally)");
W.resetLimiter();

// ───────── web entrance: writes ─────────
const C = ck(issued);
ok((await putSecret(WEB, "SBOT_TEST_B", { ...C, "x-sbot-console": "1" })).status === 403, "write: cookie + CSRF header, no Origin → 403");
ok((await putSecret(WEB, "SBOT_TEST_B", { ...C, origin: ORIGIN })).status === 403, "write: cookie + Origin, no CSRF header → 403");
ok((await putSecret(WEB, "SBOT_TEST_B", { ...C, origin: "https://evil.example.test", "x-sbot-console": "1" })).status === 403, "write: foreign Origin → 403");
ok((await putSecret(WEB, "SBOT_TEST_B", { "tailscale-user-login": OWNER, origin: ORIGIN, "x-sbot-console": "1" })).status === 401, "write: forged Tailscale header instead of a cookie → 401");
ok(secret("SBOT_TEST_B") === undefined, "write: none of those wrote anything");
ok((await putSecret(WEB, "SBOT_TEST_B", { ...C, origin: ORIGIN, "x-sbot-console": "1" })).status === 200 && secret("SBOT_TEST_B") === "test-value", "write: cookie + Origin + CSRF header → 200");
const hashBefore = secret(W.PASS_SECRET);
for (const sock of [WEB, TN]) {
  const h = sock === WEB ? { ...C, origin: ORIGIN, "x-sbot-console": "1" } : { "tailscale-user-login": OWNER, "x-sbot-console": "1" };
  ok((await putSecret(sock, W.PASS_SECRET, h)).status === 400 && (await putSecret(sock, W.KEY_SECRET, h)).status === 400, `${sock === WEB ? "web" : "tailnet"}: password hash / session key can't be set from the console`);
}
ok(secret(W.PASS_SECRET) === hashBefore, "the password hash is untouched");

// ───────── switching it off, rotating sessions ─────────
setConsoleYaml(false);
ok((await call(WEB, "GET", "/api/me", C)).status === 404 && (await call(WEB, "GET", "/_login")).status === 404, "no web.origin → the public entrance answers 404, even with a valid cookie");
ok((await call(TN, "GET", "/api/me", { "tailscale-user-login": OWNER })).status === 200, "… and the tailnet entrance keeps working");
setConsoleYaml(true);

const NEWPW = "another long passphrase";
const cli = spawnSync(process.execPath, [join(here, "..", "src", "console-passwd.ts")], { input: NEWPW + "\n", env: process.env, encoding: "utf8" });
ok(cli.status === 0 && !cli.stdout.includes(NEWPW) && !cli.stderr.includes(NEWPW), "console-passwd: sets the password, never prints it");
ok(/^pbkdf2_sha256\$\d+\$/.test(readFileSync(process.env.SBOT_SECRETS!, "utf8").match(/CONSOLE_WEB_PASSWORD_HASH=(.*)/)?.[1] ?? ""), "secrets.env holds a hash, not the password");
ok(!readFileSync(process.env.SBOT_SECRETS!, "utf8").includes(NEWPW), "… and the password itself is nowhere in it");
ok((await call(WEB, "GET", "/api/me", C)).status === 401, "console-passwd: the old session is gone");
ok((await login(PW)).status === 401 && (await login(NEWPW)).status === 303, "console-passwd: old password refused, new one works");
const short = spawnSync(process.execPath, [join(here, "..", "src", "console-passwd.ts")], { input: "short\n", env: process.env, encoding: "utf8" });
ok(short.status !== 0, "console-passwd: refuses a short password");
const s2 = String((await login(NEWPW)).headers["set-cookie"]).split(";")[0].split("=").slice(1).join("=");
spawnSync(process.execPath, [join(here, "..", "src", "console-passwd.ts"), "--logout-all"], { env: process.env, encoding: "utf8" });
ok((await call(WEB, "GET", "/api/me", ck(s2))).status === 401 && (await login(NEWPW)).status === 303, "--logout-all: sessions gone, password kept");

// ───────── logs ─────────
const all = logged.join("\n");
ok(!all.includes(PW) && !all.includes(NEWPW) && !all.includes(issued) && !all.includes("k".repeat(64)), "no password, cookie or key in any log line");
ok(/web login failed/.test(all) && /"ip":"203\.0\.\*\.\*"/.test(all), "failed logins are logged with a masked IP");

srv.close();
realLog(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
