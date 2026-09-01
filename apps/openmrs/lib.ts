// apps/openmrs/lib.ts — OpenMRS 3.x (O3) reference application, driven read-only.
//
// Rules kept throughout: anchor in -> anchor out, an `until` on every transition,
// facts read from the wire (REST v1 / FHIR R4) rather than off the screen,
// `reached()` on every step.
//
// READ-ONLY STANCE: nothing here submits a form or creates/edits clinical data.
// One unavoidable write happens anyway: opening a chart makes the app POST the
// user's `userProperties` to remember "recently viewed patients" (see wire.md).
import { reached, type Session } from "../../src/index.ts";

// ---------------------------------------------------------------- constants

export const ORIGIN = "https://dev3.openmrs.org";
export const SPA = `${ORIGIN}/openmrs/spa`;
export const LOGIN = `${SPA}/login`;
export const HOME = `${SPA}/home`;
export const REST = "/openmrs/ws/rest/v1";
export const FHIR = "/openmrs/ws/fhir2/R4";

/** dev3 is a shared demo box. Chart routes routinely take 3-8 s; 20 s is the budget
 *  that made every step below deterministic over ~40 runs. Probes stay at 1500. */
export const SLOW = 20000;
export const PROBE = 1500;

export const chartUrl = (patientUuid: string, tab = "patient-summary") =>
  `${SPA}/patient/${patientUuid}/chart/${tab}`;

/** Cheap anchors: URL fragment + one specific element. */
export const anchors = {
  login:    { url: "/spa/login", el: 'role=textbox[name="Username"]' },
  password: { url: "/spa/login", el: "input[type=password]" },
  home:     { url: "/spa/home",  el: 'nav a[href$="/home/service-queues"]' },
  chart:    { url: "/chart",     el: 'role=banner[name="patient banner"]' },
  search:   { url: "",           el: 'role=searchbox[name="Search for a patient by name or identifier number"]' },
};

/** The header clock/queue counters redraw on their own; drop them from every ui diff. */
export const uiIgnore = [/Avg\. wait time/, /recent search results/];

// ---------------------------------------------------------------- helpers

type Any = any;

const bundleEntries = (b: Any): Any[] => (b?.entry ?? []).map((e: Any) => e.resource);

/** Read the newest body for `family` produced by `act`, falling back to the newest overall.
 *  The fallback matters because O3 caches aggressively (swr): a second visit to a tab
 *  can render with nothing on the wire, and then the act-scoped lookup is empty. */
function wire(s: Session, family: string, act?: string): Any {
  return (act && s.store.latestJson(family, act)) || s.store.latestJson(family) || null;
}

/** Where are we? Cheap, never navigates. */
export async function where(s: Session): Promise<"login" | "home" | "chart" | "unknown"> {
  const r = await s.until({ any: [
    { selector: anchors.chart.el, label: "chart" },
    { selector: anchors.home.el,  label: "home" },
    { selector: anchors.login.el, label: "login" },
  ] }, { timeout: PROBE });
  return (r.until?.ok ? (r.until.which as Any) : "unknown");
}

// ---------------------------------------------------------------- auth

/**
 * Log in. Two-step form: Username -> Continue -> Password -> Log in.
 * `/openmrs/spa/login` does NOT redirect an already-authenticated session away,
 * so this is safe to call from anywhere and is idempotent.
 * Lands on the home shell (Service queues).
 */
export async function login(s: Session, user = "admin", pass = "Admin123") {
  s.uiIgnore = uiIgnore;
  reached(await s.navigate(LOGIN, { until: { selector: anchors.login.el }, timeout: SLOW }), "reach login");
  reached(await s.fill(anchors.login.el, user), "username");
  reached(await s.click('role=button[name="Continue"]', { until: { selector: anchors.password.el, visible: true } }), "continue");
  reached(await s.fill(anchors.password.el, pass), "password");
  const r = await s.click('role=button[name="Log in"]', { until: { any: [
    { selector: anchors.home.el, label: "home" },
    { text: "Incorrect username or password", label: "error" },
  ] }, timeout: SLOW });
  if (r.until?.which === "error") throw new Error("login: server rejected the credentials");
  reached(r, "log in");
  return { act: r.action, session: await sessionInfo(s) };
}

/**
 * The auth oracle. GET /session ALWAYS returns 200 — even with a wrong password —
 * so never read the status; read `authenticated`. Run from inside the page so it
 * carries the JSESSIONID cookie and lands in the log.
 */
export async function sessionInfo(s: Session) {
  const j: Any = await s.evaluate(`fetch('${REST}/session').then(r=>r.json())`);
  return {
    authenticated: !!j?.authenticated,
    user: j?.user?.display ?? null,
    roles: (j?.user?.roles ?? []).map((r: Any) => r.display),
    locationUuid: j?.sessionLocation?.uuid ?? null,
    location: j?.sessionLocation?.display ?? null,
    provider: j?.currentProvider?.display ?? null,
    locale: j?.locale ?? null,
  };
}

/** Documented, deliberately NOT used by check.ts: it destroys the shared session. */
export async function logout(s: Session) {
  reached(await s.click('role=button[name="My Account"]', { until: { selector: 'role=button[name="Logout"]' } }), "open account menu");
  return reached(await s.click('role=button[name="Logout"]', { until: { selector: anchors.login.el }, timeout: SLOW }), "logout");
}

// ---------------------------------------------------------------- home shell

