// Written by a fresh agent from README + docs/using-disco.md ALONE (no src/), first try, during the 2026-08-30 cold run
// (demos/friction-coldrun.md Part 3). Connects to the CURRENT running app session (e.g. after demo 2) and loads the rows
// with a postcondition on the click.   bun demos/04-rows-from-docs-alone.ts
// Cold-run exercise (docs only): click "Load Rows" WITH the postcondition that /api/rows has landed,
// then read the full row set off the wire.   bun demos/coldrun-rows.ts   (needs a running gauntlet session)
import { connect } from "../src/client.ts";

const s = await connect("gauntlet");                                     // README "The library": connect("name")
const r = await s.click('role=button[name="Load Rows"]', { until: { urlLike: "/api/rows", landed: true } });

console.log("1. verdict:", r.verdict);
console.log(`2. until: matched=${r.until?.matched} after ${r.until?.elapsedMs}ms`);

const w = r.wire!.attributed.find((x) => x.p === "/api/rows");          // structured fields (m, p, s, ms, body), not `line`
const rows: Array<{ id: number; name: string; group: string }> = s.store.json(w!.body!);
const row = rows.find((x) => x.id === 9741) ?? rows[9741];
console.log(`3. rows off the wire: ${rows.length} (${w!.m} ${w!.p} → ${w!.s}, ${w!.ms}ms); row 9741 = ${JSON.stringify(row)}`);

const t = r.timing!;
console.log(`4. timing: page ${t.waitMs}ms (settled ${t.settleMs}, reported ${t.reportedMs}${t.untilMs != null ? `, until ${t.untilMs}` : ""}) + overhead ${t.overheadMs}ms (resolve ${t.resolveMs}, pre ${t.preMs}, post ${t.postMs}, build ${t.buildMs})${t.absorbMs ? ` + scroll-absorb ${t.absorbMs}ms` : ""} = ${t.totalMs}ms`);
s.close();
