// A local CONNECT proxy that can "cut the network" without touching the machine's real network, and the agent
// that makes the SDK go through it. Modes of the cut:
//   reset  – every tunnel is destroyed and new CONNECTs are refused (what pulling a cable looks like to the app)
//   stall  – tunnels stay open but no byte moves (a half-open path: only a ping watchdog can notice)
// lark-cli needs no agent: Go reads HTTPS_PROXY (loopback targets excepted, which is fine for the real hosts).
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

export type CutMode = "reset" | "stall";

export class CutProxy {
  private server = net.createServer((c) => this.onClient(c));
  private pairs = new Set<{ a: net.Socket; b: net.Socket }>();
  private cutMode: CutMode | null = null;
  tunnels = 0; refused = 0;
  port = 0;

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }
  get url() { return `http://127.0.0.1:${this.port}`; }
  get isCut() { return this.cutMode !== null; }

  cut(mode: CutMode = "reset") {
    this.cutMode = mode;
    for (const p of this.pairs) {
      if (mode === "reset") { p.a.destroy(); p.b.destroy(); } else { p.a.pause(); p.b.pause(); }
    }
    if (mode === "reset") this.pairs.clear();
  }
  restore() {
    const mode = this.cutMode;
    this.cutMode = null;
    // a stalled tunnel is dead for good: real networks do not resume it either, the peer has long given up
    if (mode === "stall") { for (const p of this.pairs) { p.a.destroy(); p.b.destroy(); } this.pairs.clear(); }
  }
  async close() {
    for (const p of this.pairs) { p.a.destroy(); p.b.destroy(); }
    this.pairs.clear();
    for (const c of this.all) c.destroy();      // includes the connections parked by a stall
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private all = new Set<net.Socket>();
  private onClient(c: net.Socket) {
    this.all.add(c); c.on("close", () => this.all.delete(c));
    c.on("error", () => {});
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) { if (buf.length > 8192) c.destroy(); return; }
      c.off("data", onData);
      const m = /^CONNECT ([^ :]+):(\d+) HTTP\/1\.[01]/.exec(buf.subarray(0, end).toString("latin1"));
      if (!m) { c.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n"); return; }
      if (this.cutMode) { this.refused++; this.cutMode === "reset" ? c.destroy() : c.pause(); return; }
      const up = net.connect(Number(m[2]), m[1]!);
      up.on("error", () => c.destroy());
      c.on("error", () => up.destroy());
      up.once("connect", () => {
        this.tunnels++;
        c.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = buf.subarray(end + 4);
        if (rest.length) up.write(rest);
        c.pipe(up); up.pipe(c);
        const pair = { a: c, b: up };
        this.pairs.add(pair);
        const done = () => { this.pairs.delete(pair); c.destroy(); up.destroy(); };
        c.on("close", done); up.on("close", done);
      });
    };
    c.on("data", onData);
  }
}

/** http.Agent that opens its sockets through a CONNECT proxy (TLS on top when `secure`). Works for axios and for ws. */
export class TunnelAgent extends http.Agent {
  declare protocol: string;
  private proxy: { host: string; port: number };
  private secure: boolean;
  constructor(proxy: { host: string; port: number }, secure: boolean) {
    super({ keepAlive: false });
    this.proxy = proxy; this.secure = secure;
    this.protocol = secure ? "https:" : "http:";
    (this as any).defaultPort = secure ? 443 : 80;
  }
  // Node calls createConnection(options, cb) on an Agent subclass and accepts the socket through cb.
  createConnection(options: any, cb: (err: Error | null, s?: net.Socket) => void): any {
    const host: string = options.host ?? options.hostname;
    const port: number = Number(options.port) || (this.secure ? 443 : 80);
    const s = net.connect(this.proxy.port, this.proxy.host);
    let buf = Buffer.alloc(0), settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; s.destroy(); cb(e); } };
    s.once("error", fail);
    s.once("close", () => fail(new Error("proxy connection closed")));
    s.once("connect", () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      if (!/^HTTP\/1\.[01] 200/.test(buf.toString("latin1", 0, 16))) return fail(new Error("proxy refused CONNECT"));
      settled = true;
      s.removeAllListeners("close");
      if (!this.secure) return cb(null, s);
      const t = tls.connect({ socket: s, servername: options.servername ?? host });
      t.once("secureConnect", () => cb(null, t));
      t.once("error", (e) => cb(e));
    };
    s.on("data", onData);
  }
}
