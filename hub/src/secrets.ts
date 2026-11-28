// secrets.env and keys/ (底线: write-only for agents). The values live in this module's memory only: the proxy reads
// endpoint keys from here, redact() learns every value so none can leak into logs, run_items, events or cards.
// Nothing here prints or logs a value; errors name the key, never what it holds.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let values = new Map<string, string>();
let keyFiles: string[] = [];

/** KEY=VALUE per line; `#` comments, optional `export `, optional matching quotes. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.set(m[1]!, v);
  }
  return out;
}

/** (Re)load secrets.env and the text of every file under keys/. Missing files are fine (fresh home). */
export function loadSecrets(secretsFile: string, keysDir?: string) {
  values = existsSync(secretsFile) ? parseEnv(readFileSync(secretsFile, "utf8")) : new Map();
  keyFiles = [];
  if (keysDir && existsSync(keysDir)) {
    for (const name of readdirSync(keysDir)) {
      const f = join(keysDir, name);
      try { if (statSync(f).isFile() && statSync(f).size < 64 * 1024) keyFiles.push(readFileSync(f, "utf8")); } catch { /* unreadable: nothing to learn */ }
    }
  }
}

/** One value by name, for the proxy. undefined when unset. */
export const secret = (name: string): string | undefined => values.get(name) || undefined;

/**
 * Every string redact() must hide: secrets.env values and the non-trivial lines of key files. Very short values are
 * skipped (a 3-character "secret" would blank out ordinary words); format patterns still catch the usual shapes.
 */
export function secretValues(): string[] {
  const out = new Set<string>();
  for (const v of values.values()) if (v.length >= 8) out.add(v);
  for (const text of keyFiles) {
    const t = text.trim();
    if (t.length >= 8) out.add(t);
    for (const line of t.split(/\r?\n/)) if (line.trim().length >= 16 && !/^-----/.test(line.trim())) out.add(line.trim());
  }
  return [...out];
}
