// Sentinel's backup checks on a throwaway home (offline):
//   ssh <server> 'bash -s backup-sentinel.ts 7829' < test/vps-test-home.sh
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { P } from "../src/config.ts";
import { checks } from "../src/sentinel.ts";

const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const keys = async () => (await checks()).map((f) => f.key);
const bo = join(P.home, "backup-out"), H = 3600_000, ago = (h: number) => new Date(Date.now() - h * H);
ok(!(await keys()).some((k) => k.startsWith("backup.")), "no backup-out yet → quiet");
mkdirSync(join(bo, "2026-11-16"), { recursive: true });
writeFileSync(join(bo, "pulled"), "2026-11-16\n");
ok(!(await keys()).some((k) => k.startsWith("backup.")), "fresh backup, fresh pull → quiet");
utimesSync(join(bo, "2026-11-16"), ago(40), ago(40));
ok((await keys()).includes("backup.nightly"), "no new backup for 40 h → alert");
utimesSync(join(bo, "pulled"), ago(80), ago(80));
const f = (await checks()).find((x) => x.key === "backup.offsite");
ok(f && /3 天没拉/.test(f.text), `Mac hasn't pulled for 80 h → alert (${f?.text})`);
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