/** Reach the home shell from anywhere. Login page is an arm so a refusal costs ms, not SLOW. */
export async function goHome(s: Session) {
  s.uiIgnore = uiIgnore;
  const r = reached(await s.navigate(HOME, { until: { any: [
    { selector: anchors.home.el,  label: "home" },
    { selector: anchors.login.el, label: "login" },
  ] }, timeout: SLOW }), "go home");
  if (r.until?.which === "login") throw new Error("goHome: bounced to the login page — call login() first");
  return { act: r.action };
}

/** The six left-nav dashboards of the home shell, with the request each one lands. */
export const HOME_APPS = {
  "Service queues": { path: "/home/service-queues", req: `${REST}/queue-entry?` },
  "Appointments":   { path: "/home/appointments",   req: `${REST}/appointments?forDate=` },
  "Laboratory":     { path: "/home/laboratory",     req: `${REST}/order?orderTypes=` },
  "Patient lists":  { path: "/home/patient-lists",  req: `${REST}/cohortm/cohort?` },
  "Wards":          { path: "/home/ward",           req: `${REST}/admissionLocation/` },
  "Billing":        { path: "/home/billing",        req: `${REST}/billing/bill?` },
} as const;

/** Click a left-nav dashboard (a click, not a navigate: it keeps the SPA's caches).
 *  `/openmrs/spa/home` REDIRECTS to `/home/service-queues`, so when that dashboard is
 *  already the active route a `{ url }` arm would be `alreadyTrue` and `reached()` would
 *  (correctly) refuse it. Short-circuit instead: the data landed in the act that got us here. */
export async function openHomeApp(s: Session, name: keyof typeof HOME_APPS) {
  const spec = HOME_APPS[name];
  if (s.page.url().includes(spec.path)) return { act: undefined as string | undefined, which: "already-there" };
  const r = reached(await s.click(`nav a[href$="${spec.path}"]`, { until: { any: [
    { request: spec.req, landed: true, label: "wire" },
    { url: spec.path, label: "route" },
  ] }, timeout: SLOW }), `open ${name}`);
  return { act: r.action as string | undefined, which: r.until?.which };
}

/** Service queues dashboard: who is waiting/attending at the session location, from the wire. */
export async function serviceQueue(s: Session) {
  await goHome(s);
  const { act } = await openHomeApp(s, "Service queues");
  const body = wire(s, `${REST}/queue-entry?v=`, act);
  const entries = (body?.results ?? []).map((e: Any) => ({
    uuid: e.uuid,
    patient: e.patient?.person?.display ?? e.display,
    patientUuid: e.patient?.uuid,
    queue: e.queue?.display ?? e.queue?.name,
    status: e.status?.display,
    priority: e.priority?.display,
  }));
  return { act, total: body?.totalCount ?? entries.length, entries };
}

/** Patient lists (OpenMRS "cohorts"). Returns every list the All-lists tab knows about. */
export async function patientLists(s: Session) {
  await goHome(s);
  const { act } = await openHomeApp(s, "Patient lists");
  const body = wire(s, `${REST}/cohortm/cohort?`, act);
  const lists = (body?.results ?? []).map((c: Any) => ({
    uuid: c.uuid, name: c.name ?? c.display, size: c.size, type: c.cohortType?.display ?? null,
  }));
  return { act, lists };
}

/** Open one list and read its members off the wire.
 *  GOTCHA: this route paints a full skeleton <table> with empty cells and an h1 of "--"
 *  before the data lands, so `until: { selector: "table" }` resolves on the skeleton.
 *  Wait on /cohortm/cohortmember instead. */
export async function openPatientList(s: Session, listUuid: string) {
  const r = reached(await s.navigate(`${HOME}/patient-lists/${listUuid}`, { until: {
    request: `${REST}/cohortm/cohortmember?cohort=${listUuid}`, landed: true,
  }, timeout: SLOW }), "open patient list");
  const body = wire(s, `${REST}/cohortm/cohortmember?cohort=${listUuid}`, r.action);
  const members = (body?.results ?? []).map((m: Any) => ({
    patientUuid: m.patient?.uuid,
    display: m.patient?.display,
    startDate: m.startDate,
  }));
  return { act: r.action, total: body?.totalCount ?? members.length, members };
}

// ---------------------------------------------------------------- patient search

/**
 * Header patient search. The searchbox lives in the app header and only exists after
 * the "Search patient" button is pressed; on the service-queues dashboard there is a
 * SECOND searchbox ("Filter table"), so always address this one by its accessible name.
 * Debounced: one XHR per pause, `GET /ws/rest/v1/patient?q=<term>`.
 */
export async function searchPatients(s: Session, q: string) {
  if (!(await s.until({ selector: anchors.search.el }, { timeout: 400 })).until?.ok) {
    reached(await s.click('role=button[name="Search patient"]', { until: { selector: anchors.search.el } }), "open search");
  }
  reached(await s.fill(anchors.search.el, ""), "clear search");
  const r = reached(await s.type(anchors.search.el, q, {
    until: { request: `${REST}/patient?q=`, landed: true }, timeout: SLOW,
  }), `search "${q}"`);
  const body = wire(s, `${REST}/patient?q=`, r.action);
  const results = (body?.results ?? []).map((p: Any) => ({
    uuid: p.uuid,
    name: p.person?.display ?? p.display,
    gender: p.person?.gender,
    age: p.person?.age,
    identifiers: (p.identifiers ?? []).map((i: Any) => i.display),
  }));
  return { act: r.action, results };
}

// ---------------------------------------------------------------- patient chart

