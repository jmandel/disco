// apps/openmrs/lib.ts — OpenMRS 3.x ("O3") on https://dev3.openmrs.org as workflows.
//
// Rules kept throughout: anchor in -> anchor out, an `until` on every transition,
// facts read from the wire (the app is a thin renderer over REST + FHIR), `reached()`
// on every step that must succeed.
//
// READ-ONLY PACK. Nothing here submits a form or creates/edits a record. The one
// unavoidable write is the app's own: opening a chart POSTs the "recently viewed"
// user property (see README, "Gotchas").
import { reached, type Session, type Report } from "../../src/index.ts";

export const ORIGIN = "https://dev3.openmrs.org";
export const BASE = `${ORIGIN}/openmrs`;
export const SPA = `${BASE}/spa`;
export const LOGIN_URL = `${SPA}/login`;
export const HOME_URL = `${SPA}/home`;
export const chartUrl = (uuid: string, tab = "patient-summary") => `${SPA}/patient/${uuid}/chart/${tab}`;

/** Cheap anchors: a URL fragment + one specific element. */
export const anchors = {
  login: { url: "/spa/login", el: "role=textbox[name='Username']" },
  password: { url: "/spa/login", el: "input[type=password]" },
  shell: { url: "/spa/", el: "nav[aria-label='Left navigation']" },
  home: { url: "/spa/home", el: "nav[aria-label='Left navigation'] a[href$='/home/appointments']" },
  chart: { url: "/chart", el: "[aria-label='patient banner']" },
  search: { url: "/spa/", el: "role=searchbox[name='Search for a patient by name or identifier number']" },
  workspace: { url: "/spa/", el: "#omrs-workspaces-container [aria-label='Workspace header']" },
  registration: { url: "/patient-registration", el: "role=button[name='Register patient']" },
};

/** The login form renders a permanently-visible empty Carbon `[role=alert]`; the real
 *  error is this text in a `[role=status]` toast. Never anchor on `[role=alert]`. */
export const BAD_CREDENTIALS = "Invalid username or password";

/** Aria noise: the header clock-ish bits and the ever-present empty alert. */
export const uiIgnore = [/^- alert$/, /Toggle Implementer Tools/];

// ---------------------------------------------------------------- wire helpers

/** Newest 200 response in THIS run whose URL contains every fragment. Parsed JSON, or null.
 *  Scoping by URL fragment (usually the patient uuid) survives react-query cache hits,
 *  where a second visit to a tab issues no request at all. */
export function wireJson(s: Session, ...contains: string[]): any {
  const where = contains.map(() => "url LIKE ?").join(" AND ");
  const rows = s.store.sql(
    `SELECT body_hash FROM requests WHERE run=? AND status=200 AND body_hash IS NOT NULL AND ${where}` +
    ` ORDER BY t_start DESC LIMIT 1`, s.run, ...contains.map((c) => `%${c}%`)) as any[];
  return rows[0] ? s.store.json(rows[0].body_hash) : null;
}

/** Every xhr/fetch row that started inside a report's window — the endpoint map, act by act. */
export function wireOf(s: Session, r: Report) {
  return s.store.sql(
    "SELECT method, url, status, body_hash, body_size FROM requests WHERE run=? AND resource_type IN ('xhr','fetch')" +
    " AND t_start >= ? AND t_start <= ? ORDER BY t_start", s.run, r.window.t0, r.window.t1) as any[];
}

/** The REST session resource, fetched from inside the page (page cookies, and it lands in the log). */
export async function session(s: Session): Promise<any> {
  return await s.evaluate(
    `fetch('${BASE}/ws/rest/v1/session',{headers:{'Disable-WWW-Authenticate':'true'}}).then(r=>r.json())`);
}

export async function whoami(s: Session) {
  const j = await session(s);
  return {
    authenticated: !!j?.authenticated,
    user: j?.user?.display ?? null,
    roles: (j?.user?.roles ?? []).map((r: any) => r.display),
    location: j?.sessionLocation?.display ?? null,
    provider: j?.currentProvider?.display ?? null,
  };
}

// ---------------------------------------------------------------- auth

