// Settle / overhead distribution for an app's recorded actions — the measurements defaults.ts says to tune
// from ("settle-time distributions … not taste"). Reads the store only; works with the daemon down.
//   bun scripts/timing-report.ts <app> [--run N]
import { openApp } from "../src/store.ts";

const app = process.argv[2];
if (!app) { console.error("usage: bun scripts/timing-report.ts <app> [--run N]"); process.exit(2); }
const runArg = process.argv.indexOf("--run"); const run = runArg > 0 ? Number(process.argv[runArg + 1]) : null;
const st = openApp(app);
const rows = st.sql<any>(`SELECT run, n, kind, verdict, round(settle_ms) settle_ms,
    json_extract(report,'$.timing.reportedMs') reported_ms, json_extract(report,'$.timing.waitMs') wait_ms,
    json_extract(report,'$.timing.overheadMs') overhead_ms, json_extract(report,'$.timing.totalMs') total_ms,
    json_extract(report,'$.until.elapsedMs') until_ms, json_extract(report,'$.until.matched') until_ok
  FROM actions WHERE verdict IS NOT NULL${run != null ? " AND run=?" : ""} ORDER BY run, n`, ...(run != null ? [run] : []));
st.close();
if (!rows.length) { console.log(`no actions recorded for ${app}${run != null ? ` run ${run}` : ""}`); process.exit(0); }

const q = (xs: number[], p: number) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : NaN; };
const fmt = (xs: number[]) => xs.length ? `p50 ${q(xs, 0.5)}  p90 ${q(xs, 0.9)}  max ${Math.max(...xs)}` : "-";
const by = new Map<string, any[]>();
for (const r of rows) { const k = r.verdict; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
console.log(`${app}: ${rows.length} action(s)${run != null ? ` in run ${run}` : ` across ${new Set(rows.map((r) => r.run)).size} run(s)`}\n`);
console.log(`${"verdict".padEnd(18)} ${"n".padStart(4)}  ${"settle_ms".padEnd(28)} ${"wait_ms (page)".padEnd(28)} ${"overhead_ms (daemon)".padEnd(28)}`);
for (const [verdict, rs] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const num = (k: string) => rs.map((r) => Number(r[k])).filter(Number.isFinite);
  console.log(`${verdict.padEnd(18)} ${String(rs.length).padStart(4)}  ${fmt(num("settle_ms")).padEnd(28)} ${fmt(num("wait_ms")).padEnd(28)} ${fmt(num("overhead_ms")).padEnd(28)}`);
}
const untils = rows.filter((r) => r.until_ms != null);
if (untils.length) console.log(`\nuntil: ${untils.length} action(s), matched ${untils.filter((r) => r.until_ok).length}; elapsed ${fmt(untils.map((r) => Number(r.until_ms)))}`);
const ov = rows.map((r) => Number(r.overhead_ms)).filter(Number.isFinite);
if (ov.length) console.log(`\noverhead share: ${Math.round(100 * ov.reduce((a, b) => a + b, 0) / rows.map((r) => Number(r.total_ms)).filter(Number.isFinite).reduce((a, b) => a + b, 0))}% of total act() time is daemon work (resolve + snapshots + report build)`);
