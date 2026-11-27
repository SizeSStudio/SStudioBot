import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { compare, current, type Snapshot } from "../protocol-check.ts";

const snap = (schemas: Record<string, z.ZodType>, routes: string[] = [], entities: string[] = []): Snapshot => ({
  schemas: Object.fromEntries(Object.entries(schemas).map(([k, s]) => [k, z.toJSONSchema(s, { unrepresentable: "any", io: "input" }) as Record<string, unknown>])),
  routes, entities,
});
const A = z.object({ a: z.string(), b: z.number().int().optional(), c: z.enum(["x", "y"]) });

test("additions pass", () => {
  const B = A.extend({ d: z.string().optional() });
  assert.deepEqual(compare(snap({ A }, ["GET /x"]), snap({ A: B, N: z.string() }, ["GET /x", "POST /y"], ["e"])), []);
  assert.deepEqual(compare(snap({ A }), snap({ A: A.extend({ c: z.enum(["x", "y", "z"]) }) })), []);
  assert.deepEqual(compare(snap({ A }), snap({ A: A.extend({ b: z.number().optional() }) })), [], "integer → number widens");
});

test("removals and narrowings fail", () => {
  const p = (next: z.ZodType) => compare(snap({ A }), snap({ A: next }));
  assert.match(p(A.omit({ b: true })).join(), /A\.b: field removed/);
  assert.match(p(A.extend({ b: z.number().int() })).join(), /A\.b: became required/);
  assert.match(p(A.extend({ c: z.enum(["x"]) })).join(), /enum value "y" removed/);
  assert.match(p(A.extend({ a: z.number() })).join(), /A\.a: type string → number/);
  assert.match(p(A.extend({ d: z.string() })).join(), /A\.d: became required/);
  assert.match(p(A.extend({ a: z.string().max(3) })).join(), /maxLength/);
  assert.match(compare(snap({ A }), snap({})).join(), /A: schema removed/);
  assert.match(compare(snap({}, ["GET /x"], ["e"]), snap({})).join(), /route removed.*entity removed/);
});

test("unions match variants by their tag", () => {
  const U = z.discriminatedUnion("t", [z.object({ t: z.literal("a"), x: z.string() }), z.object({ t: z.literal("b") })]);
  const U2 = z.discriminatedUnion("t", [z.object({ t: z.literal("b") }), z.object({ t: z.literal("a"), x: z.string() }), z.object({ t: z.literal("c") })]);
  assert.deepEqual(compare(snap({ U }), snap({ U: U2 })), []);
  const U3 = z.discriminatedUnion("t", [z.object({ t: z.literal("b") })]);
  assert.match(compare(snap({ U }), snap({ U: U3 })).join(), /variant t=a removed/);
});

test("the real protocol compares clean with itself", () => {
  const now = current();
  assert.deepEqual(compare(now, now), []);
  assert.ok(Object.keys(now.schemas).length > 10);
});
