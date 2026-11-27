// v1 only grows (docs/tech/01 CI, 02 「版本」, IZ-10): compare protocol/schemas.ts with the snapshot saved at the
// last App release. Removed schema / field / route / entity, a narrowed type, a removed enum value, or a field that
// became required fails. No snapshot yet (before the first release): print, don't block.
//   node scripts/protocol-check.ts            check against protocol/snapshot.json
//   node scripts/protocol-check.ts --write    write the snapshot (run when an App release is cut)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { SCHEMAS, ROUTES, ENTITIES } from "../protocol/schemas.ts";

type J = Record<string, unknown>;
export type Snapshot = { schemas: Record<string, J>; routes: string[]; entities: string[] };

export function current(): Snapshot {
  const schemas: Record<string, J> = {};
  for (const [k, s] of Object.entries(SCHEMAS)) schemas[k] = z.toJSONSchema(s, { unrepresentable: "any", io: "input" }) as J;
  return { schemas, routes: [...ROUTES], entities: [...ENTITIES] };
}

const types = (s: J): Set<string> | null => {
  if (s.type === undefined) return null;  // anything
  return new Set(Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]);
};
const variants = (s: J): J[] | null => (Array.isArray(s.anyOf) ? (s.anyOf as J[]) : Array.isArray(s.oneOf) ? (s.oneOf as J[]) : null);
const tagOf = (s: J): string | undefined => {
  const props = (s.properties ?? {}) as Record<string, J>;
  for (const [k, p] of Object.entries(props)) if (p.const !== undefined) return `${k}=${String(p.const)}`;
  return undefined;
};

/** Every way `next` accepts less than `prev` did. */
export function narrowings(prev: J, next: J, at: string): string[] {
  const out: string[] = [];
  // a new schema with no constraint at all accepts everything
  if (Object.keys(next).filter((k) => k !== "$schema").length === 0) return out;
  const pv = variants(prev), nv = variants(next);
  if (pv) {
    if (!nv) { out.push(`${at}: union became a single shape`); return out; }
    pv.forEach((p, i) => {
      const tag = tagOf(p);
      const match = tag ? nv.find((n) => tagOf(n) === tag) : nv[i];
      if (!match) out.push(`${at}: union variant ${tag ?? i} removed`);
      else out.push(...narrowings(p, match, `${at}|${tag ?? i}`));
    });
    return out;
  }
  const pt = types(prev), nt = types(next);
  if (nt && (!pt || [...pt].some((t) => !nt.has(t) && !(t === "integer" && nt.has("number")))))
    out.push(`${at}: type ${pt ? [...pt].join("|") : "any"} → ${[...nt].join("|")}`);
  if (Array.isArray(prev.enum)) {
    const ne = Array.isArray(next.enum) ? (next.enum as unknown[]) : null;
    if (ne) for (const v of prev.enum as unknown[]) if (!ne.includes(v)) out.push(`${at}: enum value ${JSON.stringify(v)} removed`);
  } else if (Array.isArray(next.enum)) out.push(`${at}: became an enum`);
  if (prev.const === undefined && next.const !== undefined) out.push(`${at}: became a constant`);
  if (prev.const !== undefined && next.const !== undefined && prev.const !== next.const) out.push(`${at}: constant changed`);
  for (const k of ["pattern", "minimum", "maximum", "minLength", "maxLength", "format"] as const)
    if (next[k] !== undefined && JSON.stringify(next[k]) !== JSON.stringify(prev[k])) out.push(`${at}: ${k} added or changed`);
  const pp = (prev.properties ?? {}) as Record<string, J>, np = (next.properties ?? {}) as Record<string, J>;
  for (const [k, v] of Object.entries(pp)) {
    if (!(k in np)) out.push(`${at}.${k}: field removed`);
    else out.push(...narrowings(v, np[k]!, `${at}.${k}`));
  }
  const preq = new Set((prev.required as string[] | undefined) ?? []);
  for (const k of (next.required as string[] | undefined) ?? []) if (!preq.has(k)) out.push(`${at}.${k}: became required`);
  if (prev.items && next.items) out.push(...narrowings(prev.items as J, next.items as J, `${at}[]`));
  if (prev.additionalProperties && typeof prev.additionalProperties === "object" && next.additionalProperties && typeof next.additionalProperties === "object")
    out.push(...narrowings(prev.additionalProperties as J, next.additionalProperties as J, `${at}{}`));
  return out;
}

export function compare(prev: Snapshot, next: Snapshot): string[] {
  const out: string[] = [];
  for (const [k, s] of Object.entries(prev.schemas)) {
    if (!next.schemas[k]) out.push(`${k}: schema removed`);
    else out.push(...narrowings(s, next.schemas[k]!, k));
  }
  for (const r of prev.routes) if (!next.routes.includes(r)) out.push(`route removed: ${r}`);
  for (const e of prev.entities) if (!next.entities.includes(e)) out.push(`entity removed: ${e}`);
  return out;
}

if (import.meta.main) {
  const file = new URL("../protocol/snapshot.json", import.meta.url);
  const now = current();
  if (process.argv.includes("--write")) {
    writeFileSync(file, JSON.stringify(now, null, 1) + "\n");
    console.log(`protocol-check: wrote snapshot (${Object.keys(now.schemas).length} schemas, ${now.routes.length} routes)`);
  } else if (!existsSync(file)) {
    console.log(`protocol-check: no snapshot yet (no App release); ${Object.keys(now.schemas).length} schemas, ${now.routes.length} routes — not blocking`);
  } else {
    const probs = compare(JSON.parse(readFileSync(file, "utf8")) as Snapshot, now);
    for (const p of probs) console.log(`::error::protocol narrowed: ${p}`);
    console.log(probs.length ? `protocol-check: ${probs.length} narrowing(s); v1 only grows` : "protocol-check: only additions");
    process.exit(probs.length ? 1 : 0);
  }
}
