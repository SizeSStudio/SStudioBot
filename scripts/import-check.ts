// Dependency direction (docs/tech/01): hub, node, relay, clients import only protocol/ and never each other; relay
// imports only protocol/envelope.ts; protocol/ imports nothing of ours; core/ and the new dirs never import each other.
// Server-side relative imports end in .ts (type stripping). Usage: node scripts/import-check.ts [root]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const UNITS = ["protocol", "hub", "node", "relay", "clients", "core", "scripts"] as const;
type Unit = (typeof UNITS)[number];
const SKIP = new Set(["node_modules", ".expo", "dist", "build", "out", ".git", "android", "ios"]);
const EXT = /\.(m?[jt]sx?)$/;

export type Problem = { file: string; spec: string; why: string };

const unitOf = (rel: string): Unit | null => {
  const top = rel.split(sep)[0] ?? rel.split("/")[0];
  return (UNITS as readonly string[]).includes(top!) ? (top as Unit) : null;
};

// which units a unit may reach with a relative path or our own package name
const ALLOWED: Record<Unit, readonly Unit[]> = {
  protocol: ["protocol"],
  hub: ["hub", "protocol"],
  node: ["node", "protocol"],
  relay: ["relay", "protocol"],  // narrowed to envelope.ts below
  clients: ["clients", "protocol"],
  core: ["core"],
  scripts: ["scripts", "protocol", "hub", "node", "relay"],  // tooling may look at everything server-side
};
const PKG: Record<string, Unit> = { "@sbot/protocol": "protocol", "@sbot/hub": "hub", "@sbot/node": "node", "@sbot/relay": "relay" };

export function specifiers(src: string): string[] {
  const out: string[] = [];
  // strip template literals and comments: imports never live there (test fixtures and commented-out code do)
  const code = src.replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const re = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m; (m = re.exec(code)); ) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

export function checkFile(root: string, file: string, src: string): Problem[] {
  const rel = relative(root, file);
  const from = unitOf(rel);
  if (!from) return [];
  const probs: Problem[] = [];
  for (const spec of specifiers(src)) {
    let target: Unit | null = null, targetRel = "";
    if (spec.startsWith(".")) {
      targetRel = relative(root, resolve(dirname(file), spec));
      if (targetRel.startsWith("..")) { probs.push({ file: rel, spec, why: "leaves the repo" }); continue; }
      target = unitOf(targetRel);
      if (from !== "clients" && from !== "core" && !/\.ts$/.test(spec) && !/\.json$/.test(spec))
        probs.push({ file: rel, spec, why: "relative import must end in .ts" });
    } else {
      const pkg = Object.keys(PKG).find((p) => spec === p || spec.startsWith(p + "/"));
      if (!pkg) continue;  // node:, npm packages
      target = PKG[pkg]!;
      targetRel = join(target, spec.slice(pkg.length + 1));
    }
    if (!target) continue;
    if (!ALLOWED[from].includes(target)) { probs.push({ file: rel, spec, why: `${from}/ must not import ${target}/` }); continue; }
    if (from === "relay" && target === "protocol" && targetRel.split(sep).join("/") !== "protocol/envelope.ts")
      probs.push({ file: rel, spec, why: "relay/ may only import protocol/envelope.ts" });
  }
  return probs;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.test(n)) yield p;
  }
}

export function checkTree(root: string): Problem[] {
  const probs: Problem[] = [];
  for (const u of UNITS) for (const f of walk(join(root, u))) probs.push(...checkFile(root, f, readFileSync(f, "utf8")));
  return probs;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? ".");
  const probs = checkTree(root);
  for (const p of probs) console.log(`::error file=${p.file}::${p.spec}: ${p.why}`);
  console.log(probs.length ? `import-check: ${probs.length} problem(s)` : "import-check: clean");
  process.exit(probs.length ? 1 : 0);
}