/**
 * Log in. Two screens: username -> Continue -> password -> Log in.
 * Always navigates to the login URL first: a fresh document is the only way to be sure
 * the previous attempt's "Invalid username or password" toast is not still on screen
 * (it lingers and would satisfy the failure arm instantly). ~4-8 s on a cold browser.
 *
 * Returns `which: "shell" | "bad-credentials"`; it does not throw on bad credentials,
 * so a caller can probe. `reached()` the returned report if you need it to have worked.
 *
 * IMPORTANT: this only tests credentials when you are logged OUT. With a live JSESSIONID
 * the login page redirects itself to the shell after ~1-2 s, so ANY password "succeeds".
 * Call `logout(s)` first when probing. `ensureLoggedIn` is the normal entry point.
 */
export async function login(s: Session, username = "admin", password = "Admin123") {
  s.uiIgnore = uiIgnore;
  reached(await s.navigate(LOGIN_URL, { until: { selector: anchors.login.el, visible: true }, timeout: 30000 }), "login page");
  reached(await s.fill(anchors.login.el, username));
  reached(await s.click("role=button[name='Continue']", { until: { selector: anchors.password.el, visible: true }, timeout: 10000 }), "password step");
  reached(await s.fill(anchors.password.el, password));
  const r = await s.click("role=button[name='Log in']", {
    until: { any: [
      { selector: anchors.home.el, label: "shell" },
      { text: BAD_CREDENTIALS, label: "bad-credentials" },
    ] }, timeout: 30000,
  });
  return { act: r.action, which: (r.until?.which ?? "none") as "shell" | "bad-credentials" | "none", report: r };
}

/** Reach the shell, logging in only if the app asks. Cheap when already logged in (~2 s). */
export async function ensureLoggedIn(s: Session, username = "admin", password = "Admin123") {
  s.uiIgnore = uiIgnore;
  const r = await s.navigate(HOME_URL, { until: { any: [
    { selector: anchors.home.el, label: "shell" },
    { selector: anchors.login.el, label: "login" },
  ] }, timeout: 30000 });
  if (r.until?.which === "shell") return { act: r.action, which: "shell" as const };
  const l = await login(s, username, password);
  if (l.which !== "shell") throw new Error(`login failed: ${l.which} (${l.act})`);
  return { act: l.act, which: "logged-in" as const };
}

/**
 * Open the header's user menu panel.
 * The panel's contents (Super User / English / Password / Logout) are ALWAYS in the DOM
 * and always "visible" to Playwright — the panel is parked off the right edge, so
 * `until: { selector: "role=button[name='Logout']" }` is `alreadyTrue` and a click on
 * Logout is diagnosed `occluded`. The honest anchor is the Carbon slide-in class.
 * The aria tree does not change at all when the panel opens (`ui` diff is empty).
 */
export async function openUserMenu(s: Session) {
  const already = await s.until({ selector: ".cds--header-panel--expanded" }, { timeout: 400 });
  if (already.until?.ok) return { act: already.action, opened: false };
  const r = reached(await s.click("role=button[name='My Account']", {
    until: { selector: ".cds--header-panel--expanded" }, timeout: 8000,
  }), "open user menu");
  return { act: r.action, opened: true };
}

/** Log out. `DELETE /ws/rest/v1/session` -> 204 -> redirect to the login page. */
export async function logout(s: Session) {
  await openUserMenu(s);
  const r = reached(await s.click("role=button[name='Logout']", {
    until: { selector: anchors.login.el, visible: true }, timeout: 20000,
  }), "logout");
  return { act: r.action };
}

// ---------------------------------------------------------------- shell navigation

/** The left-nav apps of the home shell. */
export const homeApps = {
  "service-queues": { req: "/ws/rest/v1/queue-entry?", text: "Waiting list" },
  appointments: { req: "/ws/rest/v1/appointments?forDate=", text: "Appointments for" },
  "patient-lists": { req: "/ws/rest/v1/cohortm/cohort?", text: "Patient lists" },
  laboratory: { req: "/ws/rest/v1/order?orderTypes=", text: "Tests ordered" },
  ward: { req: "/ws/rest/v1/admissionLocation/", text: "" },
  billing: { req: "/ws/rest/v1/billing/bill?", text: "Bill list" },
} as const;
export type HomeApp = keyof typeof homeApps;

/**
 * Open one of the home apps by full navigation (a fresh document guarantees the fetch;
 * clicking the left-nav link inside the SPA can be served from the react-query cache).
 */
