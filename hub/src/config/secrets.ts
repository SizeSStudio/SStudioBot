// secrets.env reader (10: ported from core's secret()). Write-only for agents: values go to the code that needs them
// (channel login, proxy, backup) and never to a log, an event, a tool result or a child's environment. Callers log
// names only. Reloaded when the file's mtime changes. W1d's proxy uses the same reader; whichever PR lands second
// keeps this one.
import { readFileSync, statSync } from "node:fs";
import { home } from "../home.ts";

let cache: { file: string; mtime: number; vals: Map<string, string> } | undefined;

function load(): Map<string, string> {
  const file = home().secrets;
  let mtime: number;
  try { mtime = statSync(file).mtimeMs; } catch { return new Map(); }
  if (cache && cache.file === file && cache.mtime === mtime) return cache.vals;
  const vals = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vals.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, "$2"));
  }
  cache = { file, mtime, vals };
  return vals;
}

export const secret = (name: string): string | undefined => load().get(name) || undefined;

/** every value, for redactors only (long enough to be worth masking) */
export const secretValues = (): string[] => [...load().values()].filter((v) => v.length >= 6);
