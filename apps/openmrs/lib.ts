// apps/openmrs/lib.ts — OpenMRS 3.x ("O3") demo instance, driven read-only.
//
// Rules kept throughout: anchor in -> anchor out, an `until` on every transition,
// facts read from the wire when they travel on it, `reached()` on every step.
//
// NOTHING HERE WRITES. Every function is a read: navigation, search, and GETs.
// The write affordances the UI offers (Add patient, Add allergy/condition, the
// order basket, visit note, appointment status) are deliberately not wrapped.
import { reached, type Session } from "../../src/index.ts";

export const ORIGIN = "https://dev3.openmrs.org";
export const SPA = `${ORIGIN}/openmrs/spa`;
export const HOME = `${SPA}/home`;
export const LOGIN = `${SPA}/login`;

/** Cheap anchors: URL fragment + one specific element that only that screen has. */
export const anchors = {
  login:      { url: "/spa/login",  el: "#username" },
  loginPw:    { url: "/spa/login",  el: "role=button[name='Log in']" },
  loginLoc:   { url: "/login/location", el: "role=button[name='Confirm']" },
  // The app shell (header + left nav) is the same on every /home/* route.
  shell:      { url: "/spa/home",   el: "nav a[href$='/home/appointments']" },
  chart:      { url: "/chart",      el: "[aria-label='patient banner']" },
  searchPanel:{ url: "",            el: "input[placeholder='Search for a patient by name or identifier number']" },
} as const;

/** The header search box. Its DOM id is a React-generated `search-input-:r1d:` — never use it. */
export const SEARCH_BOX = anchors.searchPanel.el;

/**
 * Aria-diff noise. The patient banner re-renders a vitals strip and the queue
 * dashboard a wait-time counter; neither is ever the fact you want.
 */
export const uiIgnore = [/Avg\. wait time/, /These vitals are/, /^\s*[-+] - img$/];

// ------------------------------------------------------------------ helpers

/** Fetch from inside the page: uses the JSESSIONID cookie AND lands in the log. */
export async function api(s: Session, path: string): Promise<any> {
  return await s.evaluate(
    `fetch(${JSON.stringify(path)}, { headers: { accept: 'application/json' } }).then(r => r.json())`);
}

/** The REST session: who am I, am I authenticated, which location am I at. */
export async function readSession(s: Session) {
  const j = await api(s, "/openmrs/ws/rest/v1/session");
  return {
    authenticated: !!j.authenticated,
    user: j.user?.display ?? null,
    person: j.user?.person?.display ?? null,
    roles: (j.roles ?? []).map((r: any) => r.name),
    location: j.sessionLocation?.display ?? null,
    provider: j.currentProvider?.display ?? null,
  };
}

// ------------------------------------------------------------------ auth

/**
 * Log in from anywhere. Two screens in one page: username + "Continue",
 * then password + "Log in".  The wire fact is a single
 * `GET /openmrs/ws/rest/v1/session` carrying `Authorization: Basic …`;
 * its 200 sets `JSESSIONID` (Path=/openmrs, HttpOnly).
 *
 * `which`: "home" when the user has a default location (this instance's admin does),
 * "location" when OpenMRS asks for a session location first, "bad" on wrong credentials.
 */
export async function login(s: Session, username: string, password: string) {
  s.uiIgnore = uiIgnore;
  reached(await s.navigate(LOGIN, { until: { any: [
    { selector: anchors.login.el, label: "login" },
    { selector: anchors.shell.el, label: "already-in" },
  ] }, timeout: 25000 }), "reach login");
  if (await s.page.locator(anchors.shell.el).isVisible()) return { which: "home" as const, act: null };

  reached(await s.fill("#username", username), "username");
  reached(await s.click("role=button[name='Continue']",
    { until: { selector: anchors.loginPw.el }, timeout: 8000 }), "continue");
  reached(await s.fill("#password", password), "password");
  const r = await s.click("role=button[name='Log in']", { until: { any: [
    { url: "/spa/home", label: "home" },
    { url: "/login/location", label: "location" },
    { selector: "[role=alert]:has-text('Invalid')", label: "bad" },
  ] }, timeout: 25000 });
  if (!r.until?.ok) throw new Error(`login: ${r.until?.diagnosis?.message ?? "no landing"}`);
  const which = r.until.which as "home" | "location" | "bad";
  if (which === "bad") throw new Error("login: invalid credentials");
  if (which === "location") {
    // Not seen on dev3 with the `admin` user (it has userProperties.defaultLocation),
    // but O3 shows a location picker when the user has none. Confirm the first option.
    reached(await s.click("role=button[name='Confirm']",
      { until: { url: "/spa/home" }, timeout: 20000 }), "confirm location");
  }
  reached(await s.until({ selector: anchors.shell.el }, { timeout: 20000 }), "shell after login");
  return { which, act: r.action };
}

