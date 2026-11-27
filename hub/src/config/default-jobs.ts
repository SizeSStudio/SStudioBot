// Default jobs added at startup (03 「memory」, Y11). Seeds never reach an existing config, so a job that became a
// default after an instance was set up is appended once: only when no line has that name or that `do`, then a kv mark
// keeps it from ever coming back. After that jobs.yaml is mine: `enabled: false` or deleting the line turns it off.
// Ported from core/src/lens-jobs.ts addDefaultLensJobs(); the write goes through the config repo's queue.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { Db } from "../db/db.ts";
import { repoQueue } from "../memory/repo.ts";
import { log } from "../log.ts";
import * as notify from "../notify.ts";

type Spec = Record<string, unknown>;
/** Each group has its own mark so a later group still reaches an instance that already took an earlier one. */
export const DEFAULT_JOBS: { mark: string; why: string; jobs: Record<string, Spec> }[] = [
  {
    // §觉2, §参1. day: done before the 08:30 morning report · week: before the Sunday review · month: before the day-1 review
    mark: "upgrade.lens_jobs", why: "例行镜头任务",
    jobs: {
      lens_day: { every: "day", at: "07:50", do: "lens_day" },
      lens_week: { every: "week", weekday: 0, at: "19:30", do: "lens_week" },
      lens_month: { every: "month", day: 1, at: "06:00", do: "lens_month" },
    },
  },
  {
    // ※ 03 backup: nightly, as the old sbot-backup.timer did; now a hub job so it needs no systemd unit on any OS
    mark: "upgrade.backup_job", why: "每晚备份",
    jobs: { backup: { every: "day", at: "03:30", do: "backup" } },
  },
];

export async function addDefaultJobs(db: Db, configDir: string, groups = DEFAULT_JOBS): Promise<string[]> {
  const pending = groups.filter((g) => !db.kvGet(g.mark));
  if (!pending.length) return [];
  const file = join(configDir, "jobs.yaml");
  let added: string[] = [];
  // no jobs.yaml at all = I have not set one up (or removed it); don't create it behind my back
  if (existsSync(file)) {
    const { result } = await repoQueue(configDir).write((wt) => {
      const f = join(wt, "jobs.yaml");
      const doc = parseDocument(readFileSync(f, "utf8"));
      if (!doc.contents) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
      const cur = (doc.toJS() ?? {}) as Record<string, Spec | null>;
      const out: string[] = [];
      for (const g of pending) for (const [name, spec] of Object.entries(g.jobs)) {
        if (cur[name] || Object.values(cur).some((j) => j?.do === spec.do)) continue;
        doc.set(name, doc.createNode(spec, { flow: true }));
        out.push(name);
      }
      if (out.length) writeFileSync(f, doc.toString());
      return out;
    }, (out) => (out.length ? `jobs.yaml: add ${out.join(", ")} (via upgrade)` : null));
    added = result;
  }
  db.tx(() => {
    for (const g of pending) db.kvSet(g.mark, String(Date.now()));
    if (added.length) db.run("INSERT INTO config_changes(ts, file, diff, source, actor) VALUES (?, ?, ?, 'upgrade', NULL)", Date.now(), "jobs.yaml", `add ${added.join(", ")}`);
  });
  if (added.length) {
    log("config", "default jobs added", { added });
    await notify.admin(`⚙️ **jobs.yaml 加了默认任务**：${added.join("、")}。不想要就在那一行写 enabled: false，或者删掉。`);
  }
  return added;
}
