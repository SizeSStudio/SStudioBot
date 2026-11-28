// Shared bits for hub tests: a throwaway home under the OS temp dir, quiet logs, fictional data only.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { home, type Home } from "../src/home.ts";
import { setQuiet } from "../src/log.ts";

setQuiet(true);

export function tempHome(tag = "hub"): Home {
  const root = mkdtempSync(join(tmpdir(), `sbot-${tag}-`));
  const prev = process.env.SBOT_SECRETS;
  delete process.env.SBOT_SECRETS;
  const h = home(root);
  if (prev !== undefined) process.env.SBOT_SECRETS = prev;
  mkdirSync(h.config, { recursive: true });
  return h;
}

/**
 * A home the ported (ambient-db) modules can use: SBOT_HOME points at it, config files as given, db opened and bound.
 * Config values are fictional; ids look like Feishu's shape only so the routing code sees what it expects.
 */
export async function ambientHome(tag: string, config: Record<string, string> = {}, secrets?: string) {
  const { writeFileSync } = await import("node:fs");
  const { useConfigDir } = await import("../src/config/load.ts");
  const { openDb } = await import("../src/db/db.ts");
  const { setDb } = await import("../src/db/ambient.ts");
  const h = tempHome(tag);
  process.env.SBOT_HOME = h.root;
  delete process.env.SBOT_SECRETS;
  useConfigDir(h.config);
  for (const [f, t] of Object.entries(config)) writeFileSync(join(h.config, f), t);
  if (secrets !== undefined) writeFileSync(join(h.root, "secrets.env"), secrets, { mode: 0o600 });
  mkdirSync(join(h.agentHome, "matters"), { recursive: true });
  const db = openDb(h.db);
  setDb(db);
  return { h, db };
}
