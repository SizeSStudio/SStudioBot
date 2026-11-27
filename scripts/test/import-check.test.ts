import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { checkFile, specifiers } from "../import-check.ts";

const R = "/repo";
const probs = (file: string, src: string) => checkFile(R, join(R, file), src).map((p) => p.why);

test("specifiers: static, type-only, dynamic, re-export; comments ignored", () => {
  assert.deepEqual(specifiers(`import a from "./a.ts"; import type { B } from '../b.ts'; export * from "./c.ts";
    const d = await import("./d.ts"); // import x from "./nope.ts"
    /* import y from "./nope2.ts" */ import "./side.ts";`), ["./a.ts", "../b.ts", "./c.ts", "./d.ts", "./side.ts"]);
});

test("allowed directions", () => {
  assert.deepEqual(probs("hub/src/x.ts", `import { Frame } from "../../protocol/frames.ts"; import z from "zod"; import "node:fs";`), []);
  assert.deepEqual(probs("relay/src/x.ts", `import { DATA } from "../../protocol/envelope.ts";`), []);
  assert.deepEqual(probs("clients/app/x.tsx", `import { Frame } from "@sbot/protocol/frames.ts"; import y from "./y";`), []);
});

test("forbidden directions", () => {
  assert.match(probs("hub/src/x.ts", `import a from "../../node/src/a.ts";`)[0]!, /hub\/ must not import node\//);
  assert.match(probs("node/x.ts", `import a from "@sbot/hub";`)[0]!, /must not import hub/);
  assert.match(probs("relay/x.ts", `import a from "../protocol/frames.ts";`)[0]!, /only import protocol\/envelope/);
  assert.match(probs("protocol/x.ts", `import a from "../hub/a.ts";`)[0]!, /protocol\/ must not import hub/);
  assert.match(probs("hub/x.ts", `import a from "../core/src/db.ts";`)[0]!, /must not import core/);
  assert.match(probs("core/src/x.ts", `import a from "../../protocol/frames.ts";`)[0]!, /core\/ must not import protocol/);
  assert.match(probs("clients/x.ts", `import a from "../hub/a.ts";`)[0]!, /clients\/ must not import hub/);
});

test("server relative imports need .ts", () => {
  assert.match(probs("hub/x.ts", `import a from "./a";`)[0]!, /end in \.ts/);
  assert.deepEqual(probs("hub/x.ts", `import a from "./a.json" with { type: "json" };`), []);
});