/** Chart tab -> the request that proves it loaded, and the heading that proves it rendered. */
export const CHART_TABS = {
  "patient-summary":       { req: `${FHIR}/Patient/`,                heading: "Vitals" },
  "vitals-and-biometrics": { req: `${FHIR}/Observation?subject`,     heading: "Vitals" },
  "medications":           { req: `${REST}/order?patient=`,          heading: "Active medications" },
  "orders":                { req: `${REST}/order?patient=`,          heading: "Orders" },
  "results":               { req: `${REST}/obstree?patient=`,        heading: "Tests" },
  "visits":                { req: "ws/rest/v1/visit?patient=",       heading: null },
  "allergies":             { req: `${FHIR}/AllergyIntolerance?`,     heading: "Allergies" },
  "conditions":            { req: `${FHIR}/Condition?patient=`,      heading: "Conditions" },
  "immunizations":         { req: `${FHIR}/Immunization?`,           heading: "Immunizations" },
  "programs":              { req: `${REST}/programenrollment?`,      heading: "Care Programs" },
  "attachments":           { req: `${REST}/attachment?`,             heading: "Attachments" },
  "appointments":          { req: `${REST}/appointments/search`,     heading: "Appointments" },
} as const;
export type ChartTab = keyof typeof CHART_TABS;

/**
 * Open a patient's chart. Navigates (rather than clicking a result) so it is a usable
 * entry point from any state; the postcondition is the FHIR Patient read, with the
 * patient banner as the cache-hit arm.
 */
export async function openChart(s: Session, patientUuid: string) {
  s.uiIgnore = uiIgnore;
  const r = reached(await s.navigate(chartUrl(patientUuid), { until: { any: [
    { request: `${FHIR}/Patient/${patientUuid}`, landed: true, label: "wire" },
    { selector: anchors.chart.el, label: "banner" },
  ] }, timeout: SLOW }), "open chart");
  const p: Any = wire(s, `${FHIR}/Patient/${patientUuid}`, r.action);
  const name = p?.name?.[0];
  return {
    act: r.action,
    which: r.until?.which,
    patient: p ? {
      uuid: p.id,
      name: name?.text ?? [(name?.given ?? []).join(" "), name?.family].filter(Boolean).join(" "),
      gender: p.gender,
      birthDate: p.birthDate,
      identifiers: (p.identifier ?? []).map((i: Any) => `${i.type?.text ?? "id"}: ${i.value}`),
      active: p.active,
    } : null,
  };
}

/**
 * Click a chart left-nav tab and return the body it fetched. Anchor in: the patient banner.
 *
 * The postcondition is the WIRE, never a heading: the patient-summary dashboard already
 * renders cards titled "Conditions", "Vitals", "Allergies"…, so a heading predicate is
 * `alreadyTrue` before you ever click that tab (this is exactly what `reached()` refused).
 * A `{ url }` arm is no better — client-side routing flips the URL synchronously, so it
 * wins the race and you read a stale body.
 *
 * O3 caches with SWR: a second visit to a tab can render with nothing on the wire. Then the
 * request predicate expires (cost: SLOW) and we fall back to the newest body in the log,
 * which is that same cached response. `which` says which happened.
 */
export async function openChartTab(s: Session, patientUuid: string, tab: ChartTab) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: PROBE }), "on a chart");
  const spec = CHART_TABS[tab];
  if (s.page.url().includes(`/chart/${tab}`)) return { act: undefined as string | undefined, which: "already-there", body: wire(s, spec.req) };
  // If this run already has a 200 for that family the tab will very likely render from cache;
  // spend 4 s on the request arm instead of SLOW, then fall back. (Cold: the full budget.)
  const seen = s.store.requests({ url: spec.req, status: 200, run: s.run }).length > 0;
  const r = await s.click(`nav a[href$="/chart/${tab}"]`, { until: { request: spec.req, landed: true }, timeout: seen ? 4000 : SLOW });
  if (!r.ok) throw new Error(`chart tab ${tab}: ${r.diagnosis?.reason} — ${r.diagnosis?.message}`);
  const landed = !!r.until?.ok;
  if (!landed && !s.page.url().includes(`/chart/${tab}`)) throw new Error(`chart tab ${tab}: neither the request nor the route arrived (${s.page.url()})`);
  return { act: r.action as string | undefined, which: landed ? "wire" : "cache", body: wire(s, spec.req, landed ? r.action : undefined) };
}

/** Problem list, from FHIR Condition (NOT from the table: the table shows "Active" only). */
export async function conditions(s: Session, patientUuid: string) {
  const { act, body } = await openChartTab(s, patientUuid, "conditions");
  const rows = bundleEntries(body).map((c: Any) => ({
    id: c.id,
    text: c.code?.text
      ?? c.extension?.find((e: Any) => e.url?.endsWith("non-coded-condition"))?.valueString
      ?? null,
    clinicalStatus: c.clinicalStatus?.coding?.[0]?.code ?? null,
    onset: c.onsetDateTime ?? null,
  }));
  return { act, total: body?.total ?? rows.length, rows };
}

/** The concept uuids the vitals widget asks for. The tab fires THREE Observation reads
 *  (vitals / biometrics / a single MUAC concept), so `latestJson("/Observation?")` is a
 *  coin flip — pick the family by its `code=` parameter. */
export const VITALS_CODES = "code=5085AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";   // systolic BP + friends
export const BIOMETRICS_CODES = "code=5090AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // height + friends