/**
 * Log out. The "User menu options" list (Super User / English / Password / Logout) is
 * ALWAYS in the DOM and always `visible` to Playwright — the header only slides it into
 * view — so `until: { selector: "role=button[name='Logout']" }` on the My Account click
 * is `alreadyTrue` and proves nothing. Open the menu with a bare act (or skip it), then
 * click Logout with the login screen as the postcondition.
 */
export async function logout(s: Session) {
  await s.click("role=button[name='My Account']", { window: 200 });   // bare: no postcondition exists
  const r = reached(await s.click("role=button[name='Logout']",
    { until: { selector: anchors.login.el }, timeout: 25000 }), "logout");
  return { act: r.action };
}

// ------------------------------------------------------------------ shell

/** Assert we are on the app shell without navigating. */
export async function atShell(s: Session) {
  return reached(await s.until({ selector: anchors.shell.el }, { timeout: 3000 }), "at shell");
}

/**
 * Reach the shell. Always navigates — a cold reload of /spa/home is ~2-6 s on dev3.
 * The login page is an arm of the anchor, so an expired session costs a redirect, not a budget.
 */
export async function goHome(s: Session, opts: { allowLogin?: boolean } = {}) {
  s.uiIgnore = uiIgnore;
  const r = reached(await s.navigate(HOME, { until: { any: [
    { selector: anchors.shell.el, label: "shell" },
    { selector: anchors.login.el, label: "login" },
  ] }, timeout: 25000 }), "go home");
  const which = r.until?.which as "shell" | "login";
  if (which === "login" && !opts.allowLogin) throw new Error(`go home: bounced to ${s.page.url()} — log in first`);
  return { act: r.action, which };
}

/** The six home apps, each with the element that proves it rendered (not just routed). */
export const homeApps = {
  "service-queues": { el: "h2:has-text('Waiting list')" },
  "appointments":   { el: "h2:has-text('Appointments for')" },
  "patient-lists":  { el: "role=tab[name='Starred lists']" },
  "ward":           { el: "main h2" },
  "laboratory":     { el: "role=tab[name='Tests ordered']" },
  "billing":        { el: "main" },
} as const;
export type HomeApp = keyof typeof homeApps;

/**
 * Open one of the left-nav home apps. `via: "nav"` clicks the link (client-side route,
 * fast); `via: "url"` reloads (slow, but works from the patient chart, whose left nav
 * is the *chart's* nav, not the home nav).
 */
export async function openHomeApp(s: Session, app: HomeApp, opts: { via?: "nav" | "url" } = {}) {
  const via = opts.via ?? (await s.page.locator(anchors.shell.el).isVisible() ? "nav" : "url");
  const until = { selector: homeApps[app].el };
  const r = via === "nav"
    ? reached(await s.click(`nav a[href$='/home/${app}']`, { until, timeout: 25000 }), `open ${app}`)
    : reached(await s.navigate(`${HOME}/${app}`, { until, timeout: 25000 }), `open ${app}`);
  return { act: r.action, url: s.page.url() };
}

// ------------------------------------------------------------------ patient search

export type PatientHit = {
  uuid: string; display: string; name: string; identifier: string;
  gender: string; age: number; birthdate: string; chartUrl: string;
};

/** Open the header patient-search panel (idempotent: no-op when it is already open). */
export async function openSearchPanel(s: Session) {
  if (await s.page.locator(SEARCH_BOX).isVisible()) return { act: null, alreadyOpen: true };
  const r = reached(await s.click("role=button[name='Search patient']",
    { until: { selector: SEARCH_BOX }, timeout: 10000 }), "open search panel");
  return { act: r.action, alreadyOpen: false };
}

/**
 * Search patients from the header. Keystrokes (`type`, not `fill`) — the box is
 * debounced and fires one `GET /openmrs/ws/rest/v1/patient?q=…` after the last key.
 * The rows on screen are a rendering of that body; the facts come off the wire.
 */
