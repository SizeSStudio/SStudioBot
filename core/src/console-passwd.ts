// Set the console's public-entrance password (DESIGN §触5.1), on the server, as sbot:
//
//   sudo -u sbot env SBOT_HOME=/srv/sbot /opt/node/bin/node /srv/data/sbot-app/current/core/src/console-passwd.ts
//   … --logout-all     keep the password, only log every session out
//
// Stores a PBKDF2 hash and a fresh session key in secrets.env. A new key invalidates every existing session cookie, so
// running this again is also "log everyone out". The password is read without echo and never printed or logged.

import { randomBytes } from "node:crypto";

const { writeSecret, secret } = await import("./config.ts");
const { hashPassword, PASS_SECRET, KEY_SECRET, webOrigin } = await import("./console-web.ts");

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // piped: first line only
    return new Promise((resolve) => {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => { buf += c; });
      stdin.on("end", () => resolve(buf.split("\n")[0].replace(/\r$/, "")));
    });
  }
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let buf = "";
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    const onData = (c: string) => {
      for (const ch of c) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stderr.write("\n"); return resolve(buf); }
        if (ch === "\u0003") { process.stderr.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1); else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const newKey = () => randomBytes(32).toString("hex");

if (process.argv.includes("--logout-all")) {
  if (!secret(PASS_SECRET)) { console.error("还没设过密码。"); process.exit(1); }
  writeSecret(KEY_SECRET, newKey());
  console.log("已换会话密钥：所有公网入口的会话都已失效。");
  process.exit(0);
}

const pw = await readHidden("控制台公网入口的新密码（至少 12 位）：");
if (pw.length < 12 || pw.length > 256 || /[\r\n\0]/.test(pw)) { console.error("密码要 12～256 个字符、一行。"); process.exit(1); }
if (process.stdin.isTTY && await readHidden("再输一遍：") !== pw) { console.error("两次不一样，没改。"); process.exit(1); }

writeSecret(PASS_SECRET, await hashPassword(pw));
writeSecret(KEY_SECRET, newKey());
console.log("已设密码（secrets.env 里只存哈希），并换了会话密钥：已有的会话都已失效。");
if (!webOrigin()) console.log("提示：config/console.yaml 还没有 web.origin，公网入口仍是关的。");
