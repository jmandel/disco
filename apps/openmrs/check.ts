// apps/openmrs/check.ts — proves apps/openmrs/lib.ts still drives dev3.openmrs.org.
// Run from the repo root:  node scripts/run-check.ts openmrs
//
// READ steps are pure reads. WRITE steps create records that are obviously synthetic and
// carry the marker "DISCOTEST" / family name "Zzdiscotest": one patient per run, plus that
// patient's visit, vitals encounter, condition, allergy, lab order and queue entry, plus one
// patient list. Nothing edits or deletes a record this pack did not create.
// Every write step verifies its effect by RE-READING the server, never by the toast.
//
// Cleanup handle:  GET /openmrs/ws/rest/v1/patient?q=Zzdiscotest
//                  GET /openmrs/ws/rest/v1/cohortm/cohort   (names containing DISCOTEST)
//                  or, in a session:  await o.findMarkedRecords(s)
import { type Session } from "../../src/index.ts";
import * as o from "./lib.ts";

export const target = { url: o.LOGIN };

const ok = (cond: unknown, what: string) => { if (!cond) throw new Error(what); };

export async function check(s: Session, step: (name: string, fn: () => unknown) => Promise<unknown>) {
  let demoPatient = "";
  // the record this run creates, threaded through the write steps
  const mine: { uuid: string; id: string; listName: string; listUuid: string; encounterUuid: string } =
    { uuid: "", id: "", listName: "", listUuid: "", encounterUuid: "" };

  // ------------------------------------------------------------------ reads

  await step("login lands on the home shell", async () => {
    const r = await o.login(s);
    ok(r.session.authenticated, "session.authenticated is false after login");
    ok(r.session.user === "admin", `user is ${r.session.user}`);
    ok(!!r.session.location, "no session location");
  });

  await step("patient search reads results off the wire", async () => {
    const r = await o.searchPatients(s, "Miller");
    ok(r.results.length >= 1, `no search results (${r.results.length})`);
    ok(r.results.every((p) => /^[0-9a-f-]{36}$/.test(p.uuid)), "a result has no uuid");
    demoPatient = r.results[0].uuid;
  });

  await step("open a chart; identity comes from FHIR Patient", async () => {
    const r = await o.openChart(s, demoPatient);
    ok(r.patient, "no FHIR Patient on the wire");
    ok(r.patient!.uuid === demoPatient, `chart shows ${r.patient!.uuid}`);
    ok(!!r.patient!.name && !!r.patient!.birthDate, "patient has no name/birthDate");
  });

  await step("chart tabs: conditions, vitals, visits", async () => {
    const c = await o.conditions(s, demoPatient);
    ok(Array.isArray(c.rows) && c.rows.every((x) => !!x.id), "conditions did not parse");
    const v = await o.vitals(s, demoPatient);
    ok(v.total > 0 && v.latest.some((x) => x.value), "no vitals observations");
    const vi = await o.visits(s, demoPatient);
    ok(Array.isArray(vi.rows), "visits did not parse");
  });

  await step("clinical forms catalogue is readable", async () => {
    const r = await o.clinicalForms(s);
    ok(r.forms.length > 0, "no clinical forms offered");
  });

  await step("service queues + patient lists dashboards", async () => {
    const q = await o.serviceQueue(s);
    ok(Array.isArray(q.entries), "queue entries did not parse");
    const l = await o.patientLists(s);
    ok(l.lists.length > 0, "no patient lists");
    const nonEmpty = l.lists.find((x) => (x.size ?? 0) > 0) ?? l.lists[0];
    const m = await o.openPatientList(s, nonEmpty.uuid);
    ok(Array.isArray(m.members), "members did not parse");
  });

  // ------------------------------------------------------------------ writes

  await step("WRITE register a synthetic patient", async () => {
    const r = await o.registerPatient(s);
    ok(r.status === 201, `POST /patient returned ${r.status}`);
    ok(/^[0-9a-f-]{36}$/.test(r.uuid), `no uuid: ${r.uuid}`);
    ok(!!r.identifierValue, `no identifier: ${r.identifier}`);
    ok(r.display.includes(o.MARKER_FAMILY), `display lacks the marker: ${r.display}`);
    mine.uuid = r.uuid; mine.id = r.identifierValue;
    // verify off the wire: the server can find it by its brand-new identifier
    const found = await o.searchPatients(s, r.identifierValue);
    ok(found.results.some((p) => p.uuid === r.uuid), `search for ${r.identifierValue} did not return the new patient`);
  });

  await step("WRITE start a visit on that patient", async () => {
    await o.openChart(s, mine.uuid);
    const r = await o.startVisit(s);
    ok(/^[0-9a-f-]{36}$/.test(r.visitUuid), "no visit uuid");
    const visits = await o.readVisits(s, mine.uuid);          // server re-read
    ok(visits.some((v) => v.uuid === r.visitUuid && !v.stop), `visit ${r.visitUuid} is not open on the server`);
  });

  await step("WRITE record vitals (obs inside an encounter)", async () => {
    const r = await o.recordVitals(s, { systolic: "118", diastolic: "76", Temperature: "37.2" });
    ok(r.obsCount >= 3, `only ${r.obsCount} obs posted`);
    mine.encounterUuid = r.encounterUuid;
    const obs = await o.readEncounterObs(s, r.encounterUuid); // server re-read
    ok(obs.some((x) => String(x.value) === "118"), `systolic 118 not on the server: ${JSON.stringify(obs.map((x) => x.value))}`);
    ok(obs.some((x) => String(x.value).includes(o.MARKER)), "the marker note did not persist");
  });

  await step("WRITE add a condition (POST via FHIR)", async () => {
    const r = await o.addCondition(s, "Headache");
    ok(!!r.conditionId, "no condition id");
    const conds = await o.readConditions(s, mine.uuid);       // server re-read
    ok(conds.some((c) => c.id === r.conditionId), `condition ${r.conditionId} not on the server`);
    ok(conds.some((c) => c.text === "Headache"), `no Headache in ${JSON.stringify(conds.map((c) => c.text))}`);
  });

  await step("WRITE record an allergy (read FHIR, write REST)", async () => {
    const r = await o.recordAllergy(s, mine.uuid);
    ok(!!r.allergyUuid, "no allergy uuid");
    const allergies = await o.readAllergies(s, mine.uuid);    // server re-read, over FHIR
    ok(allergies.length === 1, `expected 1 allergy, got ${allergies.length}`);
    ok(allergies[0].id === r.allergyUuid, `allergy id mismatch: ${allergies[0].id} vs ${r.allergyUuid}`);
  });

  await step("WRITE order a lab test through the order basket", async () => {
    const r = await o.orderLabTest(s);
    ok(/^[0-9a-f-]{36}$/.test(r.orderUuid), `no order uuid: ${r.orderUuid}`);
    const orders = await o.readOrders(s, mine.uuid);          // server re-read
    const mineOrder = orders.find((x) => x.uuid === r.orderUuid);
    ok(mineOrder, `order ${r.orderUuid} not on the server: ${JSON.stringify(orders)}`);
    ok(!!mineOrder!.orderNumber, "the server gave the order no order number");
    ok(String(mineOrder!.instructions).includes(o.MARKER), `the marker instructions did not persist: ${mineOrder!.instructions}`);
  });

  await step("WRITE create a patient list and add the patient to it", async () => {
    const l = await o.createPatientList(s);
    mine.listUuid = l.cohortUuid; mine.listName = l.name;
    ok(l.name.includes(o.MARKER), `list name lacks the marker: ${l.name}`);
    await o.openChart(s, mine.uuid);
    const m = await o.addPatientToList(s, l.name);
    ok(!!m.memberUuid, "no cohortmember uuid");
    const members = await o.readListMembers(s, l.cohortUuid); // server re-read
    ok(members.some((x) => x.patientUuid === mine.uuid), `patient not in list ${l.name} on the server`);
  });

  await step("WRITE put the patient in a service queue", async () => {
    const r = await o.addToQueue(s, mine.id);
    ok(r.status === 201, `POST visit-queue-entry returned ${r.status}`);
    const entries = await o.readQueueEntries(s, mine.uuid);   // server re-read
    ok(entries.some((e) => e.queue === "Outpatient Triage" && !e.endedAt), `no open Outpatient Triage entry: ${JSON.stringify(entries)}`);
  });

  await step("everything this run created is findable by its marker", async () => {
    const found = await o.findMarkedRecords(s);
    ok(found.patients.some((p) => p.uuid === mine.uuid), "the new patient is not findable by marker");
    ok(found.lists.some((l) => l.uuid === mine.listUuid), "the new list is not findable by marker");
    await o.goHome(s);
  });
}
