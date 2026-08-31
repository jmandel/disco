// Function library for OpenEMR (product instance #2). Plain, importable, composable, anchor-oriented,
// wire-first, defensive functions — the durable asset of the pack (PLATFORM.md palette #4). Built and
// validated against the hosted demo (demo.openemr.io, 8.3.0). The engineering is in robustness — reaching
// known anchor states and handling rough edges — not in any format. Future: wrap as MCP tools; the live
// drift check is `check.ts`.
//
//   import { connect } from "../../src/client.ts";
//   import * as emr from "./lib.ts";
//   const s = await connect("openemr2");
//   await emr.login(s, { user: "physician", pass: "physician" });
//   const p = await emr.findPatient(s, "Belford");
//   await emr.openPatient(s, p.pid);
//   const { problems } = await emr.extractSummary(s);   // off the chart, robustly
//
import type { Session } from "../../src/client.ts";
import { extractFromWire, wireHas } from "../../lib/wire.ts";
import { reached, until, waitForFrame } from "../../lib/nav.ts";

export const INSTANCES = {
  main: "https://demo.openemr.io/openemr",
  a: "https://demo.openemr.io/a/openemr",
  b: "https://demo.openemr.io/b/openemr",
};
export const DEFAULT_BASE = INSTANCES.a;
export const DEMO_CREDENTIALS = { physician: "physician", clinician: "clinician", admin: "pass", receptionist: "receptionist" };
const FINDER_FRAME = "dynamic_finder.php";
const CHART_FRAME = "demographics.php";

// ---- anchors (GUIDANCE §7.3, §9): reliably reach a named state, or throw a clear error ----

/** Anchor: the main application shell (logged in, tab bar present). */
export async function assertMainShell(s: Session, budgetMs = 15000): Promise<void> {
  await until(s, { fn: () => location.href.includes("main/tabs/main.php") }, { budgetMs, msg: "assertMainShell: not at the app shell" });
}

/** Anchor: a patient chart dashboard is open (optionally for a specific pid). */
export async function assertChart(s: Session, pid?: number, budgetMs = 15000): Promise<void> {
  // `frame:` on a predicate also waits for the frame itself to appear (watch re-resolves it per check)
  await until(s, { selector: "#medical_problem_ps_expand" }, { frame: CHART_FRAME, budgetMs, msg: `assertChart: chart dashboard not reached${pid != null ? ` for pid ${pid}` : ""}` });
}

// ---- steps ----

/** Log in and reach the main-shell anchor. Idempotent: if already authenticated, just verifies the shell.
 *  (Login redirect + shell build is ~6-7s on the demo — the network detector holds settlement, no sleeps.) */
export async function login(s: Session, opts: { user?: string; pass?: string; base?: string } = {}): Promise<void> {
  const base = opts.base ?? DEFAULT_BASE;
  const user = opts.user ?? "physician";
  const pass = opts.pass ?? DEMO_CREDENTIALS[user as keyof typeof DEMO_CREDENTIALS] ?? "physician";
  // Idempotent & reload-free: if already in the shell, don't re-navigate (a needless top nav rebuilds
  // every child frame). Only go to the login page when we're not already authenticated.
  const authed = await s.evaluate<boolean>(() => location.href.includes("main/tabs/main.php")).catch(() => false);
  if (!authed) await s.navigate(`${base}/index.php`, { budgetMs: 15000 });
  if (await s.evaluate<boolean>(() => !!document.querySelector("#authUser")).catch(() => false)) {
    await s.fill("#authUser", user);
    await s.fill("#clearPass", pass);
    // Login redirect + shell build is ~6-7s on the demo: the network detector holds settlement, and the
    // postcondition is the shell URL (the main-world predicate simply reads false while documents swap).
    reached(await s.click("#login-button", { budgetMs: 20000, until: { fn: () => location.href.includes("main/tabs/main.php"), budgetMs: 25000 } }), "login: submit");
  }
  await assertMainShell(s);
}

/** Open the Patient Finder tab (idempotent) and ensure its patient-list JSON is captured on the wire. */
export async function openFinder(s: Session): Promise<void> {
  await assertMainShell(s);
  // Always click Finder: it opens the tab or FOCUSES it if already open. Skipping when the frame merely
  // exists leaves a background finder whose rows aren't hit-testable while another tab is active.
  const r = await s.click("text=Finder", { budgetMs: 12000 });
  if (r.verdict === "diagnosis") throw new Error("openFinder: could not click Finder");
  await waitForFrame(s, FINDER_FRAME, 12000);
  // the finder's list JSON is the fact source; wait for it to land unless a previous open already captured it
  if (!wireHas(s.store, "dynamic_finder_ajax")) await until(s, { urlLike: "dynamic_finder_ajax", landed: true }, { budgetMs: 8000 }).catch(() => {});
}

export interface Patient { pid: number; name: string; dob: string; externalId: string }

