// Function library for OpenMRS O3 (Reference Application 3.x) — product instance #4.
// Plain, importable, composable, anchor-oriented, wire-first, defensive functions.
// Built and validated against the public demo build at dev3.openmrs.org (o3.openmrs.org is Cloudflare-gated
// against headless browsers — see nav-and-quirks.md §0).
//
//   import { connect } from "../../src/client.ts";
//   import * as o3 from "./lib.ts";
//   const s = await connect("openmrs");
//   await o3.login(s);                                   // idempotent; handles the location picker either way
//   const p = await o3.findPatient(s, "Michelle Lewis");  // read off the REST search body, paging past page 1
//   await o3.openPatient(s, p);                           // -> chart anchor
//   const sum = await o3.extractSummary(s, p.uuid);       // FHIR Condition/AllergyIntolerance/Observation + REST order
//   const visits = await o3.listVisits(s, p.uuid);        // visits[0] = latest (date + type), off the wire
//
// ===========================================================================================
// WRITE FOOTPRINT — declared honestly, per GUIDANCE §9:
//   * No function here submits a form. No orders, notes, allergies, demographics, visits or queue
//     changes are created, edited or deleted. Every request these functions ISSUE is a GET.
//   * `openPatient` nevertheless causes ONE server write, made by the app itself and unavoidable
//     through the UI: `POST /ws/rest/v1/user/<user-uuid>?v=custom:(userProperties)`, which appends the
//     patient to the logged-in user's `patientsVisited` MRU (and echoes back defaultLocale /
//     defaultLocation / starredPatientLists / order_favorites_drugs unchanged). It writes **user
//     preference state, never patient data** (observed act:38, act:43; `write_kind=write`).
//     Read-only orchestration should know this before it runs `openPatient`.
//   * `logout` DELETEs the server session. It destroys no data, is called by nothing else here, and
//     never by `check.ts`.
// ===========================================================================================
import type { Session } from "../../src/client.ts";
import { reached, until, assertVisible, actIfPresent } from "../../lib/nav.ts";
import { extractFromWire, wireHas } from "../../lib/wire.ts";

export const HOST = "https://dev3.openmrs.org";
export const SPA = `${HOST}/openmrs/spa`;
export const CREDENTIALS = { admin: "Admin123" };

/** The patient-search overlay's input. NOT `input[type=search]`: the service-queues home dashboard
 *  renders a SECOND search box (the queue table's "Search this list" filter) and a bare `input[type=search]`
 *  resolves to it — the first check run typed the patient name into the queue filter and waited 12s for a
 *  search that was never going to fire (run 2, act:33 diagnosis: focus was `#table-toolbar-search-:rr:`).
 *  Both stable handles are used: the CSS-module form wrapper, then the placeholder. The React `id`s are
 *  `useId` output (`search-input-:r1j:`) and change every render — never select on them. */
/** The app's own refusal banner (Carbon). Observed text: "Error — Invalid username or password". */
export const ERROR_NOTIFICATION = ".cds--inline-notification--error, .cds--actionable-notification--error";

export const SEARCH_INPUT = 'css=form[class*="patient-search-bar"] input[type=search], input[placeholder^="Search for a patient"]';

/** The chart's left-nav sections. Route slugs are LOWERCASE and hyphenated; the link *labels* are not
 *  (`role=link[name="Vitals & Biometrics"]` -> `/chart/vitals-and-biometrics`). A postcondition that
 *  tests the pathname must use the slug (act:25 failed on `/Allergies` and the diagnosis named the truth). */
export const SECTIONS = {
  summary: "patient-summary", vitals: "vitals-and-biometrics", medications: "medications", orders: "orders",
  results: "results", visits: "visits", allergies: "allergies", conditions: "conditions",
  programs: "programs", appointments: "appointments", attachments: "attachments",
} as const;
export type Section = keyof typeof SECTIONS;

// ---------------------------------------------------------------------------------------------
// Per-app rules (persist in the store; re-registered on every login so a fresh run starts right)
// ---------------------------------------------------------------------------------------------

/** Register this product's attribution rules + sentinel mutes. Idempotent (rules dedupe per app).
 *  Evidence for each is in nav-and-quirks.md §2 — every one was measured, none guessed. */
