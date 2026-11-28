// protocol/ resolves zod and @noble/* from whichever node_modules it is bundled with: the root's for hub/relay,
// clients/'s for the app. Both lockfiles must pin the same versions, or one schema parses differently on each side
// (07 「依赖」 ※).  node scripts/lock-check.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
type Lock = { packages: Record<string, { version?: string }> };
const top = (file: string) => {
  const l = JSON.parse(readFileSync(file, "utf8")) as Lock;
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(l.packages)) {
    const m = /^node_modules\/(zod|@noble\/[^/]+)$/.exec(k);
    if (m && v.version) out.set(m[1], v.version);
  }
  return out;
};
const root = top(path.join(here, "../../package-lock.json"));
const clients = top(path.join(here, "../package-lock.json"));
let bad = false;
for (const [name, v] of clients) {
  const r = root.get(name);
  if (r !== undefined && r !== v) { console.log(`::error::${name}: clients ${v}, root ${r}`); bad = true; }
  else console.log(`${name} ${v}${r === undefined ? " (clients only)" : ""}`);
}
for (const name of ["zod", "@noble/ciphers", "@noble/curves", "@noble/hashes"]) {
  if (!clients.has(name)) { console.log(`::error::${name} missing from clients/package-lock.json`); bad = true; }
}
process.exit(bad ? 1 : 0);
