// extract-rows.ts [--json] — the full "Virtualized rows" dataset, from the WIRE, not the DOM.
// Write footprint: READ-ONLY (at most one GET /api/rows).
// The DOM renders only ~23 recycled rows of 10,000 (act:16); the complete list is in the
// GET /api/rows response body (484.7KB JSON, wire-available fact — ledger.md). Strategy:
// reuse the latest captured body from the store if one exists; otherwise click #load-rows once.
import { connect } from "../../src/client.ts";

const s = await connect();
const die = (msg: string, extra?: unknown) => { console.error("FAIL:", msg, extra ? JSON.stringify(extra).slice(0, 800) : ""); s.close(); process.exit(1); };

let hash = s.store.sql<any>("SELECT body_hash FROM requests WHERE path='/api/rows' AND status=200 AND body_hash IS NOT NULL ORDER BY t_start DESC LIMIT 1")[0]?.body_hash;
let via = "store (previously captured)";
if (!hash) {
  const pre = await s.evaluate(() => !!document.getElementById("load-rows"));
  if (!pre) die("precondition: #load-rows not on screen and no captured /api/rows body in store");
  const r: any = await s.click("#load-rows", { budgetMs: 8000 });
  const req = (r.wire?.attributed ?? []).find((x: any) => x.family?.includes("/api/rows"));
  if (!req?.body) die("clicked #load-rows but no attributed /api/rows body", { verdict: r.verdict, wire: r.wire });
  hash = req.body; via = `fresh click (${r.action})`;
}
const rows: Array<{ id: number; name: string; group: string }> = s.store.json(hash);
if (process.argv.includes("--json")) { console.log(JSON.stringify(rows)); s.close(); process.exit(0); }
const groups: Record<string, number> = {};
for (const row of rows) groups[row.group] = (groups[row.group] ?? 0) + 1;
console.log(JSON.stringify({ ok: true, via, count: rows.length, first: rows[0], last: rows.at(-1), groups }, null, 1));
s.close();