/** Vitals & biometrics, from the FHIR Observation bundle the tab fetches. */
export async function vitals(s: Session, patientUuid: string) {
  const { act } = await openChartTab(s, patientUuid, "vitals-and-biometrics");
  const body = wire(s, VITALS_CODES, act);
  const obs = bundleEntries(body).map((o: Any) => ({
    id: o.id,
    code: o.code?.coding?.find((c: Any) => c.display)?.display ?? o.code?.text ?? null,
    value: o.valueQuantity ? `${o.valueQuantity.value} ${o.valueQuantity.unit ?? ""}`.trim() : null,
    when: o.effectiveDateTime ?? null,
  }));
  obs.sort((a: Any, b: Any) => String(b.when).localeCompare(String(a.when)));
  return { act, total: body?.total ?? obs.length, latest: obs.slice(0, 8), all: obs };
}

/** Visit history + encounters. NOTE the URL the widget builds has a DOUBLE SLASH:
 *  `/openmrs//ws/rest/v1/visit?...` — match on the tail, not on `/openmrs/ws`. */
export async function visits(s: Session, patientUuid: string) {
  const { act, body } = await openChartTab(s, patientUuid, "visits");
  const rows = (body?.results ?? []).map((v: Any) => ({
    uuid: v.uuid,
    type: v.visitType?.display,
    start: v.startDatetime,
    stop: v.stopDatetime,
    location: v.location?.display,
    encounters: (v.encounters ?? []).length,
  }));
  return { act, total: body?.totalCount ?? rows.length, rows };
}

/** The clinical forms the workspace offers for this patient (read the catalogue, submit nothing). */
export async function clinicalForms(s: Session) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: PROBE }), "on a chart");
  const r = reached(await s.click('role=button[name="Clinical forms"]', {
    until: { request: `${REST}/form?v=`, landed: true }, timeout: SLOW,
  }), "open clinical forms");
  const body = wire(s, `${REST}/form?v=`, r.action);
  const forms = (body?.results ?? []).map((f: Any) => ({ uuid: f.uuid, name: f.display ?? f.name, published: f.published }));
  // leave the workspace as we found it
  await s.press("Escape");
  return { act: r.action, forms };
}

// ================================================================
// WRITE WORKFLOWS
// ================================================================
//
// Stance: everything created here is obviously synthetic and carries MARKER so it can be
// found and cleaned up later (`GET /ws/rest/v1/patient?q=Zzdiscotest`,
// `GET /ws/rest/v1/cohortm/cohort?q=DISCOTEST`). Nothing edits or deletes a record this
// pack did not create. Every write is verified by RE-READING the server, never by the toast.
//
// The app's write surfaces, and the shape they all share:
//   a launcher (banner Actions menu / a "Record …" button / the right rail) opens an
//   overlay, you fill it, and one button POSTs. There are THREE overlay kinds and they
//   need different anchors (see README §6 "Interstitials and recovery"):
//     workspace side panel -> role=banner[name="Workspace header"]
//     Carbon modal         -> role=dialog
//     snackbar (the toast) -> role=alertdialog   <- never a postcondition

/** Every record this pack creates carries this string somewhere findable. */
export const MARKER = "DISCOTEST";
/** Family name for synthetic patients — sorts to the end of any list and greps cleanly. */
export const MARKER_FAMILY = "Zzdiscotest";

/** yyyymmdd-hhmmss, so two runs never collide and a record can be dated. */
export const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** The body of the POST/PUT this act issued to `family` — the created record as the SERVER
 *  returned it. `latestJson` is not enough: the app fires GETs to the same family inside the
 *  same act window (the chart it navigates to), and the newest of those would win. */
function written(s: Session, family: string, act?: string, method = "POST"): Any {
  const rows = s.store.requests({ url: family, method, action: act, run: s.run } as Any);
  const row = rows[rows.length - 1];
  return row?.body_hash ? s.store.json(row.body_hash) : null;
}
/** Same, but the row itself (status, size) — for asserting "it persisted with 201". */
function writtenRow(s: Session, family: string, act?: string, method = "POST"): Any {
  const rows = s.store.requests({ url: family, method, action: act, run: s.run } as Any);
  return rows[rows.length - 1] ?? null;
}

/** Carbon hides the real <input> under a styled <span>, so every radio/checkbox in this app
 *  reports `occluded` to a real mouse click. `js: true` is the whole fix. */
async function tick(s: Session, target: string, what: string) {
  return reached(await s.click(target, { js: true }), what);
}

// ---------------------------------------------------------------- 1. register a patient

export type NewPatient = { given?: string; family?: string; gender?: "Male" | "Female"; dob?: [string, string, string]; city?: string };

/**
 * **Register a patient.** Precondition: logged in (any screen).
 * Steps: header "Add patient" → `/spa/patient-registration` → First/Family name, Sex radio
 * (js), Date of birth (three spinbuttons), optional City → "Register patient".
 * Postcondition: the URL is the NEW patient's chart and `POST /ws/rest/v1/patient/` returned 201.
 * Wire: `POST /ws/rest/v1/idgen/identifiersource/<uuid>/identifier` (201, reserves the CR Number)
 * then `POST /ws/rest/v1/patient/` (201) whose request body carries a **client-generated uuid**.
 */
