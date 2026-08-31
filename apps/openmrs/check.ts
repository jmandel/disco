// Live drift check for the OpenMRS O3 function library. Exports check(s) so the runner can drive it
// against a fresh session; also runs standalone against the current session. NOT a *.test.ts, so
// `bun test` never reaches the internet.   One-command form:  bun scripts/run-check.ts openmrs
//
// WRITE FOOTPRINT: no form is ever submitted; every request this check issues is a GET. The app itself
// answers each chart open with `POST /ws/rest/v1/user/<uuid>` (userProperties.patientsVisited — the
// recently-viewed MRU; user preference state, never patient data). See lib.ts's header.
import { connect, type Session } from "../../src/client.ts";
import * as o3 from "./lib.ts";

/** Where run-check points the browser, and the host it scopes the session to. */
export const target = { url: `${o3.SPA}/login`, scope: "dev3.openmrs.org" };
/** The pack's first anchor: an O3 shell is "an empty div + 50 chunks" long before the form exists. */
export const ready = { selector: "#username", visible: true };

const POPULATED = "Michelle Lewis";   // 86F, 33 conditions, 2 drug orders, vitals, 10 visits
const EMPTY = "John Smith";           // 6M, nothing recorded — the empty-state control

export async function check(s: Session): Promise<boolean> {
  let failed = false; let last = Date.now();
  const ok = (label: string, cond: boolean, detail?: unknown) => {
    const now = Date.now(); const ms = now - last; last = now;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}  (${ms}ms)${detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 220) : ""}`);
    if (!cond) failed = true;
  };
  try {
    await o3.login(s);
    ok("login reaches the app shell", true);
    await o3.login(s);
    ok("login is idempotent (no re-navigation when authenticated)", true);

    const p = await o3.findPatient(s, POPULATED);
    ok(`findPatient(${POPULATED}) off the search API body`, p.name.includes("Michelle Lewis") && !!p.uuid, p);

    // past page 1: the overlay body is limit=10; the results page re-asks with limit=50.
    await o3.openSearch(s);
    await s.fill(o3.SEARCH_INPUT, "1000", { budgetMs: 15000, until: { urlLike: "/ws/rest/v1/patient?q=", landed: true, budgetMs: 12000 } });
    const page1 = o3.searchResults(s, "1000");
    await s.press("Enter", { budgetMs: 25000, until: { all: [{ fn: () => location.pathname.includes("/spa/search") }, { urlLike: "limit=50", landed: true }], budgetMs: 20000 } });
    const paged = o3.searchResults(s, "1000");
    ok("search reads past page 1 (overlay limit=10 -> results page limit=50)",
      page1.patients.length === 10 && paged.patients.length > 10 && paged.totalCount > 50,
      { page1: page1.patients.length, paged: paged.patients.length, totalCount: paged.totalCount });

    await o3.openPatient(s, p);
    ok("openPatient reaches the chart anchor", true, { uuid: p.uuid });

    const sum = await o3.extractSummary(s, p.uuid);
    ok("extractSummary: problems off FHIR Condition", sum.problems.length > 0, sum.problems.slice(0, 4));
    ok("extractSummary: medications off REST order", sum.medications.length > 0, sum.medications.map((m) => m.name).slice(0, 3));
    ok("extractSummary: latest vitals off FHIR Observation", sum.vitals.length > 0, sum.vitals.slice(0, 3));
    ok("extractSummary: allergies bundle fetched (may be empty)", Array.isArray(sum.allergies), sum.allergies.slice(0, 3));

    const visits = await o3.listVisits(s, p.uuid);
    ok("listVisits off the wire, newest first", visits.length > 1 && !!visits[0].start && !!visits[0].type,
      { latest: visits[0], n: visits.length });

    // the empty-state control: a patient with nothing recorded must return empty arrays, not throw
    const e = await o3.openPatient(s, EMPTY);
    const esum = await o3.extractSummary(s, e.uuid);
    ok("empty patient yields empty arrays, no throw",
      esum.problems.length === 0 && esum.allergies.length === 0 && esum.medications.length === 0,
      { problems: esum.problems.length, allergies: esum.allergies.length, meds: esum.medications.length, vitals: esum.vitals.length });

    await o3.recoverToShell(s);
    ok("recoverToShell returns to the shell anchor", true);
  } catch (e) {
    console.log("FAIL  threw:", (e as Error).message);
    failed = true;
  }
  console.log(failed ? "\nCHECK FAILED" : "\nCHECK OK");
  return !failed;
}

if (import.meta.main) {
  const s = await connect(process.env.DISCO_APP ?? "openmrs");
  const passed = await check(s).finally(() => s.close());
  process.exit(passed ? 0 : 1);
}
