// Writes a throwaway test home: hub key, relay allowlist + token, N device identities and the hub's devices.json.
//   node bench/setup.ts <dir> [devices=21]
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { generateNoiseKeyPair } from "../noise/channel.ts";
import { b64u, deviceId, newIdentity } from "../identity.ts";

export function setup(dir: string, n = 21) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hub = generateNoiseKeyPair();
  const w = (f: string, v: unknown) => writeFileSync(join(dir, f), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
  w("hub-key.json", { sk: b64u(hub.secretKey), pk: b64u(hub.publicKey) });
  const token = randomBytes(32).toString("base64url");
  w("relay-token", token);
  w("relay-hubs.json", [{ hub_pk: b64u(hub.publicKey), token_hash: createHash("sha256").update(token).digest("hex") }]);
  const devices = [];
  for (let i = 0; i < n; i++) {
    const id = newIdentity();
    w(`dev-${i}.json`, { sk: b64u(id.secretKey), pk: b64u(id.publicKey) });
    devices.push({ device_id: deviceId(id.publicKey), public_key: b64u(id.publicKey) });
  }
  w("devices.json", devices);
  return { hubPk: b64u(hub.publicKey), token };
}

if (import.meta.main) console.log(JSON.stringify({ hub_pk: setup(process.argv[2], Number(process.argv[3] ?? 21)).hubPk }));
