// Function library for OpenMRS O3 (reference application, public dev demo) — product instance #4.
// Plain importable TS: anchor in → act WITH the postcondition → facts off the wire → anchor out.
// Discovery evidence: apps/openmrs/store (run 2, dev3.openmrs.org), acts cited in nav-and-quirks.md.
//
//   import { connect } from "../../src/client.ts";
//   import * as o from "./lib.ts";
//   const s = await connect("openmrs");
//   await o.login(s);                                  // idempotent; handles the location picker if it appears
//   const p = await o.findPatient(s, "Susan");         // off GET /ws/rest/v1/patient?q=…
//   await o.openPatient(s, p.uuid);                    // chart anchor (patient banner)
//   const sum = await o.extractSummary(s);             // conditions / allergies / latest vitals off FHIR bodies
//
// Write footprint: login() POSTs /ws/rest/v1/session (+ /user/<uuid> userProperties) ONLY when it has to pick
// a location; opening a chart makes the app itself POST /user/<uuid> (patientsVisited) — unavoidable, app-side.
import type { Session } from "../../src/client.ts";
import type { Report } from "../../src/report.ts";
import { until, reached, assertVisible, actIfPresent } from "../../lib/nav.ts";

export const ORIGIN = "https://dev3.openmrs.org";
export const SPA = `${ORIGIN}/openmrs/spa`;
export const CREDS = { username: "admin", password: "Admin123" };

/** Selectors (Carbon design system + O3 test ids). Prefer data-testid / role+name; ids are React-generated (:r5o:). */
export const SEL = {
  username: "#username",
  password: "#password",
  continueBtn: 'role=button[name="Continue"]',
  loginBtn: 'role=button[name="Log in"]',
  locationRadios: 'input[name="loginLocations"]',
  locationConfirm: 'role=button[name="Confirm"]',
  shell: 'button[aria-label="Search patient"]',            // header search icon: present on every logged-in page
  searchBar: '[data-testid="patientSearchBar"]',
  chartBanner: '[data-testid="patient-banner-button-col"]', // patient banner action column: the chart anchor
  backendDepsToastClose: 'role=alertdialog >> role=button[name="close notification"]', // actionable toast after login (act:32)
};

const SEL_ERR = '.cds--inline-notification--error, [role="status"].cds--inline-notification';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOW = 45000; // dev3 is a shared, slow demo: chart loads carry 100+ requests (act:11 settled at 2.7s, still-active)

// ---------------------------------------------------------------------------------------------------------------
// Anchors — cheap predicates (URL + landmark), read in ONE in-page round trip.

export type Where = "login.username" | "login.password" | "login.location" | "home" | "search" | "chart" | "shell" | "other";
export interface Position { where: Where; url: string; path: string; patientUuid?: string }

/** Where are we? Never assumes position — every pack function starts here. */
export async function whereAmI(s: Session): Promise<Position> {
  const v = await s.evaluate<{ url: string; path: string; u: boolean; p: boolean; radios: number; shell: boolean; banner: boolean; searchBar: boolean }>(() => ({
    url: location.href, path: location.pathname,
    // NOTE: #password is in the DOM (hidden) during the username step — the step is told by which submit button is up
    u: [...document.querySelectorAll('button[type="submit"]')].some((b) => b.textContent?.trim() === "Continue"),
    p: [...document.querySelectorAll('button[type="submit"]')].some((b) => b.textContent?.trim() === "Log in"),
    radios: document.querySelectorAll('input[name="loginLocations"]').length,
    shell: !!document.querySelector('button[aria-label="Search patient"]'),
    banner: !!document.querySelector('[data-testid="patient-banner-button-col"]'),
    searchBar: !!document.querySelector('[data-testid="patientSearchBar"]'),
  }));
  const m = v.path.match(/\/spa\/patient\/([0-9a-f-]{36})\/chart/i);
  let where: Where = "other";
  if (/\/spa\/login\/location/.test(v.path) && v.radios > 0) where = "login.location";
  else if (/\/spa\/login/.test(v.path) && v.p) where = "login.password";
  else if (/\/spa\/login/.test(v.path) && v.u) where = "login.username";
  else if (m && v.banner) where = "chart";
  else if (/\/spa\/search/.test(v.path) && v.searchBar) where = "search";
  else if (/\/spa\/home/.test(v.path) && v.shell) where = "home";
  else if (v.shell) where = "shell";
  return { where, url: v.url, path: v.path, patientUuid: m?.[1] };
}