export async function openHomeApp(s: Session, app: HomeApp, timeout = 30000) {
  const spec = homeApps[app];
  const r = reached(await s.navigate(`${HOME_URL}/${app}`, {
    until: { all: [{ selector: anchors.home.el }, { request: spec.req, landed: true }] }, timeout,
  }), `open ${app}`);
  return { act: r.action, report: r };
}

// ---------------------------------------------------------------- patient search

/** Header search overlay. Idempotent: opens it only when its box is not already visible. */
export async function openPatientSearch(s: Session) {
  const already = await s.until({ selector: anchors.search.el, visible: true }, { timeout: 600 });
  if (already.until?.ok) return { act: already.action, opened: false };
  const r = reached(await s.click("role=button[name='Search patient']", {
    until: { selector: anchors.search.el, visible: true }, timeout: 15000,
  }), "open patient search");
  return { act: r.action, opened: true };
}

export type Hit = { uuid: string; name: string; identifier: string | null; gender: string | null; age: number | null; birthdate: string | null };

/**
 * Search patients by name or identifier. `fill` (not `type`) is enough — the box is a
 * controlled React input and one input event starts the request. The hits come off the
 * wire, not the DOM: `GET /ws/rest/v1/patient?q=<q>&v=custom:(...)`.
 * Queries under ~3 characters return 0 results server-side ("a" -> 0 hits).
 */
export async function searchPatients(s: Session, q: string, timeout = 20000): Promise<{ act: string; hits: Hit[] }> {
  await openPatientSearch(s);
  const r = reached(await s.fill(anchors.search.el, q, {
    until: { request: "/ws/rest/v1/patient?q=", landed: true }, timeout,
  }), `search "${q}"`);
  const body = s.store.latestJson("/ws/rest/v1/patient?q=", r.action) as any;
  const hits: Hit[] = (body?.results ?? []).map((p: any) => ({
    uuid: p.uuid,
    name: p.person?.display ?? p.display,
    identifier: p.identifiers?.[0]?.identifier ?? null,
    gender: p.person?.gender ?? null,
    age: p.person?.age ?? null,
    birthdate: p.person?.birthdate ?? null,
  }));
  return { act: r.action, hits };
}

// ---------------------------------------------------------------- patient chart

export type Demographics = { uuid: string; name: string | null; gender: string | null; birthDate: string | null; identifiers: string[]; deceased: boolean };

/**
 * Open a patient chart. Navigates (fresh document -> the FHIR Patient read always fires;
 * an in-SPA click can be a cache hit). Demographics come from
 * `GET /ws/fhir2/R4/Patient/<uuid>?_summary=data`, not from the banner text.
 */
export async function openChart(s: Session, uuid: string, tab = "patient-summary", timeout = 30000) {
  const r = reached(await s.navigate(chartUrl(uuid, tab), {
    until: { all: [
      { selector: anchors.chart.el },
      { request: `fhir2/R4/Patient/${uuid}`, landed: true },
    ] }, timeout,
  }), `open chart ${uuid}`);
  const p = wireJson(s, `fhir2/R4/Patient/${uuid}`);
  const demographics: Demographics = {
    uuid: p?.id ?? uuid,
    name: p?.name?.[0]?.text ?? null,
    gender: p?.gender ?? null,
    birthDate: p?.birthDate ?? null,
    identifiers: (p?.identifier ?? []).map((i: any) => i.value).filter(Boolean),
    deceased: !!p?.deceasedDateTime || p?.deceasedBoolean === true,
  };
  return { act: r.action, demographics, patient: p };
}

/**
 * The chart's left-nav tabs. `req` is the fragment an `until: { request }` matches;
 * `owns` is the extra URL fragment (always the patient uuid) that scopes the log read,
 * so a cached second visit still returns the right body.
 */