export async function searchPatients(s: Session, q: string, budgetMs = 20000): Promise<{ act: string; hits: PatientHit[] }> {
  await openSearchPanel(s);
  reached(await s.fill(SEARCH_BOX, ""), "clear search box");
  const r = await s.type(SEARCH_BOX, q, { until: { request: `/rest/v1/patient?q=${encodeURIComponent(q)}`, landed: true }, timeout: budgetMs });
  if (!r.until?.ok) throw new Error(`searchPatients(${q}): ${r.until?.diagnosis?.message ?? "no search response"}`);
  const body = s.store.latestJson(`/rest/v1/patient?q=${encodeURIComponent(q)}`, r.action);
  const hits: PatientHit[] = (body?.results ?? []).map((p: any) => ({
    uuid: p.uuid,
    display: p.display,
    name: p.person?.personName?.display ?? p.display,
    identifier: p.patientIdentifier?.identifier ?? p.identifiers?.[0]?.identifier ?? "",
    gender: p.person?.gender ?? "",
    age: p.person?.age ?? -1,
    birthdate: (p.person?.birthdate ?? "").slice(0, 10),
    chartUrl: `${SPA}/patient/${p.uuid}/chart/`,
  }));
  return { act: r.action, hits };
}

/** Close the search panel and return to whatever was behind it. */
export async function closeSearchPanel(s: Session) {
  if (!(await s.page.locator(SEARCH_BOX).isVisible())) return { act: null };
  const r = reached(await s.click("role=button[name='Close Search Panel']",
    { until: { gone: SEARCH_BOX }, timeout: 8000 }), "close search panel");
  return { act: r.action };
}

// ------------------------------------------------------------------ patient chart

export const chartTabs = {
  "patient-summary":      { el: "h4:text-is('Conditions')",      wire: "/fhir2/R4/Condition?patient=" },
  "vitals-and-biometrics":{ el: "h4:has-text('Vitals')",         wire: "/fhir2/R4/Observation?" },
  "medications":          { el: "h4:has-text('medications')",    wire: "/rest/v1/order?patient=" },
  "orders":               { el: "h4:has-text('Orders')",         wire: "/rest/v1/order?patient=" },
  "results":              { el: "main",                          wire: "/fhir2/R4/Observation?" },
  "visits":               { el: "h4:has-text('Visits')",         wire: "/rest/v1/visit?patient=" },
  "allergies":            { el: "h4:text-is('Allergies')",       wire: "/fhir2/R4/AllergyIntolerance?patient=" },
  "conditions":           { el: "h4:text-is('Conditions')",      wire: "/fhir2/R4/Condition?patient=" },
  "programs":             { el: "h4:has-text('Program')",        wire: "/rest/v1/programenrollment" },
  "appointments":         { el: "h4:has-text('Appointments')",   wire: "/rest/v1/appointment" },
  "attachments":          { el: "h4:has-text('Attachments')",    wire: "/rest/v1/attachment" },
  "immunizations":        { el: "h4:has-text('Immunizations')",  wire: "/fhir2/R4/Immunization" },
} as const;
export type ChartTab = keyof typeof chartTabs;

export const chartUrl = (uuid: string, tab = "") => `${SPA}/patient/${uuid}/chart/${tab}`;

/**
 * Open a patient chart cold (full reload). The `{ url: "/chart" }` predicate is NOT
 * enough — client-side routing changes the URL long before the chart app is fetched.
 * Anchor on the patient banner; the demographics come off `GET /ws/fhir2/R4/Patient/<uuid>`.
 */
export async function openChart(s: Session, uuid: string, budgetMs = 30000) {
  s.uiIgnore = uiIgnore;
  const r = reached(await s.navigate(chartUrl(uuid), {
    until: { selector: anchors.chart.el }, timeout: budgetMs }), "open chart");
  const fhir = s.store.latestJson(`/fhir2/R4/Patient/${uuid}`, r.action);
  const name = fhir?.name?.[0];
  return {
    act: r.action,
    uuid,
    banner: (await s.page.locator(anchors.chart.el).innerText()).replace(/\s+/g, " ").trim(),
    patient: fhir ? {
      id: fhir.id,
      name: name ? [ (name.given ?? []).join(" "), name.family ].filter(Boolean).join(" ") : (name?.text ?? null),
      gender: fhir.gender ?? null,
      birthDate: fhir.birthDate ?? null,
      identifiers: (fhir.identifier ?? []).map((i: any) => `${i.type?.text ?? i.system ?? "id"}=${i.value}`),
      deceased: !!fhir.deceasedDateTime || fhir.deceasedBoolean === true,
    } : null,
  };
}