/** Anchor: logged in — the header (with its "Search patient" icon) is up. */
export async function assertShell(s: Session, budgetMs = 10000): Promise<void> {
  await assertVisible(s, SEL.shell, "openmrs: not in the logged-in shell (header search icon missing)", { budgetMs });
}

/** Anchor: a patient chart — URL /patient/<uuid>/chart + the banner's action column rendered. */
export async function assertChart(s: Session, uuid?: string, budgetMs = 10000): Promise<string> {
  await until(s, { fn: (u: string) => (!u || location.pathname.includes(`/patient/${u}/chart`)) && !!document.querySelector('[data-testid="patient-banner-button-col"]'), fnArg: uuid ?? "" },
    { budgetMs, msg: `openmrs: not at the chart anchor${uuid ? ` for ${uuid}` : ""}` });
  const pos = await whereAmI(s);
  if (!pos.patientUuid) throw new Error(`openmrs: chart URL has no patient uuid (${pos.url})`);
  return pos.patientUuid;
}

// ---------------------------------------------------------------------------------------------------------------
// Wire helpers — the store is the fact source; the DOM is for acting.

/** Newest captured JSON body whose URL contains `urlLike` (SQL LIKE fragment, % added), optionally after a time. */
export function lastBody<T = any>(s: Session, urlLike: string, opts: { since?: number; actionId?: string } = {}): T | undefined {
  const rows = s.store.sql<{ body_hash: string | null; t_start: number }>(
    `SELECT body_hash, t_start FROM requests WHERE url LIKE ? AND body_hash IS NOT NULL AND status BETWEEN 200 AND 299` +
    (opts.since !== undefined ? ` AND t_start >= ${Number(opts.since)}` : "") + (opts.actionId ? ` AND action_id = '${opts.actionId.replace(/'/g, "")}'` : "") +
    ` ORDER BY t_start DESC LIMIT 1`, `%${urlLike}%`);
  const row = rows[0];
  return row?.body_hash ? (s.store.json(row.body_hash) as T) : undefined;
}

export interface SessionInfo { authenticated: boolean; user?: { uuid: string; display: string }; sessionLocation?: { uuid: string; display: string }; currentProvider?: { uuid: string; display: string } }

/** The latest /ws/rest/v1/session body the app fetched — who is logged in, where. (The app re-fetches it on every
 *  page; a login is just this GET with a Basic Authorization header, the truth is `authenticated`.) */
export function sessionInfo(s: Session): SessionInfo | undefined {
  return lastBody<SessionInfo>(s, "/ws/rest/v1/session");
}

// ---------------------------------------------------------------------------------------------------------------
// login — idempotent; two-step form (username → Continue → password → Log in); optional location picker.

export interface LoginOpts { username?: string; password?: string; /** preferred location name or uuid when the picker appears */ location?: string; budgetMs?: number }