export const chartTabs = {
  "patient-summary": { req: "fhir2/R4/Patient/", text: "Vitals" },
  "vitals-and-biometrics": { req: "fhir2/R4/Observation", text: "Vitals" },
  medications: { req: "/ws/rest/v1/order?patient=", text: "medications" },
  results: { req: "/ws/rest/v1/obstree?patient=", text: "Results" },
  visits: { req: "ws/rest/v1/visit?patient=", text: "Visits" },
  allergies: { req: "fhir2/R4/AllergyIntolerance?patient=", text: "Allergies" },
  conditions: { req: "fhir2/R4/Condition?patient=", text: "Conditions" },
  immunizations: { req: "fhir2/R4/Immunization?patient=", text: "Immunizations" },
  procedures: { req: "/ws/rest/v1/procedure?patient=", text: "Procedures" },
  attachments: { req: "/ws/rest/v1/attachment?patient=", text: "Attachments" },
  programs: { req: "/ws/rest/v1/programenrollment?patient=", text: "Programs" },
  appointments: { req: "/ws/rest/v1/appointments/search", text: "Appointments" },
  "billing-history": { req: "/ws/rest/v1/billing/bill?", text: "" },
} as const;
export type ChartTab = keyof typeof chartTabs;

/**
 * Click a chart tab from inside the chart and return the body the tab rendered from.
 * Precondition: already on this patient's chart (`openChart`).
 * The `until` is the URL only; the request is then waited for with a SHORT budget,
 * because a tab you already visited in this document is served from the react-query
 * cache and issues nothing. Either way the body is read from the log, scoped to this
 * patient's uuid, so the answer is the same.
 */
export async function chartTab(s: Session, uuid: string, tab: ChartTab, timeout = 20000, cacheGraceMs = 2500) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: 3000 }), `on a chart before opening ${tab}`);
  const r = reached(await s.click(`nav[aria-label='Left navigation'] a[href$="/chart/${tab}"]`, {
    until: { url: `/chart/${tab}` }, timeout,
  }), `chart tab ${tab}`);
  const spec = chartTabs[tab];
  // Short on purpose: the patient-summary screen already fetched Conditions, Vitals,
  // Medications and Visits, so those tabs are cache hits and this budget is pure waste
  // when it expires. 2.5 s is enough for a real fetch on dev3 (observed 200-900 ms).
  const w = await s.until({ request: spec.req, landed: true }, { timeout: cacheGraceMs });
  const body = wireJson(s, spec.req.replace(/\?.*$/, "").replace(/=$/, ""), uuid);
  return { act: r.action, fromCache: !w.until?.ok, body };
}

/** FHIR Bundle of problem-list Conditions. */
export const conditions = (s: Session, uuid: string) => chartTab(s, uuid, "conditions");
/** FHIR Bundle of AllergyIntolerance. */
export const allergies = (s: Session, uuid: string) => chartTab(s, uuid, "allergies");
/** FHIR Bundle of vitals/biometrics Observations (BP, pulse, temp, SpO2, height, weight...). */
export const vitals = (s: Session, uuid: string) => chartTab(s, uuid, "vitals-and-biometrics");
/** REST page of visits with their encounters, obs and orders (large: ~250 KB). */
export const visits = (s: Session, uuid: string) => chartTab(s, uuid, "visits");

/** Count the entries of a FHIR searchset Bundle and pull one field per entry. */
export function bundleEntries(bundle: any, pick: (r: any) => any = (r) => r) {
  return (bundle?.entry ?? []).map((e: any) => pick(e.resource));
}

// ---------------------------------------------------------------- workspaces (right side rail)

/** The right side-rail buttons that open a workspace over the chart. */
export const workspaces = ["Clinical forms", "Order basket", "Visit note", "Task list", "Patient lists"] as const;

/**
 * Open a chart workspace. The container `#omrs-workspaces-container` is always in the
 * DOM; the honest anchor is its `[aria-label='Workspace header']` plus the title text.
 * Workspaces survive SPA route changes — always `closeWorkspace` when done.
 */
export async function openWorkspace(s: Session, name: (typeof workspaces)[number], timeout = 20000) {
  const r = reached(await s.click(`role=button[name="${name}"]`, {
    until: { selector: `#omrs-workspaces-container [aria-label='Workspace header']:has-text("${name}")` }, timeout,
  }), `open workspace ${name}`);
  return { act: r.action };
}

/** Close whatever workspace is open (no-op if none). */
export async function closeWorkspace(s: Session) {
  const open = await s.until({ selector: anchors.workspace.el }, { timeout: 600 });
  if (!open.until?.ok) return { act: open.action, closed: false };
  const r = reached(await s.click("#omrs-workspaces-container >> role=button[name='Close']", {
    until: { gone: anchors.workspace.el }, timeout: 10000,
  }), "close workspace");
  return { act: r.action, closed: true };
}

