// Per-worker egress proxy (DESIGN §底3.6). Sandboxed commands and WebFetch reach the internet only through this, on
// 127.0.0.1:7820-7829 (the only ports besides the LLM proxy that the SBOT_W chain lets sbot-w reach). CONNECT to :443
// of an allow-listed domain only; the proxy runs as sbot (outside SBOT_W), so it refuses non-public addresses itself.

import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { log } from "./config.ts";

const PORTS = Array.from({ length: 10 }, (_, i) => 7820 + i);
const used = new Set<number>();

const privateIp = (ip: string) => net.isIPv4(ip)
  ? /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(ip)
  : /^(::1?$|f[cd]|fe[89ab]|::ffff:)/i.test(ip);

async function publicAddr(host: string) {
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error(`non-public address for ${host}`);
  return addrs[0].address;
}

export interface Egress { port: number; close(): void; log: string[] }

export async function openEgress(tag: string, allow: string[]): Promise<Egress> {
  const port = PORTS.find((p) => !used.has(p));
  if (!port) throw new Error("no free egress port (7820-7829)");
  used.add(port);
  const seen: string[] = [];
  const note = (s: string) => { if (seen.length < 200) seen.push(s); };
  const ok = (h: string) => allow.some((d) => h === d || h.endsWith("." + d));
  const srv = http.createServer((req, res) => { note(`deny http ${req.url}`); res.writeHead(403).end("sbot egress: https only\n"); });
  srv.on("connect", async (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    const [host, p] = (req.url ?? "").split(":");
    sock.on("error", () => {});
    if (!ok(host) || p !== "443") { note(`deny ${req.url}`); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    let addr: string;
    try { addr = await publicAddr(host); } catch (e: any) { note(`deny ${req.url} (${e.message})`); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    note(`allow ${host}`);
    const up = net.connect(443, addr, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy());
    sock.on("close", () => up.destroy());
  });
  try {
    await new Promise<void>((res, rej) => { srv.once("error", rej); srv.listen(port, "127.0.0.1", () => res()); });
  } catch (e) { used.delete(port); throw e; }
  return {
    port, log: seen,
    close() {
      srv.close(); used.delete(port);
      const denied = seen.filter((s) => s.startsWith("deny"));
      if (denied.length) log("egress", "denied", { tag, n: denied.length, first: denied.slice(0, 5) });
    },
  };
}