export async function login(s: Session, opts: LoginOpts = {}): Promise<SessionInfo> {
  const budgetMs = opts.budgetMs ?? SLOW;
  let pos = await whereAmI(s);
  // (0) already in? the shell is up and the last session body says authenticated → nothing to do (idempotent)
  if (pos.where === "home" || pos.where === "shell" || pos.where === "chart" || pos.where === "search") {
    const info = sessionInfo(s);
    if (info?.authenticated) return info;
  }
  // (1) not on a login page → go there. An authenticated user hitting /login is bounced to home (returns the shell).
  if (!pos.where.startsWith("login.")) {
    reached(await s.navigate(`${SPA}/login`, { budgetMs, until: { fn: () => !!document.querySelector("#username") || !!document.querySelector('button[aria-label="Search patient"]'), budgetMs } }), "login: open login page");
    pos = await whereAmI(s);
    if (pos.where === "home" || pos.where === "shell") { const info = sessionInfo(s); if (info?.authenticated) return info; }
  }
  // (2) username step (act:1-2: Continue swaps the field for the password field client-side; no wire)
  if (pos.where === "login.username") {
    // Retry once: on a cold load the React form can re-render over the fill (controlled input → empty → the `required`
    // validation swallows Continue with no DOM change) — run-check #1 failed exactly there.
    for (let attempt = 0; attempt < 2; attempt++) {
      const u = opts.username ?? CREDS.username;
      reached(await s.fill(SEL.username, u, { until: { fn: (x: string) => (document.querySelector("#username") as HTMLInputElement | null)?.value === x, fnArg: u, budgetMs: 5000 } }), "login: fill username");
      const r = await s.click(SEL.continueBtn, { until: { selector: SEL.loginBtn, visible: true, budgetMs: 10000 } });
      if (r.verdict !== "diagnosis" && r.until?.matched) break;
      if (attempt === 1) reached(r, "login: Continue");
    }
    pos = await whereAmI(s);
  }
  // (3) password step: GET /ws/rest/v1/session with Basic auth (act:4), then EITHER the shell, OR the location picker,
  //     OR an inline error. Wait for any of the three; decide from the wire + DOM, never from the verdict.
  if (pos.where === "login.password") {
    reached(await s.fill(SEL.password, opts.password ?? CREDS.password), "login: fill password");
    // (closures do not transfer into the page: the error selector travels as fnArg)
    const r = await s.click(SEL.loginBtn, { budgetMs, until: { budgetMs, fnArg: SEL_ERR, fn: (err: string) =>
      !!document.querySelector('button[aria-label="Search patient"]') || document.querySelectorAll('input[name="loginLocations"]').length > 0 || !!document.querySelector(err) } });
    reached(r, "login: Log in");
    pos = await whereAmI(s);
    if (pos.where === "login.password" || pos.where === "login.username") {
      // bad credentials: GET /session answers 200 {authenticated:false} (no 401) and the form drops back to the username
      // step with an inline "Invalid username or password" notification (act:23)
      const info = sessionInfo(s);
      const alert = await s.evaluate<string>((err: string) => (document.querySelector(err) as HTMLElement | null)?.innerText?.trim() ?? "", { args: [SEL_ERR] });
      throw new Error(`login: still on the login page after Log in (verdict ${r.verdict}; session.authenticated=${info?.authenticated}; notification=${JSON.stringify(alert)})`);
    }
  }
  // (4) the location picker — present OR absent (absent when the user has a stored default location; act:4 skipped it,
  //     act:5-8 reached it via "Change location"). Radios are visually hidden by Carbon: click the LABEL (act:6 vs act:7).
  if (pos.where === "login.location") {
    if (opts.location) {
      const uuid = UUID_RE.test(opts.location) ? opts.location : await locationUuidByName(s, opts.location);
      reached(await s.click(`label[for="${uuid}"]`, { until: { fn: (u: string) => (document.querySelector('input[name="loginLocations"]:checked') as HTMLInputElement | null)?.value === u, fnArg: uuid, budgetMs: 5000 } }), `login: pick location ${opts.location}`);
    } else {
      // keep the pre-checked one; if nothing is checked, take the first radio (any location is fine for a demo)
      const checked = await s.evaluate<string | null>(() => (document.querySelector('input[name="loginLocations"]:checked') as HTMLInputElement | null)?.value ?? null);
      if (!checked) {
        const first = await s.evaluate<string>(() => (document.querySelector('input[name="loginLocations"]') as HTMLInputElement).value);
        reached(await s.click(`label[for="${first}"]`, { until: { fn: () => !!document.querySelector('input[name="loginLocations"]:checked'), budgetMs: 5000 } }), "login: pick first location");
      }
    }
    // Confirm → POST /ws/rest/v1/session {sessionLocation} ✎ (+ POST /user/<uuid>), returnToUrl → shell (act:8)
    reached(await s.click(SEL.locationConfirm, { budgetMs, until: { selector: SEL.shell, visible: true, budgetMs } }), "login: Confirm location");
  }
  await assertShell(s, budgetMs);
  // (5) optional, non-blocking interstitial: an actionable toast "Some modules have unresolved backend dependencies"
  //     (role=alertdialog, top-right, seen 1/4 logins — act:31). Dismiss if it shows up; absent path is first-class.
  await actIfPresent(s, SEL.backendDepsToastClose, { budgetMs: 1500 });
  const info = sessionInfo(s);
  if (!info?.authenticated) throw new Error(`login: shell is up but the last /ws/rest/v1/session body says authenticated=${info?.authenticated}`);
  return info;
}

