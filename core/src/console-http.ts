// Console response plumbing (DESIGN §10.5): content-hashed static files with 304s, and br/gzip done in the core so both
// entrances get it (tailscale serve doesn't compress, and nginx changes need a manual install). SSE is never compressed.

import type http from "node:http";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompress, gzip, constants as Z } from "node:zlib";
import { log } from "./config.ts";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const TEXT = new Set([".html", ".js", ".css", ".svg", ".json"]);
const MIN_BYTES = 1024;   // below this the framing eats most of the gain

type Enc = "br" | "gzip";
const packBr = (raw: Buffer, quality: number) => new Promise<Buffer>((ok, no) => brotliCompress(raw, {
  params: { [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT, [Z.BROTLI_PARAM_QUALITY]: quality, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length },
}, (e, b) => e ? no(e) : ok(b)));
const packGz = (raw: Buffer) => new Promise<Buffer>((ok, no) => gzip(raw, (e, b) => e ? no(e) : ok(b)));

/** what the client takes, honouring q=0 */
function accepted(req: http.IncomingMessage): Set<string> {
  const out = new Set<string>();
  for (const part of String(req.headers["accept-encoding"] ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    if (name && (q === undefined || Number(q) > 0)) out.add(name.trim());
  }
  return out;
}

// ───────────── static files ─────────────

interface Asset { stamp: string; type: string; text: boolean; hash: string; raw: Buffer; br?: Buffer; gz?: Buffer }
const assets = new Map<string, Asset>();

/** Cached by mtime + size, so a file changed on disk is picked up without a restart. Compression runs off the event
 *  loop; until it lands the file is served as is. */
function loadAsset(f: string): Asset {
  const s = statSync(f), stamp = `${s.mtimeMs}:${s.size}`;
  const have = assets.get(f);
  if (have?.stamp === stamp) return have;
  const raw = readFileSync(f), ext = extname(f);
  const a: Asset = { stamp, raw, type: TYPES[ext] ?? "application/octet-stream", text: TEXT.has(ext), hash: createHash("sha256").update(raw).digest("hex").slice(0, 24) };
  assets.set(f, a);
  if (a.text && raw.length >= MIN_BYTES) {
    const failed = (e: any) => log("console", "compress failed", { file: f.split("/").pop(), err: String(e?.message ?? e).slice(0, 120) });
    packBr(raw, 11).then((b) => { if (b.length < raw.length) a.br = b; }).catch(failed);
    packGz(raw).then((b) => { if (b.length < raw.length) a.gz = b; }).catch(failed);
  }
  return a;
}

/** read, hash and start compressing every front-end file at startup, so the first page load is already fast */
export function warmAssets(dir: string) {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) warmAssets(f); else if (e.isFile()) loadAsset(f);
    }
  } catch (e: any) { log("console", "warm failed", { err: String(e?.message ?? e).slice(0, 120) }); }
}

// any encoding of the same content counts: the bytes the client holds are still current
function notModified(req: http.IncomingMessage, hash: string) {
  const inm = req.headers["if-none-match"];
  return !!inm && (inm.trim() === "*" || inm.split(",").some((t) => t.includes(hash)));
}

export function serveAsset(req: http.IncomingMessage, res: http.ServerResponse, f: string, H: Record<string, string>) {
  const a = loadAsset(f), takes = a.text ? accepted(req) : new Set<string>();
  const enc: Enc | null = a.br && takes.has("br") ? "br" : a.gz && takes.has("gzip") ? "gzip" : null;
  const body = enc === "br" ? a.br! : enc === "gzip" ? a.gz! : a.raw;
  // each encoding is its own representation, so each gets its own strong validator
  const head: Record<string, string> = { "Cache-Control": "no-cache", ETag: `"${a.hash}${enc === "br" ? "-br" : enc === "gzip" ? "-gz" : ""}"`, ...(a.text ? { Vary: "Accept-Encoding" } : {}), ...H };
  if ((req.method === "GET" || req.method === "HEAD") && notModified(req, a.hash)) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, { "Content-Type": a.type, "Content-Length": String(body.length), ...(enc ? { "Content-Encoding": enc } : {}), ...head });
  res.end(body);
}

// ───────────── JSON ─────────────

/** Compresses on the thread pool, so a big response doesn't hold up other requests. */
export function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, H: Record<string, string>, data: unknown) {
  const raw = Buffer.from(JSON.stringify(data));
  const head = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding", ...H };
  const send = (body: Buffer, enc?: Enc) => {
    if (res.headersSent) return;
    res.writeHead(status, { ...head, "Content-Length": String(body.length), ...(enc ? { "Content-Encoding": enc } : {}) });
    res.end(body);
  };
  const takes = raw.length >= MIN_BYTES ? accepted(req) : new Set<string>();
  const enc: Enc | null = takes.has("br") ? "br" : takes.has("gzip") ? "gzip" : null;
  if (!enc) return send(raw);
  (enc === "br" ? packBr(raw, 4) : packGz(raw)).then((b) => b.length < raw.length ? send(b, enc) : send(raw), () => send(raw));
}