export async function registerPatient(s: Session, p: NewPatient = {}) {
  // The NAME carries the marker (so a human scanning the demo can spot it); the per-run
  // handle is the auto-generated identifier, because OpenMRS person-name search does not
  // like digits and every run would otherwise be indistinguishable by name.
  const given = p.given ?? "Discotest";
  const family = p.family ?? MARKER_FAMILY;
  reached(await s.navigate(`${SPA}/patient-registration`, {
    until: { selector: 'role=textbox[name="First Name"]' }, timeout: SLOW,
  }), "reach registration");
  reached(await s.fill('role=textbox[name="First Name"]', given), "first name");
  reached(await s.fill('role=textbox[name="Family Name"]', family), "family name");
  await tick(s, `role=radio[name="${p.gender ?? "Female"}"]`, "sex");
  const [d, m, y] = p.dob ?? ["01", "01", "1990"];
  reached(await s.fill('role=spinbutton[name="day, Date of birth"]', d), "dob day");
  reached(await s.fill('role=spinbutton[name="month, Date of birth"]', m), "dob month");
  reached(await s.fill('role=spinbutton[name="year, Date of birth"]', y), "dob year");
  reached(await s.fill('role=textbox[name="City/Village (optional)"]', p.city ?? `${MARKER} ${stamp()}`), "city");

  const r = reached(await s.click('role=button[name="Register patient"]', {
    until: { request: `${REST}/patient/`, landed: true }, timeout: SLOW,
  }), "register patient");
  const row = writtenRow(s, `${REST}/patient/`, r.action);
  const body = written(s, `${REST}/patient/`, r.action);
  if (!body?.uuid) throw new Error(`registerPatient: no POST /patient response in ${r.action}`);
  return {
    act: r.action, status: row?.status,
    uuid: body.uuid as string,
    display: body.display as string,
    identifier: (body.identifiers ?? []).map((i: Any) => i.display).join(", "),
    // "CR Number = 1000KTP" -> "1000KTP"; the unique, greppable handle for this run's patient
    identifierValue: String((body.identifiers ?? [])[0]?.display ?? "").split(/\s*=\s*/).pop() ?? "",
    given, family,
  };
}

// ---------------------------------------------------------------- 2. start a visit

/**
 * **Start a visit.** Precondition: on the patient's chart, no active visit.
 * Steps: banner "Actions" → menuitem "Add visit" → the *Start a visit* workspace →
 * visit-type radio (js) → "Start visit".
 * Postcondition: `POST /ws/rest/v1/visit` 201; the banner grows an "Active Visit" pill.
 * NOTE the default **visit location is not the session location** — this deployment preselects
 * "Ubuntu Hospital", which is why the patient then does not appear in the Outpatient Clinic queue
 * until you add them explicitly (workflow 9).
 */
export async function startVisit(s: Session, visitType = "Facility Visit") {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: PROBE }), "on a chart");
  reached(await s.click('role=button[name="Actions"]', { until: { selector: 'role=menuitem[name="Add visit"]' } }), "actions menu");
  reached(await s.click('role=menuitem[name="Add visit"]', {
    until: { selector: `role=radio[name="${visitType}"]` }, timeout: SLOW,
  }), "open start-visit workspace");
  await tick(s, `role=radio[name="${visitType}"]`, "visit type");
  const r = reached(await s.click('role=button[name="Start visit"]', {
    until: { request: `${REST}/visit`, landed: true }, timeout: SLOW,
  }), "start visit");
  const body = written(s, `${REST}/visit`, r.action);
  if (!body?.uuid) throw new Error(`startVisit: no POST /visit response in ${r.action}`);
  return { act: r.action, visitUuid: body.uuid as string, visitType: body.visitType?.display, location: body.location?.display };
}

// ---------------------------------------------------------------- 3. record vitals

export type VitalValues = Partial<Record<"Temperature" | "systolic" | "diastolic" | "Pulse" | "Respiration rate" | "Oxygen saturation" | "Weight" | "Height", string>>;

/**
 * **Record vitals & biometrics.** Precondition: on the chart (an active visit is not required,
 * but without one the obs land in a visit-less encounter).
 * Steps: "Record vital signs" → workspace of `spinbutton`s → Notes → "Save and close".
 * Postcondition: `POST /ws/rest/v1/encounter` 201 carrying one `obs` per filled field.
 * The field ids are React-generated (`:r5d:-temperature`) and change on every render — address
 * them by accessible name only.
 */
export async function recordVitals(s: Session, values: VitalValues = {}, note = `${MARKER} synthetic vitals ${stamp()}`) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: PROBE }), "on a chart");
  reached(await s.click('role=button[name="Record vital signs"]', {
    until: { selector: 'role=spinbutton[name="Temperature"]' }, timeout: SLOW,
  }), "open vitals workspace");
  const v: VitalValues = { Temperature: "37.2", systolic: "118", diastolic: "76", Pulse: "72", "Respiration rate": "16", "Oxygen saturation": "98", Weight: "61", Height: "165", ...values };
  for (const [name, val] of Object.entries(v)) reached(await s.fill(`role=spinbutton[name="${name}"]`, val!), `vitals ${name}`);
  reached(await s.fill('role=textbox[name="Notes"]', note), "vitals note");
  const r = reached(await s.click('role=button[name="Save and close"]', {
    until: { request: `${REST}/encounter`, landed: true }, timeout: SLOW,
  }), "save vitals");
  const body = written(s, `${REST}/encounter`, r.action);
  if (!body?.uuid) throw new Error(`recordVitals: no POST /encounter response in ${r.action}`);
  return { act: r.action, encounterUuid: body.uuid as string, obsCount: (body.obs ?? []).length, note };
}

// ---------------------------------------------------------------- 4. add a condition

