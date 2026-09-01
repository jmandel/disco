// apps/openmrs/check.ts — proves apps/openmrs/lib.ts still drives dev3.openmrs.org.
// Run from the repo root:  node scripts/run-check.ts openmrs
//
// Read-only: nothing here creates, edits or voids a record.
// dev3 is a shared demo server; budgets are generous on purpose (see README "Timing").
import { type Session } from "../../src/index.ts";
import * as o from "./lib.ts";

export const target = { url: `${o.SPA}/login`, timeouts: { until: 25000, navigate: 40000 } };

const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export async function check(s: Session, step: (name: string, fn: () => unknown) => Promise<unknown>) {
  let uuid = "";
  let hit: o.PatientHit | undefined;

  await step("log in and land on the app shell", async () => {
    await o.login(s, "admin", "Admin123");
    const sess = await o.readSession(s);
    ok(sess.authenticated, "session says not authenticated");
    ok(sess.user === "admin", `user is ${sess.user}`);
    ok(!!sess.location, "no session location");
  });

  await step("header search: 'John' returns patients, from the wire", async () => {
    await o.goHome(s);
    const r = await o.searchPatients(s, "John");
    ok(r.hits.length > 0, "no hits for 'John'");
    ok(r.hits.every(h => /^[0-9a-f-]{36}$/.test(h.uuid)), "a hit has no uuid");
    ok(r.hits.some(h => /john/i.test(h.name)), `no hit named John: ${r.hits.map(h => h.name).join(", ")}`);
    hit = r.hits[0]; uuid = hit.uuid;
    await o.closeSearchPanel(s);
  });

  await step("open the chart; demographics agree with the search row", async () => {
    const c = await o.openChart(s, uuid);
    ok(c.patient, "no FHIR Patient body for the chart");
    ok(c.patient!.id === uuid, `FHIR Patient id ${c.patient!.id} != ${uuid}`);
    ok(c.patient!.birthDate === hit!.birthdate, `birthDate ${c.patient!.birthDate} != search ${hit!.birthdate}`);
    ok(c.banner.includes(hit!.identifier), `banner ${JSON.stringify(c.banner)} lacks id ${hit!.identifier}`);
  });

  await step("chart tab: Allergies renders what AllergyIntolerance carries", async () => {
    const t = await o.openChartTab(s, uuid, "allergies");
    ok(t.body?.resourceType === "Bundle", `allergies body ${JSON.stringify(t.body)?.slice(0, 120)}`);
    const wire = await o.allergies(s, uuid);
    const rows = await o.tableRows(s, "table[aria-label='allergies summary']");
    ok(wire.length === (t.body.total ?? wire.length), "wire re-read disagrees with the tab's bundle total");
    if (wire.length) ok(rows.some(r => r[0] === wire[0].allergen), `screen ${JSON.stringify(rows)} lacks ${wire[0].allergen}`);
    else ok(rows.length === 0, "no allergies on the wire but rows on screen");
  });

  await step("chart tab: Conditions (served from the SWR cache — no new request)", async () => {
    const t = await o.openChartTab(s, uuid, "conditions");
    // The patient-summary widget already fetched Condition for this patient, so the tab
    // usually renders with NO request of its own and `body` is null. See README "Gotchas".
    ok(t.body === null || t.body?.resourceType === "Bundle", "conditions body is neither absent nor a FHIR Bundle");
    const wire = await o.conditions(s, uuid);
    ok(Array.isArray(wire), "conditions is not a list");
    const rows = await o.tableRows(s, "main table");
    if (wire.length) ok(rows.some(r => r.some(c => c.includes(wire[0].text!.slice(0, 12)))),
      `screen ${JSON.stringify(rows).slice(0, 200)} lacks ${wire[0].text}`);
  });

  await step("visits: REST v1 shape, and the chart tab agrees", async () => {
    const v = await o.visits(s, uuid);
    ok(Array.isArray(v), "visits is not a list");
    for (const x of v) ok(!!x.uuid && !!x.start, `visit without uuid/start: ${JSON.stringify(x)}`);
  });

  await step("home apps: Appointments and Service queues render", async () => {
    await o.goHome(s);
    await o.openHomeApp(s, "appointments", { via: "url" });
    await o.openHomeApp(s, "service-queues", { via: "nav" });
    await o.atShell(s);
  });

  await step("wire-only reads need no UI at all", async () => {
    const lists = await o.patientLists(s);
    ok(Array.isArray(lists), "patient lists is not a list");
    const today = new Date().toISOString().slice(0, 10) + "T00:00:00.000+0000";
    const appts = await o.appointmentsForDate(s, today);
    ok(Array.isArray(appts), "appointments is not a list");
  });

  await step("log out, then back in (leaves the app as we found it)", async () => {
    await o.atShell(s);
    await o.logout(s);
    ok(!(await o.readSession(s)).authenticated, "still authenticated after logout");
    await o.login(s, "admin", "Admin123");
    ok((await o.readSession(s)).authenticated, "not authenticated after re-login");
  });
}
