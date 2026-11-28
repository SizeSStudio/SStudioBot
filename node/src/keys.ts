// The device key (05 「安装和配对」, 06). Ed25519, made on this machine; only the public key ever leaves it (in the
// signed `pair` frame). The private key is never printed, logged, put in an environment variable or an argv:
//   Linux (and anything else): <config>/device.key, 0600, in a 0700 directory
//   Mac: the login keychain (service sbot-node), written and read through `security -i` on stdin
//   Windows: DPAPI-encrypted file (current user) through PowerShell on stdin ※ — any process of the same user can
//            decrypt it, as §底3.8 says for that row
// SBOT_NODE_KEYSTORE=file forces the file (tests, a headless Mac without a keychain).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceIdOf } from "../../protocol/pair.ts";
import { ensureDir } from "./config.ts";
import type { Signer } from "./link.ts";

const SERVICE = "sbot-node";

type Store = { read(): string | undefined; write(secret: string): void; remove(): void; where: string };

function fileStore(dir: string): Store {
  const f = join(dir, "device.key");
  return {
    where: f,
    read: () => (existsSync(f) ? readFileSync(f, "utf8").trim() : undefined),
    write: (s) => {
      ensureDir(dir);
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, s, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, f);
    },
    remove: () => { if (existsSync(f)) unlinkSync(f); },
  };
}

/** `security -i` reads commands from stdin, so the secret is in no process's argv. */
function keychainStore(account: string): Store {
  const q = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;
  const run = (cmd: string) => spawnSync("security", ["-i"], { input: `${cmd}\n`, encoding: "utf8", timeout: 20_000 });
  return {
    where: `keychain ${SERVICE}/${account}`,
    read: () => {
      const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8", timeout: 20_000 });
      return r.status === 0 ? r.stdout.trim() || undefined : undefined;
    },
    write: (s) => {
      if (!/^[A-Za-z0-9+/=]+$/.test(s)) throw new Error("bad key encoding");
      const r = run(`add-generic-password -U -s ${q(SERVICE)} -a ${q(account)} -l ${q("SStudioBot node device key")} -w ${q(s)}`);
      if (r.status !== 0) throw new Error("钥匙串写不进去（security 失败）");
    },
    remove: () => { spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { timeout: 20_000 }); },
  };
}

/** DPAPI through PowerShell; the secret goes in and out on stdin/stdout only. */
function dpapiStore(dir: string): Store {
  const f = join(dir, "device.key.dpapi");
  const ps = (script: string, input?: string) => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", timeout: 20_000 });
  const lit = (p: string) => `'${p.replace(/'/g, "''")}'`;
  return {
    where: f,
    read: () => {
      if (!existsSync(f)) return undefined;
      const r = ps(`Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes(${lit(f)}); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')))`);
      return r.status === 0 ? r.stdout.trim() || undefined : undefined;
    },
    write: (s) => {
      ensureDir(dir);
      const r = ps(`Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); [IO.File]::WriteAllBytes(${lit(f)}, [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,'CurrentUser'))`, s);
      if (r.status !== 0) throw new Error("DPAPI 写不进去");
    },
    remove: () => { if (existsSync(f)) unlinkSync(f); },
  };
}

export function keyStore(configDir: string, env = process.env): Store {
  if (env.SBOT_NODE_KEYSTORE === "file") return fileStore(configDir);
  if (process.platform === "darwin") return keychainStore(configDir);   // one entry per config dir (tests, two nodes)
  if (process.platform === "win32") return dpapiStore(configDir);
  return fileStore(configDir);
}

function signer(priv: KeyObject): Signer {
  const publicKey = new Uint8Array(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { publicKey, deviceId: deviceIdOf(publicKey), sign: (m) => new Uint8Array(sign(null, m, priv)) };
}

/** The key that is there; undefined before pairing. */
export function loadKey(store: Store): Signer | undefined {
  const s = store.read();
  if (!s) return undefined;
  return signer(createPrivateKey({ key: Buffer.from(s, "base64"), format: "der", type: "pkcs8" }));
}

/**
 * A fresh key for a new pairing, held in memory until `save()`: pairing saves it only once the hub accepted, so a
 * refused re-pair leaves the working pairing (key and hub.json) as it was.
 */
export function freshKey(store: Store): Signer & { save(): void } {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { ...signer(privateKey), save: () => store.write(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")) };
}

/** A fresh key, saved at once (replaces any old one: re-pairing is a new device, 06). */
export function newKey(store: Store): Signer {
  const k = freshKey(store);
  k.save();
  return k;
}