export async function registerRules(s: Session): Promise<void> {
  // The service-queues home dashboard re-fetches on a 60.0s timer (measured gaps 60051 / 60001 / 60003 ms
  // across three families, no action window open). 150s of `disco idle` sees only TWO cycles, and the
  // ambient rule needs >=3 samples — so the classifier cannot learn a 60s heartbeat in a sane warm-up.
  await s.ignore("queue-entry");   // /ws/rest/v1/queue-entry + queue-entry-metrics (dashboard only)
  await s.ignore("_tag=queue");    // /ws/fhir2/R4/Location?_summary=data&_tag=queue%20location
  // NOT ignored, deliberately: /ws/rest/v1/obs?...&concept=736e8771-... . It looks like part of the same
  // poll, but the patient-search results list fires the SAME url per row (act:16) — an ambient rule there
  // mis-attributes an action's own traffic. Left attributed; documented instead.
  // Sentinel noise: the app shell renders a Carbon "loading" toast on every lazy-loaded micro-frontend,
  // and every full page load 404s on a template-literal that was never substituted.
  await s.mute("toast", { text: "loading" });
  await s.mute("toast", { text: "Loading" });
  await s.mute("error", { url: "$SPA_PATH" });
}

// ---------------------------------------------------------------------------------------------
// Anchors (GUIDANCE §7.3): cheap predicates that name where we are
// ---------------------------------------------------------------------------------------------

/** Anchor: the login page (username field present). */
export async function assertLoginPage(s: Session, budgetMs = 15000): Promise<void> {
  await until(s, { selector: "#username", visible: true }, { budgetMs, msg: "assertLoginPage: not on the O3 login page" });
}

/** Anchor: the authenticated app shell — a `/spa/` route that is not `/login`, with the primary-nav
 *  header rendered. The header landmark is a DISJUNCTION on purpose: opening the patient-search overlay
 *  REPLACES the magnifier with a "Close Search Panel" button, so a single-selector anchor would report
 *  "shell not reached" while standing in the shell with the search panel open (check run 2 failed exactly
 *  there). Any one of the three proves the primary navigation is mounted. */
export async function assertShell(s: Session, budgetMs = 20000): Promise<void> {
  // ONE in-page predicate, not `all: [fn, { any: [...] }]` — a nested `any` inside `all` never matches in
  // this build of disco (measured: flat `any` true in 5ms, the same arm nested inside `all` false for the
  // whole budget; friction.md #3). Flat combinators only.
  await until(s, { fn: () => location.pathname.includes("/spa/") && !location.pathname.includes("/login")
    && !!document.querySelector('[data-testid="searchPatientIcon"], form[class*="patient-search-bar"] input[type=search], button[aria-label="App Menu"]') },
    { budgetMs, msg: "assertShell: app shell not reached (still on login? session expired?)" });
}

/** Anchor: a patient chart is open (optionally a specific patient uuid). */
export async function assertChart(s: Session, uuid?: string, budgetMs = 25000): Promise<void> {
  await until(s, { all: [
    { fn: (u?: string) => location.pathname.includes("/patient/") && location.pathname.includes("/chart") && (!u || location.pathname.includes(u)), fnArg: uuid },
    { selector: 'role=link[name="Patient summary"]' },
  ] }, { budgetMs, msg: `assertChart: patient chart not reached${uuid ? ` for ${uuid}` : ""}` });
}

// ---------------------------------------------------------------------------------------------
// login / logout
// ---------------------------------------------------------------------------------------------

/** Log in and reach the shell anchor. Idempotent: returns immediately when already authenticated.
 *  Handles O3's TWO-STEP login form (username -> Continue -> password -> Log in) and the location
 *  picker, which is present for some users/locations and absent for others — both paths are first class.
 *  Detects the app's own refusal notification instead of timing out on it.
 *  WRITES: none (the login handshake is `GET /ws/rest/v1/session` with a Basic header). */
