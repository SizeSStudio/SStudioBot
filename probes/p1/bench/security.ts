// The three P1 security checks against a running relay + hub, `rounds` each (tamper: per direction).
//   node bench/security.ts --relay ws://127.0.0.1:7829 --hub-pk <b64u> --identity dev.json [--rounds 10]
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { connect } from "../device.ts";
import { fromB64u, newIdentity } from "../identity.ts";
import { finishInitiator, generateNoiseKeyPair, startInitiator } from "../noise/channel.ts";
import { startTamperProxy } from "./tamper-proxy.ts";

type Tally = Record<string, { pass: number; of: number; failures: string[] }>;

export async function runSecurity(relay: string, hubPkB64: string, identityPath: string, rounds = 10): Promise<Tally> {
  const hubPk = fromB64u(hubPkB64);
  const idj = JSON.parse(readFileSync(identityPath, "utf8"));
  const id = { secretKey: fromB64u(idj.sk), publicKey: fromB64u(idj.pk) };
  const peer = `${relay}/v1/peer?hub=${hubPkB64}`;
  const out: Tally = {};
  const record = (k: string, ok: boolean, note: string) => {
    const r = (out[k] ??= { pass: 0, of: 0, failures: [] });
    r.of++;
    if (ok) r.pass++;
    else r.failures.push(note);
  };

  // Control: the honest path works, so every failure below comes from the attack.
  const ctl = await connect({ url: peer, hubPk, id });
  if ((await ctl.request("POST", "/probe/echo", { hi: 1 })).status !== 200) throw new Error("control failed");
  ctl.ws.close();

  // 1. One flipped bit in transit (handshake 1/2, auth, req; handshake 2, auth res) → the session dies.
  const proxy = await startTamperProxy(relay);
  proxy.arm({ dir: "up", index: -1 }); // control: the proxy itself passes an honest session
  const pc = await connect({ url: `${proxy.url}/v1/peer?hub=${hubPkB64}`, hubPk, id });
  if ((await pc.request("POST", "/probe/echo", {})).status !== 200) throw new Error("proxy control failed");
  pc.ws.close();
  for (const dir of ["up", "down"] as const) {
    for (let i = 0; i < rounds; i++) {
      const index = i % (dir === "up" ? 3 : 2);
      proxy.arm({ dir, index });
      let got = "closed";
      try {
        const c = await connect({ url: `${proxy.url}/v1/peer?hub=${hubPkB64}`, hubPk, id, timeoutMs: 5000 });
        const r = await Promise.race([c.request("POST", "/probe/echo", {}), c.closed.then(() => "closed")]);
        got = r === "closed" ? "closed" : "answered";
        c.ws.close();
      } catch {}
      record(`tamper_${dir}`, got === "closed", `msg#${index}: ${got}`);
    }
  }
  proxy.close();

  // 2. A pairing code with someone else's hub key, routed to the real hub → the handshake fails.
  for (let i = 0; i < rounds; i++) {
    let got = "failed";
    try {
      await connect({ url: peer, hubPk: generateNoiseKeyPair().publicKey, id: newIdentity(), pairSecret: "x".repeat(43), timeoutMs: 5000 });
      got = "connected";
    } catch {}
    record("wrong_hub_key", got === "failed", got);
  }

  // 3a. Plaintext replay: A's auth frame, sent by an attacker on its own channel B.
  for (let i = 0; i < rounds; i++) {
    const a = await connect({ url: peer, hubPk, id });
    a.ws.close();
    let got = "rejected";
    try {
      await connect({ url: peer, hubPk, id: newIdentity(), authOverride: a.authFrame, timeoutMs: 5000 });
      got = "accepted";
    } catch {}
    record("replay_auth_plain", got === "rejected", got);
  }

  // 3b. Ciphertext replay: A's encrypted auth message injected into channel B (what the relay could try).
  for (let i = 0; i < rounds; i++) {
    const sent: Uint8Array[] = [];
    const a = await connect({ url: peer, hubPk, id, tap: (m) => sent.push(m) });
    a.ws.close();
    const authCipher = sent[1]; // [0] handshake msg1, [1] auth
    const ws = new WebSocket(peer);
    const got = await new Promise<string>((res) => {
      ws.on("open", () => {
        const s = startInitiator(hubPk, { v: 1, role: "client", purpose: "auth" });
        ws.once("message", (d: Buffer) => {
          finishInitiator(s.hs, new Uint8Array(d));
          ws.send(authCipher);
          setTimeout(() => res("still open"), 3000);
        });
        ws.send(s.message);
      });
      ws.on("close", () => res("closed"));
      ws.on("error", () => res("closed"));
    });
    ws.terminate();
    record("replay_auth_cipher", got === "closed", got);
  }
  return out;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { relay: { type: "string" }, "hub-pk": { type: "string" }, identity: { type: "string" }, rounds: { type: "string", default: "10" } },
  });
  console.log(JSON.stringify(await runSecurity(values.relay!, values["hub-pk"]!, values.identity!, Number(values.rounds)), null, 1));
  process.exit(0);
}
