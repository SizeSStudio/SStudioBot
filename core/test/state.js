// Print recent inbox/runs/outbox metadata (no message text). On the VPS: sudo -u sbot node - < state.js
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync("/srv/sbot/db/sbot.db", { readOnly: true });
const since = Date.now() - Number(process.env.MIN ?? 30) * 60e3;
console.table(d.prepare("SELECT id, source, kind, status, run_id FROM inbox WHERE ts > ? ORDER BY id").all(since));
console.table(d.prepare(`SELECT r.id run, r.status, r.stop_reason, r.side_effects se,
  (SELECT group_concat(o.kind || '/' || o.status, ', ') FROM outbox o WHERE o.run_id = r.id) outbox
  FROM runs r WHERE r.started > ? ORDER BY r.started`).all(since));