export async function login(s: Session, opts: { user?: string; pass?: string } = {}): Promise<void> {
  await registerRules(s);
  const user = opts.user ?? "admin";
  const pass = opts.pass ?? CREDENTIALS[user as keyof typeof CREDENTIALS] ?? "Admin123";
  const authed = await s.evaluate<boolean>(() => location.pathname.includes("/spa/") && !location.pathname.includes("/login")).catch(() => false);
  if (authed) { await assertShell(s); return; }

  if (!(await s.evaluate<boolean>(() => !!document.querySelector("#username")).catch(() => false)))
    reached(await s.navigate(`${SPA}/login`, { budgetMs: 30000, until: { selector: "#username", visible: true, budgetMs: 25000 } }), "login: open login page");
  await assertLoginPage(s);

  // Step 1 — username. The password field EXISTS in the DOM from the start but is not rendered until
  // Continue; the postcondition is therefore `visible`, not merely present.
  await s.fill("#username", user);
  reached(await s.click('css=button[type="submit"]', { budgetMs: 15000, until: { selector: "#password", visible: true, budgetMs: 10000 } }), "login: Continue (username step)");

  // A refusal banner from a PREVIOUS attempt survives on the page — leave it there and the next login
  // matches the "refused" arm instantly and throws about a failure that already happened (observed: a
  // good login right after a bad one threw `login refused: (no text)`). Clear it first, both ways.
  await actIfPresent(s, `css=${ERROR_NOTIFICATION} button[aria-label*="close" i]`, { budgetMs: 400 });

  // Step 2 — password. Ends in ONE of three states: the location picker, the app shell, or a refusal
  // notification. Wait for the disjunction (never for one arm), then ask which one holds.
  await s.fill("#password", pass);
  const r = reached(await s.click('css=button[type="submit"]', { budgetMs: 30000, until: { any: [
    { name: "picker", fn: () => location.pathname.includes("/login/location") },
    { name: "shell", fn: () => location.pathname.includes("/spa/") && !location.pathname.includes("/login") },
    { name: "refused", selector: `css=${ERROR_NOTIFICATION}` },
  ], budgetMs: 25000 } }), "login: submit password");

  if (r.until?.which === "refused") {
    // read it while it is still on screen; the banner is transient
    const msg = await s.evaluate<string>((sel: string) => (document.querySelector(sel)?.textContent ?? "").replace(/^error icon/i, "").trim() || "(no text)",
      { args: [ERROR_NOTIFICATION] }).catch(() => "(unreadable)");
    throw new Error(`login refused by the app: ${msg || r.until.preview || "(no text)"}`);
  }

  // The location picker is conditional (absent for `admin` on this demo — its user already has a
  // sessionLocation). Present OR absent, both fine: pick the first location and confirm if it is there.
  if (await actIfPresent(s, 'css=input[type="radio"], .cds--radio-button__label', { budgetMs: 1500 }))
    await actIfPresent(s, 'role=button[name="Confirm"]', { budgetMs: 1500 });
  await actIfPresent(s, 'role=button[name="Confirm"]', { budgetMs: 800 });

  await assertShell(s);
}

/** End the server session and return to the login page. WRITES: `DELETE /ws/rest/v1/session` (session
 *  state only — no patient data). Not called by check.ts. */
export async function logout(s: Session): Promise<void> {
  await s.click('role=button[name="My Account"]', { budgetMs: 8000 }).catch(() => {});
  reached(await s.click('role=button[name="Logout"]', { budgetMs: 20000, until: { selector: "#username", visible: true, budgetMs: 15000 } }), "logout");
}

// ---------------------------------------------------------------------------------------------
// patient search — the facts come off the REST search body, never the rendered rows
// ---------------------------------------------------------------------------------------------

export interface Patient { uuid: string; name: string; identifier: string; gender: string; age: number; birthdate: string }

const asPatient = (r: any): Patient => ({
  uuid: r.uuid,
  name: r.person?.personName?.display ?? String(r.display ?? "").replace(/^\S+\s+-\s+/, ""),
  identifier: r.patientIdentifier?.identifier ?? r.identifiers?.[0]?.identifier ?? "",
  gender: r.person?.gender ?? "", age: r.person?.age ?? NaN, birthdate: (r.person?.birthdate ?? "").slice(0, 10),
});

/** Every patient the app has fetched for a given search term, merged across ALL pages captured on the
 *  wire (the overlay asks for limit=10; the results page asks for limit=50 and then keeps paging as you
 *  scroll — so one term can have several bodies). Deduped by uuid; `totalCount` is the server's total. */
export function searchResults(s: Session, term: string): { patients: Patient[]; totalCount: number } {
  const rows = s.store.requests({ urlLike: "%/ws/rest/v1/patient?q=%" }).filter((r) => r.body_hash);
  const mine = rows.filter((r) => {
    const q = new URL(r.url).searchParams.get("q");
    return q != null && q.toLowerCase() === term.toLowerCase();
  });
  const byUuid = new Map<string, Patient>(); let total = 0;
  for (const r of mine) {
    const j = s.store.json(r.body_hash!) as { results?: any[]; totalCount?: number };
    total = Math.max(total, j.totalCount ?? 0);
    for (const p of j.results ?? []) if (p?.uuid && !byUuid.has(p.uuid)) byUuid.set(p.uuid, asPatient(p));
  }
  return { patients: [...byUuid.values()], totalCount: total };
}