/**
 * **Record a condition.** Precondition: on the chart.
 * Steps: "Record conditions" → type in the concept typeahead → pick the `menuitem` →
 * onset date (three spinbuttons) → "Save & close".
 * The typeahead hits `GET /ws/rest/v1/concept?name=<q>&searchType=fuzzy&class=<Diagnosis class>`.
 * Postcondition: **`POST /ws/fhir2/R4/Condition` 201** — conditions are written through FHIR,
 * unlike visits/encounters/allergies which are written through REST.
 * A condition is a coded concept, so the MARKER cannot live in it; it is identifiable by being
 * attached to a MARKER patient.
 */
export async function addCondition(s: Session, concept = "Headache", onset: [string, string, string] = ["15", "08", "2026"]) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: PROBE }), "on a chart");
  reached(await s.click('role=button[name="Record conditions"]', {
    until: { selector: 'role=searchbox[name="Enter condition"]' }, timeout: SLOW,
  }), "open conditions workspace");
  reached(await s.type('role=searchbox[name="Enter condition"]', concept, {
    until: { request: `${REST}/concept?name=`, landed: true }, timeout: SLOW,
  }), "concept search");
  reached(await s.click(`role=menuitem[name="${concept}"]`, { until: { gone: `role=menuitem[name="${concept}"]` } }), "pick concept");
  const [d, m, y] = onset;
  reached(await s.fill('role=spinbutton[name="day, Onset date"]', d), "onset day");
  reached(await s.fill('role=spinbutton[name="month, Onset date"]', m), "onset month");
  reached(await s.fill('role=spinbutton[name="year, Onset date"]', y), "onset year");
  const r = reached(await s.click('role=button[name="Save & close"]', {
    until: { request: `${FHIR}/Condition`, landed: true }, timeout: SLOW,
  }), "save condition");
  const body = written(s, `${FHIR}/Condition`, r.action);
  if (!body?.id) throw new Error(`addCondition: no POST FHIR Condition response in ${r.action}`);
  return { act: r.action, conditionId: body.id as string, text: body.code?.coding?.[0]?.display ?? concept };
}

// ---------------------------------------------------------------- 5. record an allergy

/**
 * **Record an allergy.** Precondition: on the chart.
 * Steps: Allergies tab → "Record allergy intolerances" → Allergen combobox (a Carbon
 * dropdown: click, then pick a `role=option`) → reaction checkbox (js) → severity radio (js)
 * → Comments (MARKER) → "Save and close".
 * Postcondition: **`POST /ws/rest/v1/patient/<uuid>/allergy` 201** — the allergy is READ over
 * FHIR (`AllergyIntolerance`) but WRITTEN over REST. Asymmetric on purpose; do not assume the
 * read endpoint accepts writes.
 */
export async function recordAllergy(s: Session, patientUuid: string, allergen = "ACE inhibitors", reaction = "Rash", severity: "Mild" | "Moderate" | "Severe" = "Mild", comment = `${MARKER} synthetic allergy ${stamp()}`) {
  await openChartTab(s, patientUuid, "allergies");
  reached(await s.click('role=button[name="Record allergy intolerances"]', {
    until: { selector: 'role=combobox[name="Allergen"]' }, timeout: SLOW,
  }), "open allergy workspace");
  reached(await s.click('role=combobox[name="Allergen"]', { until: { selector: `role=option[name="${allergen}"]` }, timeout: SLOW }), "open allergen list");
  reached(await s.click(`role=option[name="${allergen}"]`, { until: { gone: `role=option[name="${allergen}"]` } }), "pick allergen");
  await tick(s, `role=checkbox[name="${reaction}"]`, "reaction");
  await tick(s, `role=radio[name="${severity}"]`, "severity");
  reached(await s.fill('role=textbox[name="Comments"]', comment), "allergy comment");
  const r = reached(await s.click('role=button[name="Save and close"]', {
    until: { request: `/allergy`, landed: true }, timeout: SLOW,
  }), "save allergy");
  const body = written(s, `/patient/${patientUuid}/allergy`, r.action);
  if (!body?.uuid) throw new Error(`recordAllergy: no POST allergy response in ${r.action}`);
  return { act: r.action, allergyUuid: body.uuid as string, display: body.display, comment };
}

// ---------------------------------------------------------------- 6/7. patient lists

/**
 * **Create a patient list (cohort).** Precondition: the Patient lists dashboard.
 * Steps: "New list" → the *New patient list* **workspace** (not a dialog) → List name →
 * description → "Create list".
 * Postcondition: `POST /ws/rest/v1/cohortm/cohort/` 201, response carries the new `uuid`.
 */
export async function createPatientList(s: Session, name = `${MARKER} list ${stamp()}`, description = `${MARKER} synthetic list created by an automated characterization run`) {
  await goHome(s);
  await openHomeApp(s, "Patient lists");
  reached(await s.click('role=button[name="New list"]', {
    until: { selector: 'role=textbox[name="List name"]' }, timeout: SLOW,
  }), "open new-list workspace");
  reached(await s.fill('role=textbox[name="List name"]', name), "list name");
  reached(await s.fill('role=textbox[name="Describe the purpose of this list in a few words"]', description), "list description");
  const r = reached(await s.click('role=button[name="Create list"]', {
    until: { request: `${REST}/cohortm/cohort/`, landed: true }, timeout: SLOW,
  }), "create list");
  const body = written(s, `${REST}/cohortm/cohort/`, r.action);
  if (!body?.uuid) throw new Error(`createPatientList: no POST cohort response in ${r.action}`);
  return { act: r.action, cohortUuid: body.uuid as string, name: body.name as string };
}

/**
 * **Add the charted patient to a list.** Precondition: on the patient's chart.
 * Steps: banner "Actions" → "Add to list" → a **Carbon modal** (`role=dialog`, NOT a
 * workspace) → filter by name → tick the checkbox (js) → "Save".
 * Postcondition: `POST /ws/rest/v1/cohortm/cohortmember` 201.
 */
