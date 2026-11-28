// A fake Anthropic Messages upstream for tests: streams text and tool_use blocks as SSE, records every request, and
// can hang (to kill a hub mid-run) or fail. Offline, fictional model names only.
import http from "node:http";

export type Step =
  | { text: string; pace?: number }
  | { tool: { name: string; input: Record<string, unknown>; id?: string }; text?: string; pace?: number }
  | { hang: true }
  | { status: number; body: string }
  | { later: Promise<Step> };

export interface Seen { headers: http.IncomingHttpHeaders; body: any; url: string }

export interface FakeLlm {
  port: number; url: string; seen: Seen[];
  /** what to answer to request n (0-based); default: a short text */
  respond: (body: any, n: number) => Step;
  close(): Promise<void>;
}

const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

type Answer = { text: string; pace?: number } | { tool: { name: string; input: Record<string, unknown>; id?: string }; text?: string; pace?: number };

/** `pace` (ms): the text one character per event, an event every `pace` ms, like a model typing (streaming tests). */
export function sse(step: Answer, model: string, n: number): string {
  let out = ev("message_start", { message: { id: `msg_fake_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } } });
  let i = 0;
  const text = "text" in step ? step.text : undefined;
  if (text) {
    out += ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
    for (const part of text.match(step.pace ? /./gsu : /.{1,6}/gsu) ?? []) out += ev("content_block_delta", { index: i, delta: { type: "text_delta", text: part } });
    out += ev("content_block_stop", { index: i });
    i++;
  }
  if ("tool" in step) {
    const id = step.tool.id ?? `toolu_fake${n}`;
    out += ev("content_block_start", { index: i, content_block: { type: "tool_use", id, name: step.tool.name, input: {} } });
    out += ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.tool.input) } });
    out += ev("content_block_stop", { index: i });
  }
  out += ev("message_delta", { delta: { stop_reason: "tool" in step ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } });
  out += ev("message_stop", {});
  return out;
}

export async function fakeLlm(respond: FakeLlm["respond"] = () => ({ text: "好的。" })): Promise<FakeLlm> {
  const seen: Seen[] = [];
  const hanging = new Set<http.ServerResponse>();
  const f: FakeLlm = { port: 0, url: "", seen, respond, close: async () => {} };
  const srv = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c)).on("end", async () => {
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch { /* not JSON */ }
      const n = seen.length;
      seen.push({ headers: req.headers, body, url: req.url ?? "" });
      let step = f.respond(body, n);
      if ("later" in step) {
        // the stream is open (the client is streaming) until the test resolves the step
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": wait\n\n");
        step = await step.later;
        if (!("text" in step || "tool" in step)) { res.destroy(); return; }
        res.end(sse(step, String(body.model ?? ""), n));
        return;
      }
      if ("hang" in step) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": hang\n\n"); hanging.add(res); return; }
      if ("status" in step) { res.writeHead(step.status, { "content-type": "application/json" }).end(step.body); return; }
      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `msg_fake_${n}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "text" in step ? step.text : "" }], stop_reason: "end_turn", usage: { input_tokens: 11, output_tokens: 7 } }));
        return;
      }
      if (step.pace) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of sse(step, String(body.model ?? ""), n).split(/(?<=\n\n)/)) { res.write(e); await new Promise((r) => setTimeout(r, step.pace)); }
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(step, String(body.model ?? ""), n));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  f.port = (srv.address() as { port: number }).port;
  f.url = `http://127.0.0.1:${f.port}`;
  f.close = () => new Promise<void>((r) => { for (const h of hanging) h.destroy(); srv.close(() => r()); srv.closeAllConnections(); });
  return f;
}

/** models.yaml for a test home pointing every tier at the fake upstream (fictional names). */
export function fakeModelsYaml(port: number, extra = ""): string {
  return [
    "endpoints:",
    "  fake:",
    `    base_url: http://127.0.0.1:${port}`,
    "    auth: x-api-key",
    "    key_ref: FAKE_KEY",
    "tiers:",
    "  chat: { endpoint: fake, model: claude-fake-chat, price: { in: 1, out: 2 } }",
    "  work: { endpoint: fake, model: claude-fake-work, price: { in: 1, out: 2 } }",
    "  light: { endpoint: fake, model: claude-fake-light, price: { in: 1, out: 2 } }",
    "  expert: { endpoint: fake, model: gpt-fake-expert, price: { in: 1, out: 2 } }",
    extra,
  ].join("\n") + "\n";
}

/** the fictional upstream key the test homes put in secrets.env */
export const FAKE_KEY = "fake-upstream-key-not-real-0001";
