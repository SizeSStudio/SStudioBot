// 本机链路的长度前缀帧（4 字节大端 + JSON），和一个最小客户端。
import net from "node:net";

export function writeFrame(s: net.Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  s.write(Buffer.concat([head, body]));
}

export function readFrames(s: net.Socket, on: (value: any) => void): void {
  let buf = Buffer.alloc(0);
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0);
      on(JSON.parse(buf.subarray(4, 4 + n).toString()));
      buf = buf.subarray(4 + n);
    }
  });
}

export async function connect(path: string) {
  const s = net.createConnection(path);
  await new Promise<void>((ok, fail) => s.once("connect", ok).once("error", fail));
  const waiting = new Map<number, (v: any) => void>();
  let next = 0;
  readFrames(s, (m) => {
    waiting.get(m.id)?.(m.result);
    waiting.delete(m.id);
  });
  return {
    send: (m: object) => writeFrame(s, m),
    request: <T = any>(m: object) =>
      new Promise<T>((ok) => {
        const id = ++next;
        waiting.set(id, ok);
        writeFrame(s, { ...m, id });
      }),
    close: () => s.end(),
  };
}