/** Open the header patient-search overlay (idempotent — does nothing if the box is already there). */
export async function openSearch(s: Session): Promise<void> {
  if ((await s.watch({ selector: SEARCH_INPUT, visible: true }, { budgetMs: 0 })).matched) return;   // already open
  await assertShell(s);
  reached(await s.click('css=[data-testid="searchPatientIcon"]', { budgetMs: 15000,
    until: { selector: SEARCH_INPUT, visible: true, budgetMs: 10000 } }), "openSearch");
}

/** Find a patient by name (or identifier) and return the record **read off the search API's response**.
 *  Works past page 1: the overlay's body is limit=10, so when the wanted patient is not in it and the
 *  server says there are more, this escalates to the full results page (limit=50 + scroll paging) and
 *  re-reads. Leaves that patient's link on screen so `openPatient` can click it.
 *  WRITES: none. */
export async function findPatient(s: Session, name: string, opts: { pages?: number } = {}): Promise<Patient> {
  await openSearch(s);
  const hit = (ps: Patient[]) => ps.find((p) => p.name.toLowerCase().includes(name.toLowerCase()) || p.identifier.toLowerCase() === name.toLowerCase());

  // 1. the overlay's debounced search (fill replaces any residual term); the postcondition is the search
  //    response LANDING — never the rendered rows, which lag it and are virtualized.
  reached(await s.fill(SEARCH_INPUT, name, { budgetMs: 15000,
    until: { urlLike: "/ws/rest/v1/patient?q=", landed: true, budgetMs: 12000 } }), `findPatient(${name}): overlay search`);
  let { patients, totalCount } = searchResults(s, name);
  let found = hit(patients);

  // 2. past page 1: Enter opens /spa/search?query=… which re-asks with limit=50 and renders everything.
  if (!found && totalCount > patients.length) {
    reached(await s.press("Enter", { budgetMs: 25000,
      until: { all: [{ fn: () => location.pathname.includes("/spa/search") }, { urlLike: "limit=50", landed: true }], budgetMs: 20000 } }),
      `findPatient(${name}): full results page`);
    ({ patients, totalCount } = searchResults(s, name));
    found = hit(patients);
    // 3. still more on the server than we have? the results list pages in on scroll.
    for (let i = 0; !found && patients.length < totalCount && i < (opts.pages ?? 3); i++) {
      await s.scroll({ deltaY: 20000 }, { budgetMs: 12000, until: { urlLike: "/ws/rest/v1/patient?q=", landed: true, budgetMs: 8000 } }).catch(() => {});
      ({ patients, totalCount } = searchResults(s, name));
      found = hit(patients);
    }
  }
  if (!found) throw new Error(`findPatient: no patient matching ${JSON.stringify(name)} in ${patients.length} wire-read result(s) of ${totalCount} the server reports`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// chart
// ---------------------------------------------------------------------------------------------

/** Open a patient's chart and reach the chart anchor. Takes a `Patient`, a uuid, or a name (which is
 *  searched first). Clicking the search hit is the real user path; a bare uuid with no link on screen
 *  falls back to the chart route (a read-only GET navigation). Every interstitial is optional both ways.
 *  WRITES: none of its own — but the app answers a chart open with `POST /ws/rest/v1/user/<uuid>`
 *  (`userProperties.patientsVisited`, the recently-viewed MRU). User preference state, no patient data;
 *  unavoidable through the UI. See the header. */
export async function openPatient(s: Session, target: Patient | string): Promise<Patient> {
  const p: Patient = typeof target === "string"
    ? (/^[0-9a-f-]{36}$/i.test(target) ? { uuid: target, name: "", identifier: "", gender: "", age: NaN, birthdate: "" } : await findPatient(s, target))
    : target;

  const linkSel = `css=a[href*="${p.uuid}"]`;
  const post = { all: [
    { fn: (u: string) => location.pathname.includes(`/patient/${u}/chart`), fnArg: p.uuid },
    { selector: 'role=link[name="Patient summary"]' },
  ], budgetMs: 25000 };

  if ((await s.watch({ selector: linkSel, visible: true }, { budgetMs: 0 })).matched)
    reached(await s.click(linkSel, { budgetMs: 30000, until: post }), `openPatient(${p.name || p.uuid}): search hit`);
  else
    reached(await s.navigate(`${SPA}/patient/${p.uuid}/chart/${SECTIONS.summary}`, { budgetMs: 40000, until: post }), `openPatient(${p.uuid}): chart route`);

  // Conditional interstitials on chart open. None was ever observed on this build (n=0/4 patients), but
  // all are treated as optional by construction: a modal would occlude the next click and the diagnosis
  // would name it. Cheap, bounded, and correct when absent.
  await actIfPresent(s, 'role=button[name="Close"] >> nth=0', { budgetMs: 300 }).catch(() => {});
  await assertChart(s, p.uuid);
  return p;
}

/** Navigate to one of the chart's left-nav sections and wait for its data to land. Idempotent.
 *  `wireLike` is the section's own request; when it is already captured for this patient the wait is
 *  skipped (SWR may serve from cache and never re-ask). WRITES: none. */
export async function openSection(s: Session, uuid: string, section: Section, wireLike?: string): Promise<void> {
  const slug = SECTIONS[section];
  if (await s.evaluate<boolean>((sl: string) => location.pathname.endsWith(`/${sl}`), { args: [slug] }).catch(() => false)) {
    if (!wireLike || wireHas(s.store, wireLike)) return;
  }
  const label = { summary: "Patient summary", vitals: "Vitals & Biometrics", medications: "Medications", orders: "Orders",
    results: "Results", visits: "Visits", allergies: "Allergies", conditions: "Conditions", programs: "Programs",
    appointments: "Appointments", attachments: "Attachments" }[section];
  const post = { all: [
    { fn: (sl: string) => location.pathname.endsWith(`/${sl}`), fnArg: slug },
    ...(wireLike && !wireHas(s.store, wireLike) ? [{ urlLike: wireLike, landed: true }] : []),
  ], budgetMs: 20000 };
  reached(await s.click(`role=link[name="${label}"]`, { budgetMs: 25000, until: post }), `openSection(${section})`);
}

export interface Vital { name: string; value: number | string; unit: string; when: string }
export interface Medication { name: string; dose: string; frequency: string; route: string; orderNumber: string; action: string; dateActivated: string; active: boolean }
export interface ChartSummary { uuid: string; problems: string[]; allergies: string[]; medications: Medication[]; vitals: Vital[]; source: Record<string, string> }

const bundleEntries = (j: any): any[] => (j?.entry ?? []).map((e: any) => e.resource).filter(Boolean);

/** Problems, allergies, medications and the latest vitals for the open chart — **all read off the wire**
 *  (FHIR `Condition`, FHIR `AllergyIntolerance`, FHIR `Observation`, REST `order`), never scraped.
 *  The patient-summary dashboard fetches conditions / vitals / medications; allergies live on their own
 *  section, so this visits it when that bundle has not been captured for this patient yet.
 *  `source` says which endpoint each fact came from. WRITES: none. */
export async function extractSummary(s: Session, uuid?: string): Promise<ChartSummary> {
  const id = uuid ?? await s.evaluate<string>(() => location.pathname.split("/patient/")[1]?.split("/")[0] ?? "");
  await assertChart(s, id);

  if (!wireHas(s.store, `Condition?patient=${id}`)) await openSection(s, id, "summary", `Condition?patient=${id}`);
  if (!wireHas(s.store, `AllergyIntolerance?patient=${id}`)) await openSection(s, id, "allergies", `AllergyIntolerance?patient=${id}`);

  const cond = extractFromWire<any>(s.store, { urlLike: `Condition?patient=${id}`, optional: true });
  const alg = extractFromWire<any>(s.store, { urlLike: `AllergyIntolerance?patient=${id}`, optional: true });
  const ord = extractFromWire<any>(s.store, { urlLike: `rest/v1/order?patient=${id}`, optional: true });

  const problems = bundleEntries(cond)
    .filter((c) => (c.clinicalStatus?.coding?.[0]?.code ?? "active") === "active")
    .map((c) => c.code?.text ?? c.code?.coding?.[0]?.display).filter(Boolean);
  const allergies = bundleEntries(alg)
    .map((a) => a.code?.text ?? a.code?.coding?.[0]?.display ?? a.reaction?.[0]?.substance?.text).filter(Boolean);
  const medications: Medication[] = ((ord?.results ?? []) as any[]).map((o) => ({
    name: o.drug?.display ?? o.concept?.display ?? o.display ?? o.orderNumber,
    dose: [o.dose, o.doseUnits?.display].filter(Boolean).join(" "),
    frequency: o.frequency?.display ?? "", route: o.route?.display ?? "",
    orderNumber: o.orderNumber ?? "", action: o.action ?? "", dateActivated: (o.dateActivated ?? "").slice(0, 10),
    active: !o.dateStopped && (!o.autoExpireDate || new Date(o.autoExpireDate) > new Date()),
  }));

  return { uuid: id, problems, allergies, medications, vitals: latestVitals(s, id),
    source: { problems: "GET /ws/fhir2/R4/Condition?patient=…&category=…problem-list-item", allergies: "GET /ws/fhir2/R4/AllergyIntolerance?patient=…",
      medications: "GET /ws/rest/v1/order?patient=…&careSetting=…&orderTypes=…", vitals: "GET /ws/fhir2/R4/Observation?subject:Patient=…&code=…&_sort=-date" } };
}

/** The most recent value of each vital/biometric the chart fetched, off the FHIR `Observation` bundles
 *  (they are already sorted `-date`, but this reduces by timestamp so order is not assumed). */
export function latestVitals(s: Session, uuid: string): Vital[] {
  const rows = s.store.requests({ urlLike: `%fhir2/R4/Observation%` }).filter((r) => r.body_hash && r.url.includes(uuid));
  const best = new Map<string, Vital>();
  for (const r of rows) for (const o of bundleEntries(s.store.json(r.body_hash!))) {
    const name = o.code?.coding?.[0]?.display ?? o.code?.text; const when = o.effectiveDateTime ?? "";
    if (!name || o.valueQuantity?.value == null) continue;
    const prev = best.get(name);
    if (!prev || when > prev.when) best.set(name, { name, value: o.valueQuantity.value, unit: o.valueQuantity.unit ?? "", when });
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface Visit { uuid: string; type: string; start: string; stop: string | null; encounters: number }

/** The patient's visits, newest first, **read off the wire** (`GET /ws/rest/v1/visit?patient=…`).
 *  `visits[0]` is the latest — its `.start` and `.type` are the "latest visit date and type".
 *  Note the app asks for this twice with different projections: the banner's call returns only the ACTIVE
 *  visit, the Visits section's call returns the history — so the richest captured body wins.
 *  WRITES: none. */
export async function listVisits(s: Session, uuid?: string): Promise<Visit[]> {
  const id = uuid ?? await s.evaluate<string>(() => location.pathname.split("/patient/")[1]?.split("/")[0] ?? "");
  await assertChart(s, id);
  await openSection(s, id, "visits");
  await until(s, { selector: "css=table" }, { budgetMs: 15000, msg: "listVisits: the visits table never rendered" });

  // Several bodies match; the Visits section's (largest) is the history. (Its URL really does contain a
  // double slash — `/openmrs//ws/rest/v1/visit` — an O3 url-building quirk, so match loosely.)
  const rows = s.store.requests({ urlLike: `%/ws/rest/v1/visit?patient=${id}%` }).filter((r) => r.body_hash);
  let best: any[] = [];
  for (const r of rows) { const j = s.store.json(r.body_hash!); if ((j?.results?.length ?? 0) >= best.length) best = j.results ?? []; }
  return best.map((v: any) => ({
    uuid: v.uuid, type: v.visitType?.display ?? v.visitType?.name ?? "", start: v.startDatetime,
    stop: v.stopDatetime ?? null, encounters: (v.encounters ?? []).length,
  })).sort((a: Visit, b: Visit) => (a.start < b.start ? 1 : -1));
}

/** Back to a known anchor from anywhere (a stray modal, a half-loaded section, a dead route):
 *  navigate to the shell's home route and re-assert. If the session died, this lands on /login and
 *  throws from assertShell — which is the honest answer, not a hang. WRITES: none. */
export async function recoverToShell(s: Session): Promise<void> {
  reached(await s.navigate(`${SPA}/home`, { budgetMs: 40000,
    until: { any: [{ name: "shell", selector: 'css=[data-testid="searchPatientIcon"]', visible: true },
                   { name: "login", selector: "#username", visible: true }], budgetMs: 30000 } }), "recoverToShell");
  await assertShell(s);
}
