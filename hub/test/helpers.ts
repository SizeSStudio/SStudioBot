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