export async function addPatientToList(s: Session, listName: string) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: PROBE }), "on a chart");
  reached(await s.click('role=button[name="Actions"]', { until: { selector: 'role=menuitem[name="Add to list"]' } }), "actions menu");
  reached(await s.click('role=menuitem[name="Add to list"]', {
    until: { selector: 'role=searchbox[name="Search for a list"]' }, timeout: SLOW,
  }), "open add-to-list modal");
  reached(await s.type('role=searchbox[name="Search for a list"]', listName, {
    until: { selector: `role=checkbox[name="${listName}"]` }, timeout: SLOW,
  }), "filter lists");
  await tick(s, `role=checkbox[name="${listName}"]`, "tick list");
  const r = reached(await s.click('role=button[name="Save"]', {
    until: { request: `${REST}/cohortm/cohortmember`, landed: true }, timeout: SLOW,
  }), "add to list");
  const body = written(s, `${REST}/cohortm/cohortmember`, r.action);
  if (!body?.uuid) throw new Error(`addPatientToList: no POST cohortmember response in ${r.action}`);
  return { act: r.action, memberUuid: body.uuid as string };
}

// ---------------------------------------------------------------- 8. order a lab test

/**
 * **Order a lab test through the order basket.** Precondition: on the chart, WITH an active
 * visit (without one the sign step has no visit to attach the encounter to).
 * Steps: right rail "Order basket" → the Lab-orders **"Add"** (the second Add on the panel) →
 * search a test type → its "Order form" → Reference number + instructions (MARKER) →
 * "Save order" (returns to the basket, item flips *Incomplete* → *New*) → "Sign and close".
 * Postcondition: **`POST /ws/rest/v1/encounter` 201 whose body carries `orders:[{type:"testorder",…}]`** —
 * signing the basket creates an *encounter that contains the orders*, there is no POST /order.
 * GOTCHA: "Sign and close" stays `disabled` while any basket item is *Incomplete*; disco
 * diagnoses that as `disabled` in ~100 ms, which is how this flow was found.
 */
export async function orderLabTest(s: Session, test = "Complete blood count", reference = `${MARKER}-REF-${stamp()}`, instructions = `${MARKER} synthetic lab order — automated characterization run`) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: PROBE }), "on a chart");
  reached(await s.click('role=button[name="Order basket"]', {
    until: { selector: 'role=button[name="Sign and close"]' }, timeout: SLOW,
  }), "open order basket");
  reached(await s.click('role=button[name="Add"] >> nth=1', {
    until: { selector: 'role=searchbox[name="Search for a test type"]' }, timeout: SLOW,
  }), "add lab order");
  reached(await s.type('role=searchbox[name="Search for a test type"]', test, {
    until: { text: `1 result for "${test}"` }, timeout: SLOW,
  }), "search test type");
  reached(await s.click('role=button[name="Order form"]', {
    until: { selector: 'role=textbox[name="Reference number"]' }, timeout: SLOW,
  }), "open order form");
  reached(await s.fill('role=textbox[name="Reference number"]', reference), "reference");
  reached(await s.fill('role=textbox[name="Additional instructions"]', instructions), "instructions");
  // "Sign and close" is NOT a postcondition here: the basket panel stays mounted behind the
  // order form, so that button is visible the whole time (already-true). The order form
  // going away is the thing that is false before and true after.
  reached(await s.click('role=button[name="Save order"]', {
    until: { gone: 'role=button[name="Save order"]' }, timeout: SLOW,
  }), "save order to basket");
  const r = reached(await s.click('role=button[name="Sign and close"]', {
    until: { request: `${REST}/encounter`, landed: true }, timeout: SLOW,
  }), "sign orders");
  const body = written(s, `${REST}/encounter`, r.action);
  const order = (body?.orders ?? [])[0];
  if (!order) throw new Error(`orderLabTest: no order in the POST /encounter response of ${r.action}`);
  // NOTE the POST response's `orders[]` is a REF representation — uuid/display/type only.
  // There is no `orderNumber` here; re-read /ws/rest/v1/order to get it (see readOrders).
  return { act: r.action, encounterUuid: body.uuid as string, orderUuid: order.uuid as string, display: order.display as string };
}

// ---------------------------------------------------------------- 9. add to a service queue

/**
 * **Put a patient in a service queue.** Precondition: the patient has an ACTIVE VISIT
 * (the queue entry hangs off the visit). Start anywhere.
 * Steps: Service queues dashboard → "Add a patient to this list" → workspace search →
 * pick the patient card → Queue Location `<select>` (defaults to the session location) →
 * Service `<select>` → Priority radios (default "Not Urgent") → "Add patient to queue".
 * Postcondition: **`POST /ws/rest/v1/visit-queue-entry` 201** — one call creates the queue
 * entry *and* links it to the visit; the request body nests `{visit:{uuid}, queueEntry:{…}}`.
 * The patient then appears on the Service queues dashboard for that location.
 */
