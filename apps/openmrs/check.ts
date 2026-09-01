// apps/openmrs/check.ts — proves apps/openmrs/lib.ts still drives dev3.openmrs.org.
// Run from the repo root:  node scripts/run-check.ts openmrs
//
// dev3 is a shared, resettable demo server: patient uuids, list contents and queue
// contents all change. Every assertion below is therefore about SHAPE (a bundle, a
// results array, a uuid that matches the one we asked for), never about a named
// patient — except that the check discovers one patient by searching, then follows it.
import { type Session } from "../../src/index.ts";
import * as o from "./lib.ts";

export const target = { url: o.LOGIN_URL };

const ok = (cond: unknown, what: string) => { if (!cond) throw new Error(what); };

export async function check(s: Session, step: (name: string, fn: () => unknown) => Promise<unknown>) {
  let patient = { uuid: "", name: "" };

  await step("log in and reach the shell", async () => {
    const r = await o.ensureLoggedIn(s, "admin", "Admin123");
    const me = await o.whoami(s);
    ok(me.authenticated, `session says not authenticated after ${r.act}`);
    ok(me.user === "admin", `logged in as ${me.user}, want admin`);
    ok(!!me.location, "no session location");
  });

  await step("search patients by identifier prefix", async () => {
    const r = await o.searchPatients(s, "1000");
    ok(r.hits.length > 0, `no hits for "1000" (${r.act})`);
    ok(r.hits.every((h) => !!h.uuid && !!h.name), `hit missing uuid/name: ${JSON.stringify(r.hits[0])}`);
    patient = { uuid: r.hits[0].uuid, name: r.hits[0].name };
  });

  await step("open that patient's chart; demographics come off FHIR", async () => {
    const r = await o.openChart(s, patient.uuid);
    ok(r.demographics.uuid === patient.uuid, `chart is for ${r.demographics.uuid}, want ${patient.uuid}`);
    ok(!!r.demographics.gender, "no gender on the FHIR Patient");
    ok(r.demographics.identifiers.length > 0, "no identifiers on the FHIR Patient");
  });

  await step("conditions tab -> a FHIR searchset Bundle", async () => {
    const r = await o.conditions(s, patient.uuid);
    ok(r.body?.resourceType === "Bundle", `conditions body is ${r.body?.resourceType} (${r.act})`);
    ok(typeof r.body.total === "number", "conditions bundle has no total");
  });

  await step("allergies tab -> a FHIR searchset Bundle", async () => {
    const r = await o.allergies(s, patient.uuid);
    ok(r.body?.resourceType === "Bundle", `allergies body is ${r.body?.resourceType} (${r.act})`);
  });

  await step("vitals tab -> FHIR Observations", async () => {
    const r = await o.vitals(s, patient.uuid);
    ok(r.body?.resourceType === "Bundle", `vitals body is ${r.body?.resourceType} (${r.act})`);
    const kinds = o.bundleEntries(r.body, (x: any) => x?.resourceType);
    ok(kinds.length === 0 || kinds.every((k: string) => k === "Observation"),
       `vitals bundle carries ${[...new Set(kinds)].join(",")}`);
  });

  await step("clinical forms workspace opens, lists forms, and closes", async () => {
    const r = await o.clinicalForms(s, patient.uuid);
    ok(r.forms.length > 0, `no forms listed (${r.act})`);
    ok(r.forms.every((f) => !!f.name), `form row without a name: ${JSON.stringify(r.forms[0])}`);
    const still = await s.until({ selector: o.anchors.workspace.el }, { timeout: 800 });
    ok(!still.until?.ok, "workspace still open after clinicalForms()");
  });

  await step("patient lists, and the members of the first non-empty one", async () => {
    const r = await o.patientLists(s);
    ok(r.lists.length > 0, `no patient lists (${r.act})`);
    const nonEmpty = r.lists.find((l) => (l.size ?? 0) > 0);
    if (!nonEmpty) return;                                    // legitimate on a reset demo
    const m = await o.openPatientList(s, nonEmpty.uuid);
    ok(m.members.length > 0, `list ${nonEmpty.name} says size ${nonEmpty.size} but has no members (${m.act})`);
    ok(m.members.every((x) => !!x.uuid), "member without a patient uuid");
  });

  await step("service queues: queue entries for the session location", async () => {
    const r = await o.serviceQueues(s);
    ok(Array.isArray(r.entries), `queue entries not an array (${r.act})`);
    ok(r.entries.every((e) => !!e.patientUuid), "queue entry without a patient uuid");
  });

  await step("appointments for today", async () => {
    const r = await o.appointmentsForDate(s);
    ok(Array.isArray(r.appointments), `appointments not an array (${r.act})`);
  });

  await step("log out; bad credentials are refused; log back in", async () => {
    const out = await o.logout(s);
    const anon = await o.whoami(s);
    ok(!anon.authenticated, `still authenticated after logout (${out.act})`);
    // Only meaningful while logged out: with a live session cookie the login page
    // redirects to the shell and every password "works".
    const bad = await o.login(s, "admin", "definitely-not-the-password");
    ok(bad.which === "bad-credentials", `bad password gave which=${bad.which} (${bad.act})`);
    const back = await o.login(s);
    ok(back.which === "shell", `could not log back in: ${back.which} (${back.act})`);
    const me = await o.whoami(s);
    ok(me.authenticated && me.user === "admin", `back in as ${me.user}`);
  });
}
