// Release notices (release.ts) across a fake deploy history, on a throwaway home (offline):
//   ssh <server> 'bash -s release-smoke.ts 7829' < test/vps-test-home.sh
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { P } from "../src/config.ts";
import { releaseNotice, revision } from "../src/release.ts";

const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const sha = (c: string) => c.repeat(40);
const commits = ["d", "c", "b", "a"].map((c) => ({ sha: sha(c), subject: `commit ${c}` }));   // newest first
const dir = join(P.home, "fake-release");
mkdirSync(dir, { recursive: true });
const at = (c: string, rollbackFrom?: string) => {   // what sbot-deploy writes for a release at commit c
  const i = commits.findIndex((x) => x.sha === sha(c));
  writeFileSync(join(dir, "REVISION"), `${sha(c)}\n2026-11-17T12:00:00+08:00\ncommit ${c}\n`);
  writeFileSync(join(dir, "HISTORY"), commits.slice(i).map((x) => `${x.sha} ${x.subject}`).join("\n") + "\n");
  if (rollbackFrom) writeFileSync(join(dir, "ROLLBACK_FROM"), sha(rollbackFrom) + "\n"); else rmSync(join(dir, "ROLLBACK_FROM"), { force: true });
};

ok(revision(dir) === null && releaseNotice(dir) === null, "dev checkout (no REVISION) → quiet");
at("a");
ok(revision(dir)?.subject === "commit a", "revision is read");
let n = releaseNotice(dir);
ok(n?.startsWith("**⬆️ 已部署**") && n.includes("commit a"), `first deploy → 已部署 (${n?.split("\n")[0]})`);
ok(releaseNotice(dir) === null, "restart on the same release → quiet");
at("c");
n = releaseNotice(dir);
ok(n?.includes("已更新") && n.includes("commit c") && n.includes("commit b") && !n.includes("commit a"), `a → c lists b and c only (${n?.replace(/\n/g, " | ")})`);
at("c", "d");   // d failed (without getting as far as a notice), c is back with the marker
n = releaseNotice(dir);
ok(n?.includes("更新没成功") && n.includes("dddddd"), `rollback from d → warning (${n?.split("\n")[0]})`);
ok(releaseNotice(dir) === null, "restart after the rollback → quiet");
at("a");
n = releaseNotice(dir);
ok(n?.includes("已切到"), `manual roll back to an older commit → 已切到 (${n?.split("\n")[0]})`);
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
