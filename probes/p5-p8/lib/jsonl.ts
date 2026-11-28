// 子进程的 JSONL 读取：只按 LF 切（readline 会在 U+2028/2029 上误切）。
import type { Readable } from "node:stream";

export function readJsonl(stream: Readable, on: (value: any) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      on(JSON.parse(line));
    }
  });
}