/** Parse the finder's most-recent list JSON from the wire (first page, or the current filter). */
function readFinder(s: Session): Patient[] {
  const data = extractFromWire<{ aaData?: Array<Record<string, string>> }>(s.store, { urlLike: "dynamic_finder_ajax", optional: true });
  return (data?.aaData ?? []).map((r) => ({ pid: Number(String(r.DT_RowId).replace("pid_", "")), name: r["0"], dob: r["3"], externalId: r["4"] }));
}

/** The patient list currently loaded in the finder (its first page, or the active filter). */
export async function listPatients(s: Session): Promise<Patient[]> {
  await openFinder(s);
  return readFinder(s);
}

/** Find a patient by case-insensitive name. Uses the finder's name-search so it works beyond page 1,
 *  and leaves that patient's row visible (so openPatient can click it). */
export async function findPatient(s: Session, name: string): Promise<Patient> {
  await openFinder(s);
  const hit = (rows: Patient[]) => rows.find((r) => r.name.toLowerCase().includes(name.toLowerCase()));
  let found = hit(readFinder(s));
  if (!found) {
    // Search by the first name token (the column filter matches poorly on the full "Last, First" string).
    // fill() replaces any residual filter; the postcondition is the per-keystroke ajax LANDING (the until tail
    // then absorbs the later keystrokes' requests), after which the newest list is re-read.
    const term = (name.split(/[,\s]+/).filter(Boolean)[0] ?? name);
    reached(await s.fill('css=input[placeholder="Search by Name"]', term, { frame: FINDER_FRAME, until: { urlLike: "dynamic_finder_ajax", landed: true, budgetMs: 8000 } }), "findPatient: finder name search");
    found = hit(readFinder(s));
  }
  if (!found) throw new Error(`findPatient: no patient matching ${JSON.stringify(name)}`);
  return found;
}

/** Open a patient's chart by pid or name and reach the chart anchor. For a name it searches the finder so
 *  the row is visible; for a pid it assumes the row is on the finder's current page (open by name to reach
 *  patients past page 1). The "due clinical reminders" native alert, if any, is auto-accepted by policy. */
export async function openPatient(s: Session, target: number | string): Promise<number> {
  let pid: number;
  if (typeof target === "string") { pid = (await findPatient(s, target)).pid; }        // search leaves the row visible
  else { pid = target; await openFinder(s); }
  // The postcondition of a finder-row click lives in a DIFFERENT frame — the chart frame the click creates —
  // so `until` names it (`frame:`); the frame is waited for, then the dashboard landmark inside it.
  reached(await s.click(`#pid_${pid}`, { frame: FINDER_FRAME, budgetMs: 15000, until: { selector: "#medical_problem_ps_expand", frame: CHART_FRAME, budgetMs: 20000 } }), `openPatient(${pid}): finder row (on the current page? open by name to search)`);
  await assertChart(s, pid);
  return pid;
}

export interface ChartSummary { problems: string[]; allergies: string[]; medications: string[] }

/** Read problems / allergies / medications from the open chart dashboard (robust DOM read of the summary
 *  cards; the same facts are also wire-available in the summary POST fragments). Requires a chart open. */
export async function extractSummary(s: Session): Promise<ChartSummary> {
  await assertChart(s);
  // The summary cards are populated by async fragment POSTs a beat after the frame appears; wait for
  // content to land (or a short budget, for patients who genuinely have none). Entries render as
  // .list-group-item after the fragment loads, or as <a> in the initial pass — read either.
  const readOnce = () => s.evaluate<ChartSummary>(() => {
    const read = (id: string): string[] => {
      const c = document.getElementById(id);
      if (!c) return [];
      const items = [...c.querySelectorAll(".list-group-item")].map((e) => (e.textContent || "").replace(/\s+/g, " ").trim());
      const fromAnchors = [...c.querySelectorAll("a")].map((a) => (a.textContent || "").trim());
      return [...new Set((items.length ? items : fromAnchors).filter((t) => t && t.length < 120 && !/^(nothing recorded|none|no data)$/i.test(t)))];
    };
    return { problems: read("medical_problem_ps_expand"), allergies: read("allergy_ps_expand"), medications: read("medication_ps_expand") };
  }, { frame: CHART_FRAME });
  // wait (bounded) for any card to carry an entry — a patient may genuinely have none, so expiry is not an error
  await until(s, { fn: () => ["medical_problem_ps_expand", "allergy_ps_expand", "medication_ps_expand"].some((id) => !!document.getElementById(id)?.querySelector(".list-group-item, a")) }, { frame: CHART_FRAME, budgetMs: 6000 }).catch(() => {});
  return readOnce();
}

/** Convenience: just the problem list from the open chart. */
export async function extractProblemList(s: Session): Promise<string[]> {
  return (await extractSummary(s)).problems;
}
