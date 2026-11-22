// Routine lens jobs (DESIGN §觉2, §参1). They are on by default, and seeds never reach an existing config, so an
// instance that predates them gets them added once. After that jobs.yaml is his: `enabled: false` or deleting the line
// turns one off and it does not come back.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { P, log } from "./config.ts";
import { kvGet, kvSet } from "./db.ts";
import { editConfig } from "./memory.ts";
import { notifyAdmin } from "./config-write.ts";

const MARK = "upgrade.lens_jobs";
// day: done before the 08:30 morning report · week: before the Sunday 20:30 review · month: before the day-1 review
const DEFAULTS: Record<string, Record<string, unknown>> = {
  lens_day: { every: "day", at: "07:50", do: "lens_day" },
  lens_week: { every: "week", weekday: 0, at: "19:30", do: "lens_week" },
  lens_month: { every: "month", day: 1, at: "06:00", do: "lens_month" },
};

export function addDefaultLensJobs(): string[] {
  if (kvGet(MARK)) return [];
  const added: string[] = [];
  if (existsSync(join(P.config, "jobs.yaml"))) editConfig("jobs.yaml", (doc) => {
    const cur = (doc.toJS() ?? {}) as Record<string, any>;
    for (const [name, spec] of Object.entries(DEFAULTS)) {
      if (cur[name] || Object.values(cur).some((j) => j?.do === spec.do)) continue;
      doc.set(name, doc.createNode(spec, { flow: true }));
      added.push(name);
    }
    return added.length ? `add ${added.join(", ")}` : undefined;
  }, "upgrade");
  kvSet(MARK, String(Date.now()));
  if (added.length) {
    log("lens", "routine jobs added", { added });
    void notifyAdmin(`⚙️ **jobs.yaml 加了例行镜头任务**：${added.join("、")}。不想要就在那一行写 enabled: false，或者删掉。`);
  }
  return added;
}