/**
 * Move to another tab of the chart that is already open (client-side, ~0.5 s).
 * Returns the body the tab fetched, scoped to this act — or `null` when the tab was
 * served from the app's SWR cache and issued no request at all (the patient-summary
 * widgets pre-fetch Condition, Observation and order for the same patient, so the
 * Conditions / Vitals / Medications tabs are usually silent). Never make `body` a
 * postcondition: anchor on `spec.el` and re-read with `conditions()`/`allergies()`
 * when you need the data regardless.
 */
export async function openChartTab(s: Session, uuid: string, tab: ChartTab, budgetMs = 25000) {
  reached(await s.until({ selector: anchors.chart.el }, { timeout: 3000 }), "chart is open");
  const spec = chartTabs[tab];
  const r = reached(await s.click(`nav a[href$='/chart/${tab}']`,
    { until: { selector: spec.el }, timeout: budgetMs }), `chart tab ${tab}`);
  return { act: r.action, url: s.page.url(), body: s.store.latestJson(spec.wire, r.action) ?? null };
}

/** Rows of a Carbon data table as arrays of cell text. Use for a table with no wire body. */
export async function tableRows(s: Session, tableSelector = "main table"): Promise<string[][]> {
  return await s.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(tableSelector)} + ' tbody tr')]` +
    `.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()))`) as string[][];
}

// ------------------------------------------------------------------ wire-first reads (no UI at all)

/** Allergies as the chart shows them, straight off FHIR. */
export async function allergies(s: Session, uuid: string) {
  const b = await api(s, `/openmrs/ws/fhir2/R4/AllergyIntolerance?patient=${uuid}&_summary=data`);
  return (b.entry ?? []).map((e: any) => ({
    allergen: e.resource?.code?.text ?? e.resource?.code?.coding?.[0]?.display ?? null,
    severity: e.resource?.reaction?.[0]?.severity ?? null,
    reactions: (e.resource?.reaction?.[0]?.manifestation ?? []).map((m: any) => m.text ?? m.coding?.[0]?.display),
  }));
}

/** Active problem-list conditions, straight off FHIR. */
export async function conditions(s: Session, uuid: string) {
  const b = await api(s, `/openmrs/ws/fhir2/R4/Condition?patient=${uuid}&_count=100`);
  return (b.entry ?? []).map((e: any) => ({
    text: e.resource?.code?.text ?? e.resource?.code?.coding?.[0]?.display ?? null,
    clinicalStatus: e.resource?.clinicalStatus?.coding?.[0]?.code ?? null,
    onset: e.resource?.onsetDateTime ?? null,
  }));
}

/** Visits (REST, not FHIR — the chart's Visits tab uses this shape). */
export async function visits(s: Session, uuid: string) {
  const b = await api(s, `/openmrs/ws/rest/v1/visit?patient=${uuid}&v=custom:(uuid,display,startDatetime,stopDatetime,location:(display),visitType:(display))`);
  return (b.results ?? []).map((v: any) => ({
    uuid: v.uuid, type: v.visitType?.display ?? null, location: v.location?.display ?? null,
    start: v.startDatetime, stop: v.stopDatetime,
  }));
}

/** Today's appointments, as the Appointments home app loads them. */
export async function appointmentsForDate(s: Session, isoDate: string) {
  const b = await api(s, `/openmrs/ws/rest/v1/appointments?forDate=${encodeURIComponent(isoDate)}`);
  return (Array.isArray(b) ? b : b.results ?? []).map((a: any) => ({
    uuid: a.uuid, patient: a.patient?.name ?? null, service: a.service?.name ?? null,
    status: a.status, start: a.startDateTime,
  }));
}

/** The patient lists (cohorts) the Patient lists home app shows. */
export async function patientLists(s: Session) {
  const b = await api(s, "/openmrs/ws/rest/v1/cohortm/cohort?v=custom:(uuid,name,description,size,cohortType:(display))");
  return (b.results ?? []).map((c: any) => ({ uuid: c.uuid, name: c.name, size: c.size, type: c.cohortType?.display ?? null }));
}