export async function addToQueue(s: Session, patientNameOrId: string, service = "Outpatient Triage") {
  await goHome(s);
  await openHomeApp(s, "Service queues");
  reached(await s.click('role=button[name="Add a patient to this list"]', {
    until: { selector: 'role=searchbox[name="Search for a patient by name or identifier number"]' }, timeout: SLOW,
  }), "open add-to-queue workspace");
  reached(await s.type('role=searchbox[name="Search for a patient by name or identifier number"] >> nth=0', patientNameOrId, {
    until: { request: `${REST}/patient?q=`, landed: true }, timeout: SLOW,
  }), "queue patient search");
  reached(await s.click(`role=button[name*="${patientNameOrId}"]`, {
    until: { selector: `select:has(option:text-is("${service}"))` }, timeout: SLOW,
  }), "pick patient");
  reached(await s.select(`select:has(option:text-is("${service}"))`, service, {
    until: { selector: 'role=radio[name="Not Urgent"]' }, timeout: SLOW,
  }), "pick service");
  const r = reached(await s.click('role=button[name="Add patient to queue"]', {
    until: { request: `${REST}/visit-queue-entry`, landed: true }, timeout: SLOW,
  }), "add to queue");
  const row = writtenRow(s, `${REST}/visit-queue-entry`, r.action);
  if (row?.status !== 201) throw new Error(`addToQueue: POST visit-queue-entry status ${row?.status} in ${r.action}`);
  return { act: r.action, status: row.status };
}

// ---------------------------------------------------------------- verification helpers
// A write step must prove itself by re-reading the SERVER, never by the toast.

/** Re-read one patient's allergies over FHIR, from inside the page (cookie + logged). */
export async function readAllergies(s: Session, patientUuid: string) {
  const b: Any = await s.evaluate(`fetch('${FHIR}/AllergyIntolerance?patient=${patientUuid}&_summary=data').then(r=>r.json())`);
  return (b?.entry ?? []).map((e: Any) => ({ id: e.resource?.id, code: e.resource?.code?.text ?? e.resource?.code?.coding?.[0]?.display, note: e.resource?.note?.[0]?.text }));
}
/** Re-read one patient's orders over REST. */
export async function readOrders(s: Session, patientUuid: string) {
  const b: Any = await s.evaluate(`fetch('${REST}/order?patient=${patientUuid}&careSetting=6f0c9a92-6f24-11e3-af88-005056821db0&v=custom:(uuid,orderNumber,display,fulfillerStatus,instructions,orderType:(display))').then(r=>r.json())`);
  return (b?.results ?? []).map((o: Any) => ({ uuid: o.uuid, orderNumber: o.orderNumber, display: o.display, type: o.orderType?.display, instructions: o.instructions }));
}
/** Re-read one patient's queue entries over REST. */
export async function readQueueEntries(s: Session, patientUuid: string) {
  const b: Any = await s.evaluate(`fetch('${REST}/queue-entry?patient=${patientUuid}&v=custom:(uuid,queue:(display),status:(display),priority:(display),endedAt)').then(r=>r.json())`);
  return (b?.results ?? []).map((q: Any) => ({ uuid: q.uuid, queue: q.queue?.display, status: q.status?.display, priority: q.priority?.display, endedAt: q.endedAt }));
}
/** Re-read a patient's visits over REST. */
export async function readVisits(s: Session, patientUuid: string) {
  const b: Any = await s.evaluate(`fetch('${REST}/visit?patient=${patientUuid}&v=custom:(uuid,visitType:(display),startDatetime,stopDatetime,location:(display))').then(r=>r.json())`);
  return (b?.results ?? []).map((v: Any) => ({ uuid: v.uuid, type: v.visitType?.display, start: v.startDatetime, stop: v.stopDatetime, location: v.location?.display }));
}
/** Re-read one encounter's obs over REST (proves the vitals persisted with their values). */
export async function readEncounterObs(s: Session, encounterUuid: string) {
  const b: Any = await s.evaluate(`fetch('${REST}/encounter/${encounterUuid}?v=custom:(uuid,encounterDatetime,obs:(uuid,display,concept:(uuid,display),value))').then(r=>r.json())`);
  return (b?.obs ?? []).map((o: Any) => ({ concept: o.concept?.display, value: o.value, display: o.display }));
}
/** Re-read a patient's conditions over FHIR. */
export async function readConditions(s: Session, patientUuid: string) {
  const b: Any = await s.evaluate(`fetch('${FHIR}/Condition?patient=${patientUuid}&_count=100&_summary=data').then(r=>r.json())`);
  return (b?.entry ?? []).map((e: Any) => ({ id: e.resource?.id, text: e.resource?.code?.text ?? e.resource?.code?.coding?.[0]?.display, status: e.resource?.clinicalStatus?.coding?.[0]?.code }));
}
/** Re-read a cohort's members over REST. */
export async function readListMembers(s: Session, cohortUuid: string) {
  const b: Any = await s.evaluate(`fetch('${REST}/cohortm/cohortmember?cohort=${cohortUuid}&v=full').then(r=>r.json())`);
  return (b?.results ?? []).map((m: Any) => ({ uuid: m.uuid, patientUuid: m.patient?.uuid, display: m.patient?.display }));
}
/** Find every record this pack has ever created on this server (for cleanup). */
export async function findMarkedRecords(s: Session) {
  const patients: Any = await s.evaluate(`fetch('${REST}/patient?q=${MARKER_FAMILY}&v=custom:(uuid,display)').then(r=>r.json())`);
  const cohorts: Any = await s.evaluate(`fetch('${REST}/cohortm/cohort?v=custom:(uuid,name,size)').then(r=>r.json())`);
  return {
    patients: (patients?.results ?? []).map((p: Any) => ({ uuid: p.uuid, display: p.display })),
    lists: (cohorts?.results ?? []).filter((c: Any) => String(c.name).includes(MARKER)).map((c: Any) => ({ uuid: c.uuid, name: c.name, size: c.size })),
  };
}
