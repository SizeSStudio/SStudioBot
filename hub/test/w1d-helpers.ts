// W1d test homes: a config repo with models.yaml pointing at the fake upstream, fictional secrets, a fake channel
// plugin. Everything here is made up (ids, keys, names).
import { writeFileSync } from "node:fs";
import { tempHome } from "./helpers.ts";
import { fakeModelsYaml, FAKE_KEY } from "./fake-llm.ts";
import type { Home } from "../src/home.ts";
import { useConfigDir } from "../src/config/load.ts";
import { ensureConfigRepo } from "../src/config/seed.ts";
import { loadSecrets } from "../src/secrets.ts";
import { refreshKnown, redact } from "../src/tools/redact.ts";
import { setRedactor } from "../src/log.ts";
import type { OutChannel, OutboxRow, SendResult } from "../src/outbox.ts";

export const OWNER_FEISHU = "ou_fakeowner0001";

/** A home whose config is in place before anything reads it. `port` = the fake upstream. */
export async function w1dHome(tag: string, o: { port?: number; models?: string; files?: Record<string, string> } = {}): Promise<Home> {
  const h = tempHome(tag);
  useConfigDir(h.config);
  await ensureConfigRepo(h.config);
  const files: Record<string, string> = {
    "people.yaml": `owner:\n  name: 小测\n  ids:\n    feishu: ${OWNER_FEISHU}\n`,
    ...(o.port !== undefined || o.models ? { "models.yaml": o.models ?? fakeModelsYaml(o.port!) } : {}),
    ...o.files,
  };
  for (const [f, text] of Object.entries(files)) writeFileSync(`${h.config}/${f}`, text);
  writeFileSync(h.secrets, `FAKE_KEY=${FAKE_KEY}\nTEST_TOKEN_X=abcdefgh-test-only-1234\n`, { mode: 0o600 });
  loadSecrets(h.secrets, h.keys);
  refreshKnown();
  setRedactor(redact);
  return h;
}

/** A channel plugin that records what it was asked to send and answers from a script. */
export function fakeChannel(id: string, answer: (row: OutboxRow, n: number) => SendResult = () => ({ ok: true }), cards = true): OutChannel & { sent: OutboxRow[] } {
  const sent: OutboxRow[] = [];
  return {
    id, caps: { cards }, sent,
    async send(row) { sent.push(row); return answer(row, sent.length - 1); },
  };
}

export const until = async (cond: () => boolean, ms = 10_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
