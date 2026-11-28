// Every path the hub touches, derived from SBOT_HOME (docs/tech/01 「跨平台」: nothing hard-codes /srv).
import { join, resolve } from "node:path";

export interface Home {
  root: string;
  db: string;            // db/sbot.db
  config: string;        // config/ (git)
  agentHome: string;     // agent-home/ (git)
  blobs: string;         // blobs/<sha256> (04 「大载荷不进表」)
  raw: string;           // raw/sha256/…
  keys: string;          // keys/ (hub's static key etc.; private, never printed)
  secrets: string;       // secrets.env (write-only for agents)
  run: string;           // run/ (0700): hub.sock, hub-admin.sock
  staging: string;       // backup-staging/
  logs: string;
}

export function home(root = process.env.SBOT_HOME): Home {
  if (!root) throw new Error("SBOT_HOME is not set");
  const r = resolve(root);
  return {
    root: r,
    db: join(r, "db", "sbot.db"),
    config: join(r, "config"),
    agentHome: join(r, "agent-home"),
    blobs: join(r, "blobs"),
    raw: join(r, "raw"),
    keys: join(r, "keys"),
    secrets: process.env.SBOT_SECRETS ?? join(r, "secrets.env"),
    run: join(r, "run"),
    staging: join(r, "backup-staging"),
    logs: join(r, "logs"),
  };
}

/** The owner's timezone for local dates (01: shown and computed in self.yaml's timezone; env until W1e reads it). */
export const TZ = process.env.SBOT_TZ ?? "Asia/Shanghai";
