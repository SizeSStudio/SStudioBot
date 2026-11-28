// The web export's size and what it could connect to (07 CI step 3). Sizes are compared with the P11 baseline and
// only warned about (※ red, not blocking); a relay address in the bundle fails, since the build must not carry one
// (the pairing code brings it). Instance-data patterns are leak-guard.sh --dir's job.
//   node scripts/bundle-report.ts [app/dist]
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const dist = path.resolve(process.argv[2] ?? "app/dist");
const BASE = { first: 1204 * 1024, all: 2.9 * 1024 * 1024 }; // P11 baseline, gzip
const WARN = 1.2;

const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = path.join(d, n);
  return statSync(p).isDirectory() ? files(p) : [p];
});
const all = files(dist).filter((f) => /\.(js|css|html)$/.test(f));
const gz = (f: string) => gzipSync(readFileSync(f), { level: 9 }).length;
const first = all.filter((f) => /[\\/]entry-[^\\/]+\.js$/.test(f) || f.endsWith(".css") || f.endsWith("index.html"));
const size = { first: first.reduce((n, f) => n + gz(f), 0), all: all.reduce((n, f) => n + gz(f), 0) };
const kib = (n: number) => `${(n / 1024).toFixed(0)} KiB`;

let bad = false;
for (const k of ["first", "all"] as const) {
  const ratio = size[k] / BASE[k];
  const line = `${k === "first" ? "first screen" : "everything"}: ${kib(size[k])} gzip (baseline ${kib(BASE[k])}, ${(ratio * 100).toFixed(0)}%)`;
  console.log(ratio > WARN ? `::warning::${line} is more than 20% over` : line);
}

// ws:// / wss:// literals: only loopback and the reserved example names (tests, samples) may appear
const ok = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]*\.?(example|invalid|test))(:\d+)?$/;
for (const f of all.filter((f) => f.endsWith(".js"))) {
  for (const m of readFileSync(f, "utf8").matchAll(/wss?:\/\/([A-Za-z0-9.:_[\]-]+)/g)) {
    if (!ok.test(m[1])) { console.log(`::error file=${path.relative(dist, f)}::a socket address is built in: ${m[0]}`); bad = true; }
  }
}
process.exit(bad ? 1 : 0);
