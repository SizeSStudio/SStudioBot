// sbot-w's egress proxy (§底3.6, 03 egress), ported from core/src/egress.ts. Sandboxed commands and plugins reach the
// internet only through this, on 127.0.0.1:7820–7828 (the SBOT_W chain lets sbot-w reach only these and the LLM
// proxy). CONNECT to :443 of an allow-listed domain only; the proxy runs as the hub (outside SBOT_W), so it refuses
// non-public addresses itself.
//
// ※ The old range was 7820–7829; 7829 is now one of the smoke-test hub ports (CLAUDE.md), so the default stops at 7828.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { log } from "./log.ts";

const DEFAULT_PORTS = Array.from({ length: 9 }, (_, i) => 7820 + i);
const used = new Set<number>();

export const privateIp = (ip: string) => net.isIPv4(ip)
  ? /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(ip)
  : /^(::1?$|f[cd]|fe[89ab]|::ffff:)/i.test(ip);

async function publicAddr(host: string): Promise<string> {
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error(`non-public address for ${host}`);
  return addrs[0]!.address;
}

export interface Egress { port: number; close(): void; log: string[] }

export interface EgressOpts {
  ports?: number[];
  /** host → address to dial; default refuses anything that resolves to a non-public address. Tests inject their own. */
  resolve?: (host: string) => Promise<string>;
  /** the port to dial upstream (443; tests point it at a local server) */
  upstreamPort?: number;
}

export async function openEgress(tag: string, allow: string[], o: EgressOpts = {}): Promise<Egress> {
  const ports = o.ports ?? DEFAULT_PORTS;
  const port = ports.find((p) => !used.has(p));
  if (port === undefined) throw new Error(`no free egress port (${ports[0]}–${ports[ports.length - 1]})`);
  used.add(port);
  const seen: string[] = [];
  const note = (s: string) => { if (seen.length < 200) seen.push(s); };
  const ok = (h: string) => allow.some((d) => h === d || h.endsWith("." + d));
  const resolveHost = o.resolve ?? publicAddr;
  const srv = http.createServer((req, res) => { note(`deny http ${req.url}`); res.writeHead(403).end("sbot egress: https only\n"); });
  srv.on("connect", async (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    const [host = "", p] = (req.url ?? "").split(":");
    sock.on("error", () => {});
    if (!ok(host) || p !== "443") { note(`deny ${req.url}`); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    let addr: string;
    try { addr = await resolveHost(host); } catch (e) { note(`deny ${req.url} (${(e as Error).message})`); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    note(`allow ${host}`);
    const up = net.connect(o.upstreamPort ?? 443, addr, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
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
