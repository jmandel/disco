// node scripts/stats.ts <app> [run] [--json]
// The session scorecard, from the log alone: what the acts cost, where budgets were burned, what was diagnosed.
// This is how a stranger round becomes a number instead of a story.
import { openStore, appStoreDir } from "../src/store.ts";

const argv = process.argv.slice(2);
const app = argv.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const onlyRun = argv.find((a) => /^\d+$/.test(a));
const json = argv.includes("--json");
if (!app) { console.error("usage: node scripts/stats.ts <app> [run] [--json]"); process.exit(2); }

const st = openStore(appStoreDir(app));
const runs = st.sql<{ run: number; started_wall: string; ended_wall: string | null; mode: string }>("SELECT run, started_wall, ended_wall, mode FROM runs ORDER BY run");
const acts = st.sql<{ run: number; id: string; n: number; t0: number; t1: number | null; label: string; ok: number; report: string | null }>("SELECT run, id, n, t0, t1, label, ok, report FROM actions ORDER BY run, n");

interface RunStats {
  run: number; started: string; ended: string | null; wallMin: number;
  acts: number; failed: number; withUntil: number; bare: number;
  untilFailed: number; alreadyTrue: number; returned: Record<string, number>; diagnoses: Record<string, number>;
  /** seconds spent on waits that never came: failed untils + failed acts' run time + bare acts that ran to max */
  expiredS: number; untilFailedS: number; actFailedS: number; bareMaxS: number;
  /** seconds spent in quiet observation of bare acts */
  quietS: number;
  reportMsAvg: number; reportMsMax: number;
  clean: boolean;
}
const out: RunStats[] = [];
for (const r of runs) {
  if (onlyRun && r.run !== Number(onlyRun)) continue;
  const mine = acts.filter((a) => a.run === r.run);
  const s: RunStats = { run: r.run, started: r.started_wall, ended: r.ended_wall, wallMin: 0, acts: mine.length, failed: 0, withUntil: 0, bare: 0, untilFailed: 0, alreadyTrue: 0, returned: {}, diagnoses: {}, expiredS: 0, untilFailedS: 0, actFailedS: 0, bareMaxS: 0, quietS: 0, reportMsAvg: 0, reportMsMax: 0, clean: true };
  let reportSum = 0, reportN = 0;
  for (const a of mine) {
    let rep: any = null; try { rep = a.report ? JSON.parse(a.report) : null; } catch {}
    if (!a.ok) { s.failed++; s.clean = false; }
    if (!rep) continue;
    s.returned[rep.returned] = (s.returned[rep.returned] ?? 0) + 1;
    if (rep.until) { s.withUntil++; if (!rep.until.ok) { s.untilFailed++; s.clean = false; s.untilFailedS += (rep.until.elapsedMs ?? 0) / 1000; } if (rep.until.alreadyTrue) { s.alreadyTrue++; s.clean = false; } }
    else { s.bare++; if (rep.returned === "quiet") s.quietS += (rep.timing?.observeMs ?? 0) / 1000; if (rep.returned === "max") s.bareMaxS += (rep.timing?.observeMs ?? 0) / 1000; }
    if (!a.ok) { s.actFailedS += (rep.timing?.runMs ?? 0) / 1000; const reason = rep.diagnosis?.reason ?? "error"; s.diagnoses[reason] = (s.diagnoses[reason] ?? 0) + 1; }
    if (rep.timing?.reportMs != null) { reportSum += rep.timing.reportMs; reportN++; s.reportMsMax = Math.max(s.reportMsMax, rep.timing.reportMs); }
  }
  s.expiredS = round1(s.untilFailedS + s.actFailedS + s.bareMaxS); s.untilFailedS = round1(s.untilFailedS); s.actFailedS = round1(s.actFailedS); s.bareMaxS = round1(s.bareMaxS); s.quietS = round1(s.quietS);
  s.reportMsAvg = reportN ? Math.round(reportSum / reportN) : 0;
  const t0 = mine[0]?.t0, t1 = mine.at(-1)?.t1 ?? mine.at(-1)?.t0;
  s.wallMin = t0 != null && t1 != null ? Math.round(((t1 - t0) / 60000) * 10) / 10 : 0;
  out.push(s);
}
st.close();

if (json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
if (!out.length) { console.log(`${app}: no runs`); process.exit(0); }
console.log(`${app}: ${out.length} run(s)\n`);
console.log(["run", "started", "acts", "fail", "until", "bare", "untilX", "already", "expired_s", "quiet_s", "report_ms", "min", "clean"].join("\t"));
for (const s of out) console.log([s.run, s.started.slice(0, 16), s.acts, s.failed, s.withUntil, s.bare, s.untilFailed, s.alreadyTrue, s.expiredS, s.quietS, `${s.reportMsAvg}/${s.reportMsMax}`, s.wallMin, s.clean ? "yes" : "no"].join("\t"));
const diag: Record<string, number> = {}; const ret: Record<string, number> = {};
for (const s of out) { for (const [k, v] of Object.entries(s.diagnoses)) diag[k] = (diag[k] ?? 0) + v; for (const [k, v] of Object.entries(s.returned)) ret[k] = (ret[k] ?? 0) + v; }
console.log(`\nreturned: ${Object.entries(ret).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
console.log(`diagnoses: ${Object.entries(diag).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
console.log(`expired budget total: ${round1(out.reduce((a, s) => a + s.expiredS, 0))} s (failed untils ${round1(out.reduce((a, s) => a + s.untilFailedS, 0))} · failed acts ${round1(out.reduce((a, s) => a + s.actFailedS, 0))} · bare acts that hit max ${round1(out.reduce((a, s) => a + s.bareMaxS, 0))})`);
console.log(`already-true refusals: ${out.reduce((a, s) => a + s.alreadyTrue, 0)}`);
const firstClean = out.find((s) => s.clean && s.acts > 0);
console.log(`first clean run: ${firstClean ? `run ${firstClean.run} at ${firstClean.started}` : "none"}`);
function round1(n: number) { return Math.round(n * 10) / 10; }