/** Resolve a login-location name → uuid from the FHIR bundle the picker fetched (Location?_tag=Login+Location). */
async function locationUuidByName(s: Session, name: string): Promise<string> {
  const bundle = lastBody<{ entry?: Array<{ resource: { id: string; name: string } }> }>(s, "/ws/fhir2/R4/Location?%_tag=Login%");
  const hit = bundle?.entry?.find((e) => e.resource.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.resource.id;
  // not on the wire (e.g. beyond the first 50) → the picker's own search box, then read the radio
  reached(await s.fill('role=searchbox[name="Search for a location"]', name, { until: { fn: (n: string) => [...document.querySelectorAll('label[for]')].some((l) => l.textContent?.trim().toLowerCase() === n.toLowerCase()), fnArg: name, budgetMs: 10000 } }), `login: search location ${name}`);
  const uuid = await s.evaluate<string | null>((n: string) => ([...document.querySelectorAll('label[for]')].find((l) => l.textContent?.trim().toLowerCase() === n.toLowerCase()) as HTMLLabelElement | undefined)?.htmlFor ?? null, { args: [name] });
  if (!uuid) throw new Error(`login: location ${JSON.stringify(name)} not offered by the picker`);
  return uuid;
}

// ---------------------------------------------------------------------------------------------------------------
// findPatient — the search page route + the REST search response (never the rendered cards).

export interface PatientHit { uuid: string; name: string; identifier?: string; gender?: string; age?: number; birthdate?: string; dead?: boolean; display: string }
export interface SearchResult extends PatientHit { total: number; all: PatientHit[]; query: string }

interface RestPatient { uuid: string; display: string; identifiers?: Array<{ identifier: string; preferred?: boolean }>; person?: { display?: string; gender?: string; age?: number; birthdate?: string; dead?: boolean } }

export async function findPatient(s: Session, name: string, opts: { budgetMs?: number } = {}): Promise<SearchResult> {
  const budgetMs = opts.budgetMs ?? SLOW;
  await login(s); // precondition: in the shell (no-op when already in)
  // The full-page search route fires GET /ws/rest/v1/patient?q=<name>&v=custom:(…)&limit=10&totalCount=true on load
  // (act:13). The postcondition is THAT request landing — the cards are downstream of it.
  const q = encodeURIComponent(name);
  const r = reached(await s.navigate(`${SPA}/search?query=${q}`, { budgetMs, until: { urlLike: `/ws/rest/v1/patient?q=${q.replace(/%20/g, "+")}`, landed: true, budgetMs } }), `findPatient(${name})`);
  const body = lastBody<{ results: RestPatient[]; totalCount?: number }>(s, `/ws/rest/v1/patient?q=`, { since: s.store.action(r.action)?.t_start });
  if (!body) throw new Error(`findPatient(${name}): search request matched but no body captured (verdict ${r.verdict})`);
  const all = body.results.map(toHit);
  if (all.length === 0) throw new Error(`findPatient(${name}): 0 results (totalCount ${body.totalCount ?? "?"})`);
  const lname = name.trim().toLowerCase();
  const best = all.find((h) => h.name.toLowerCase() === lname) ?? all[0];
  return { ...best, total: body.totalCount ?? all.length, all, query: name };
}

function toHit(p: RestPatient): PatientHit {
  const pref = p.identifiers?.find((i) => i.preferred) ?? p.identifiers?.[0];
  return { uuid: p.uuid, name: p.person?.display ?? p.display.replace(/^\S+\s+-\s+/, ""), identifier: pref?.identifier, gender: p.person?.gender, age: p.person?.age, birthdate: p.person?.birthdate, dead: p.person?.dead, display: p.display };
}

// ---------------------------------------------------------------------------------------------------------------
// openPatient — reach the chart anchor for a uuid or a name; click the result card when it is on screen, else navigate.

export interface ChartInfo { uuid: string; name?: string; gender?: string; birthDate?: string; identifiers: string[]; url: string }

export async function openPatient(s: Session, uuidOrName: string, opts: { budgetMs?: number } = {}): Promise<ChartInfo> {
  const budgetMs = opts.budgetMs ?? SLOW;
  const uuid = UUID_RE.test(uuidOrName) ? uuidOrName : (await findPatient(s, uuidOrName)).uuid;
  const pos = await whereAmI(s);
  if (pos.where === "chart" && pos.patientUuid === uuid) return chartInfo(s, uuid, pos.url);
  const untilChart = { fn: (u: string) => location.pathname.includes(`/patient/${u}/chart`) && !!document.querySelector('[data-testid="patient-banner-button-col"]'), fnArg: uuid, budgetMs };
  const card = `a[href*="/patient/${uuid}/chart"]`;
  let r: Report;
  if (pos.where === "search" && (await s.watch({ selector: card, visible: true }, { budgetMs: 1500 })).matched) {
    r = reached(await s.click(card, { budgetMs, until: untilChart }), `openPatient(${uuid}): click result card`); // act:11
  } else {
    r = reached(await s.navigate(`${SPA}/patient/${uuid}/chart`, { budgetMs, until: untilChart }), `openPatient(${uuid}): navigate`);
  }
  await assertChart(s, uuid, budgetMs);
  return chartInfo(s, uuid, (await whereAmI(s)).url, s.store.action(r.action)?.t_start);
}

function chartInfo(s: Session, uuid: string, url: string, since?: number): ChartInfo {
  const p = lastBody<{ name?: Array<{ text?: string }>; gender?: string; birthDate?: string; identifier?: Array<{ value: string }> }>(s, `/ws/fhir2/R4/Patient/${uuid}`, { since });
  return { uuid, name: p?.name?.[0]?.text, gender: p?.gender, birthDate: p?.birthDate, identifiers: p?.identifier?.map((i) => i.value) ?? [], url };
}

// ---------------------------------------------------------------------------------------------------------------
// extractSummary — clinical facts off the FHIR bodies the chart widgets fetched. Navigates a chart tab only when
// the fact it needs was never fetched (allergies live on their own tab; conditions + vitals on the summary).

export interface Summary {
  uuid: string; name?: string;
  conditions: Array<{ name: string; status?: string; onset?: string; recorded?: string }>;
  allergies: Array<{ substance: string; category?: string[]; severity?: string; reactions: string[]; status?: string }>;
  vitals: { date?: string; values: Record<string, { value: number; unit?: string }> ; observations: number };
  sources: Record<string, string>; // fact → endpoint it came from
}

interface Bundle<R = any> { total?: number; entry?: Array<{ resource: R }> }

export async function extractSummary(s: Session, opts: { budgetMs?: number } = {}): Promise<Summary> {
  const budgetMs = opts.budgetMs ?? SLOW;
  const uuid = await assertChart(s, undefined, budgetMs);
  const sources: Record<string, string> = {};
  const need = async <T,>(label: string, urlLike: string, tab: string, landedLike: string): Promise<T | undefined> => {
    let b = lastBody<T>(s, urlLike);
    if (!b) { // never fetched for this patient → open the chart tab that fetches it, postcondition = that request landing
      reached(await s.click(`nav a[href$="/chart/${tab}"], aside a[href$="/chart/${tab}"]`, { budgetMs, until: { urlLike: landedLike, landed: true, budgetMs } }), `extractSummary: open ${tab} tab`);
      b = lastBody<T>(s, urlLike);
    }
    if (b) sources[label] = urlLike;
    return b;
  };
  const conds = await need<Bundle>("conditions", `/ws/fhir2/R4/Condition?patient=${uuid}`, "patient-summary", "/ws/fhir2/R4/Condition?patient=");
  const vitalsB = await need<Bundle>("vitals", `/ws/fhir2/R4/Observation?subject:Patient=${uuid}&code=5085`, "patient-summary", "/ws/fhir2/R4/Observation?subject:Patient=");
  const bioB = lastBody<Bundle>(s, `/ws/fhir2/R4/Observation?subject:Patient=${uuid}&code=5090`); if (bioB) sources.biometrics = "…code=5090,5089,1343,1342";
  const allergB = await need<Bundle>("allergies", `/ws/fhir2/R4/AllergyIntolerance?patient=${uuid}`, "allergies", "/ws/fhir2/R4/AllergyIntolerance?patient=");
  const patient = lastBody<{ name?: Array<{ text?: string }> }>(s, `/ws/fhir2/R4/Patient/${uuid}`);

  const conditions = (conds?.entry ?? []).map(({ resource: r }) => ({
    name: r.code?.text ?? r.code?.coding?.[0]?.display ?? "?", status: r.clinicalStatus?.coding?.[0]?.code, onset: r.onsetDateTime, recorded: r.recordedDate }));
  const allergies = (allergB?.entry ?? []).map(({ resource: r }) => ({
    substance: r.code?.text ?? r.code?.coding?.[0]?.display ?? "?", category: r.category, severity: r.reaction?.[0]?.severity ?? r.criticality,
    reactions: (r.reaction ?? []).flatMap((x: any) => (x.manifestation ?? []).map((m: any) => m.text ?? m.coding?.[0]?.display)).filter(Boolean), status: r.clinicalStatus?.coding?.[0]?.code }));
  // latest vitals set = all numeric observations sharing the most recent effectiveDateTime (bundle is _sort=-date)
  const obs = [...(vitalsB?.entry ?? []), ...(bioB?.entry ?? [])].map((e) => e.resource).filter((r) => r.valueQuantity && r.effectiveDateTime);
  const latest = obs.map((r) => r.effectiveDateTime as string).sort().at(-1);
  const values: Record<string, { value: number; unit?: string }> = {};
  for (const r of obs) if (r.effectiveDateTime === latest) values[r.code?.text ?? r.code?.coding?.[0]?.display ?? r.code?.coding?.[0]?.code] = { value: r.valueQuantity.value, unit: r.valueQuantity.unit };
  return { uuid, name: patient?.name?.[0]?.text, conditions, allergies, vitals: { date: latest, values, observations: obs.length }, sources };
}
