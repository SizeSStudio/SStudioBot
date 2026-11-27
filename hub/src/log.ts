// One JSON object per line (docs/tech/01 「日志」). Callers pass names and counts, never secret values; the shared
// redact() from tools (W1d) is wired in here once it exists.
type Fields = Record<string, unknown>;

let redact = (s: string) => s;
export function setRedactor(fn: (s: string) => string) { redact = fn; }

let quiet = process.env.SBOT_LOG === "off";
export function setQuiet(q: boolean) { quiet = q; }

export function log(mod: string, msg: string, fields: Fields = {}) {
  if (quiet) return;
  process.stderr.write(redact(JSON.stringify({ t: new Date().toISOString(), mod, msg, ...fields })) + "\n");
}
