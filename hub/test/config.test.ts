import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./helpers.ts";
import { tempHome } from "./helpers.ts";
import { CONFIG_FILES, DEFAULTS, parseConfig } from "../src/config/schemas.ts";
import { ConfigInvalid, alertLines, cached, channelsConf, consoleConf, dreamConf, gateConf, loadAll, measureConf, parseText, sourcesConf, useConfigDir } from "../src/config/load.ts";
import { widening } from "../src/config/widening.ts";
import { specProblems } from "../src/config/form.ts";
import { SEED_CONFIG } from "../src/config/write.ts";

test("every seed config file parses", () => {
  for (const f of ["jobs.yaml", "models.yaml", "people.yaml", "sources.yaml"]) parseText(f, readFileSync(join(SEED_CONFIG, f), "utf8"));
});

test("old keys still parse and fold into the new ones (Y11)", () => {
  const h = tempHome("cfg");
  useConfigDir(h.config);
  writeFileSync(join(h.config, "gate.yaml"), "improve_budget_usd: 7\nexpert_daily_limit: 9\ndaily_budget_usd: 3\n");
  const tier = (m: string) => `  ${m}: { endpoint: main, model: M_${m} }\n`;
  writeFileSync(join(h.config, "models.yaml"), "endpoints:\n  main: { base_url: https://example.com, auth: bearer, key_ref: FAKE }\ntiers:\n" + ["chat", "work", "light"].map(tier).join("") + "budgets: { daily_cost: 5 }\n");
  writeFileSync(join(h.config, "self.yaml"), "fade_days: 40\nmeasure: { see_off_after: 4 }\n");
  writeFileSync(join(h.config, "jobs.yaml"), "improve: { every: week, weekday: 1, at: \"10:00\", do: improve, min_days: 3 }\n");
  assert.deepEqual(loadAll().sort(), ["gate.yaml", "jobs.yaml", "models.yaml", "self.yaml"]);
  assert.equal(gateConf().improve_alert_usd, 7);
  const a = alertLines();
  assert.equal(a.daily_cost, 3, "the smaller of daily_cost and daily_budget_usd");
  assert.equal(a.tier_daily.expert, 9);
  assert.equal(measureConf().fade_days, 40);
  assert.equal(measureConf().see_off_after, 4);
  useConfigDir(undefined);
});

test("a bad file is refused at startup with the line; after startup the last good value stays", () => {
  const h = tempHome("cfg");
  useConfigDir(h.config);
  const f = join(h.config, "gate.yaml");
  writeFileSync(f, "proactive_daily_cap: 2\n");
  loadAll();
  assert.equal(gateConf().proactive_daily_cap, 2);
  writeFileSync(f, "proactive_daily_cap: lots\n# padding so size changes\n");
  assert.equal(gateConf().proactive_daily_cap, 2, "keeps last good");
  assert.throws(() => loadAll(), /gate\.yaml.*第 1 行/s);
  assert.throws(() => parseText("gate.yaml", "a: [1,"), ConfigInvalid);
  useConfigDir(undefined);
});

test("hot reload: an edit is seen on the next read", () => {
  const h = tempHome("cfg");
  useConfigDir(h.config);
  const f = join(h.config, "console.yaml");
  writeFileSync(f, "mcp_open: false\n");
  assert.equal(consoleConf().mcp_open, false);
  writeFileSync(f, "mcp_open: true   # changed\n");
  assert.equal(consoleConf().mcp_open, true);
  assert.equal(cached("nope.yaml"), undefined);
  useConfigDir(undefined);
});

test("defaults: every entry and permission is off; nothing wider than before", () => {
  const h = tempHome("cfg");
  useConfigDir(h.config);
  const c = consoleConf();
  assert.equal(c.relay.enabled, false);
  assert.equal(c.mcp_open, false);
  assert.equal(c.fcm.enabled, false);
  assert.equal(sourcesConf().feishu.dm, false);
  assert.deepEqual(sourcesConf().sources, []);
  assert.deepEqual(dreamConf(), DEFAULTS.dream);
  assert.equal(alertLines().tier_daily.expert, 20);
  assert.deepEqual(channelsConf().outlets.main, ["client", "feishu:dm"]);
  useConfigDir(undefined);
});

test("unknown file and non-object roots", () => {
  assert.equal(parseConfig("jobs.yaml", null).success, true);
  assert.equal(parseConfig("gate.yaml", [1]).success, false);
  assert.ok(CONFIG_FILES.includes("backup.yaml") && CONFIG_FILES.includes("channels.yaml") && CONFIG_FILES.includes("console.yaml"));
});

test("widening: the checks fire on loosening and stay quiet otherwise", () => {
  const w = (file: string, b: unknown, a: unknown) => widening(file, b, a);
  assert.ok(w("gate.yaml", {}, { proactive_daily_cap: 99 }).length);
  assert.equal(w("gate.yaml", {}, { proactive_daily_cap: DEFAULTS.gate.proactive_daily_cap }).length, 0, "adding the default is not a widening");
  assert.ok(w("gate.yaml", {}, { sensitive_words: [] }).length);
  assert.ok(w("sources.yaml", { feishu: { dm: false } }, { feishu: { dm: true } }).length);
  assert.ok(w("sources.yaml", {}, { sources: [{ id: "x", kind: "fetch", url: "https://example.com" }] }).length);
  assert.ok(w("sources.yaml", { exclude: { chats: ["a"] } }, { exclude: { chats: [] } }).length);
  assert.ok(w("console.yaml", {}, { relay: { enabled: true } }).length);
  assert.ok(w("console.yaml", {}, { mcp_open: true }).length);
  assert.equal(w("console.yaml", { mcp_open: true }, { mcp_open: false }).length, 0, "tightening is quiet");
  assert.ok(w("jobs.yaml", {}, { d: { every: "day", at: "03:00", do: "dream", max_delete: 0.5 } }).length);
  assert.ok(w("jobs.yaml", {}, { d: { every: "day", at: "03:00", do: "dream", archive_days: 10 } }).length);
  assert.ok(w("channels.yaml", { feishu: { mode: "shadow" } }, { feishu: { mode: "live" } }).length);
  assert.ok(w("backup.yaml", {}, { recipient: "age1" + "q".repeat(58) }).length);
  assert.ok(w("backup.yaml", {}, { to_nodes: ["mac"] }).length);
  assert.ok(w("gate.yaml", {}, { push: { night_allow: ["chat"] } }).length);
  assert.ok(w("models.yaml", { tiers: { expert: { daily_alert: 20 } } }, { tiers: { expert: { daily_alert: 50 } } }).length);
  assert.equal(w("models.yaml", { tiers: { expert: { daily_alert: 20 } } }, { tiers: { expert: { daily_alert: 10 } } }).length, 0);
});

test("form specs and schemas are in step, both directions", () => {
  assert.deepEqual(specProblems(), []);
});