/** The patient's form list, from the "Clinical forms" workspace. Read-only: never opens a form. */
export async function clinicalForms(s: Session, uuid: string) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: 3000 }), "on a chart");
  const o = await openWorkspace(s, "Clinical forms");
  const rows = (await s.evaluate(
    `Array.from(document.querySelectorAll('#omrs-workspaces-container table tbody tr'))` +
    `.map(tr=>Array.from(tr.cells).map(c=>c.innerText.trim()))`)) as string[][];
  await closeWorkspace(s);
  return { act: o.act, forms: rows.map((r) => ({ name: r[0], lastCompleted: r[1] })) };
}

// ---------------------------------------------------------------- home apps as data

/** Patient lists = "cohorts". Returns every list the user can see. */
export async function patientLists(s: Session) {
  const r = await openHomeApp(s, "patient-lists");
  const body = s.store.latestJson("/ws/rest/v1/cohortm/cohort?", r.act) as any;
  return {
    act: r.act,
    lists: (body?.results ?? []).map((c: any) => ({
      uuid: c.uuid, name: c.name, size: c.size, type: c.cohortType?.display ?? null,
    })),
  };
}

/** Open one patient list and read its members off the wire. */
export async function openPatientList(s: Session, uuid: string, timeout = 20000) {
  const r = reached(await s.navigate(`${HOME_URL}/patient-lists/${uuid}`, {
    until: { all: [
      { selector: anchors.home.el },
      { request: `cohortm/cohortmember?cohort=${uuid}`, landed: true },
    ] }, timeout,
  }), `open list ${uuid}`);
  const body = wireJson(s, `cohortm/cohortmember?cohort=${uuid}`);
  return {
    act: r.action,
    members: (body?.results ?? []).map((m: any) => ({
      uuid: m.patient?.uuid, name: m.patient?.person?.display ?? m.patient?.display,
      identifier: m.patient?.identifiers?.[0]?.identifier ?? null, startDate: m.startDate ?? null,
    })),
  };
}

/**
 * Service queues (the default home app): who is waiting / in service at this location.
 * Two `queue-entry` requests fire per load — one per tab of the dashboard — so the
 * *newest* body is not necessarily the one with rows. This reads the largest.
 */
export async function serviceQueues(s: Session) {
  const r = await openHomeApp(s, "service-queues");
  const rows = s.store.sql(
    "SELECT body_hash, body_size FROM requests WHERE run=? AND status=200 AND url LIKE '%/ws/rest/v1/queue-entry?%'" +
    " AND t_start >= ? ORDER BY body_size DESC LIMIT 1", s.run, r.report.window.t0) as any[];
  const body = rows[0] ? s.store.json(rows[0].body_hash) : null;
  return {
    act: r.act,
    entries: (body?.results ?? []).map((e: any) => ({
      patient: e.patient?.person?.display ?? e.display,
      patientUuid: e.patient?.uuid,
      queue: e.queue?.display ?? null,
      status: e.status?.display ?? null,
      priority: e.priority?.display ?? null,
      startedAt: e.startedAt ?? null,
    })),
  };
}

/** Appointments for a date (default: whatever date the app opens on — today). */
export async function appointmentsForDate(s: Session) {
  const r = await openHomeApp(s, "appointments");
  const body = s.store.latestJson("/ws/rest/v1/appointments?forDate=", r.act) as any;
  const list = Array.isArray(body) ? body : (body?.results ?? []);
  return {
    act: r.act,
    appointments: list.map((a: any) => ({
      uuid: a.uuid, patient: a.patient?.name ?? null, service: a.service?.name ?? null,
      startDateTime: a.startDateTime ?? null, status: a.status ?? null,
    })),
  };
}

/** Lab orders worklist. `tab` is one of the dashboard's four tabs; this reads "Tests ordered". */
export async function laboratory(s: Session) {
  const r = await openHomeApp(s, "laboratory");
  const body = s.store.latestJson("/ws/rest/v1/order?orderTypes=", r.act) as any;
  return { act: r.act, orders: (body?.results ?? []) };
}
