# NOTES — openmrs (dev3.openmrs.org), 2026-09-01

Raw observations in the order they were made, with act ids from run 1. Distilled into README.md / wire.md.

- `act:1` `./disco open openmrs https://dev3.openmrs.org/openmrs/spa/login` — 4.6 s to a committed page.
- `act:2` `./disco until --until-text "Login"` — **20 s burned**, `timeout`. The login screen never
  says "Login"; it says *Username* then *Continue*. Screenshot + `eval document.body.innerText` (0.3 s)
  answered what the 20 s wait could not. Lesson: probe the text before waiting on it.
- Shell off the wire: `GET /openmrs/spa/login` (3.3 K HTML) + `importmap.json` + `routes.registry.json`
  (67 K) + ~20 hashed JS/CSS chunks. This is **single-spa**: the HTML is an empty shell, the app is an
  import map of `@openmrs/esm-*` microfrontends. Reading `routes.registry.json` is the fastest way to
  learn what pages exist.
- `GET /openmrs/ws/rest/v1/session` before login → `{"authenticated":false,...}`. Same URL is the
  login endpoint.
- `act:3-5` login is two screens in one page. `#username` + `button "Continue"` reveals `#password` +
  `button "Log in"`. My `until: {selector:"[role=alert]"}` on Continue came back **alreadyTrue** — an
  empty `role=alert` live region is on the login page from the start. Use `role=button[name='Log in']`.
- `act:7` `click role=button[name='Log in']` → `until { url: "/spa/home" }` held in **242 ms**. One wire
  fact: `GET /openmrs/ws/rest/v1/session` with `Authorization: Basic YWRtaW46QW…`, 200, `set-cookie:
  JSESSIONID=…; Path=/openmrs; HttpOnly`. No POST anywhere. Body carries user, roles
  (System Developer, Provider), `sessionLocation` (Outpatient Clinic), `currentProvider`.
- No location picker for `admin` — `user.userProperties.defaultLocation` is set. O3 shows one otherwise;
  kept as an `any` arm in `login()`. **Unverified.**
- `act:8` `/spa/home` redirects to `/spa/home/service-queues`. Left nav: Service queues, Appointments,
  Patient lists, Wards, Laboratory, Billing. Header: Change location · Search patient · Implementer
  Tools · Add patient · My Account · App Menu.
- `act:9` **FAILED not-found** `button:has-text('Search patient')` — while the diagnosis's own
  `visible controls` list printed `button "Search patient"`. The button has an icon and an
  `aria-label`, no text node. `role=button[name='Search patient']` works (`act:10`). See friction #3.
- `act:10` search panel: `input[placeholder='Search for a patient by name or identifier number']`.
  Its DOM id is React-generated (`search-input-:r1d:`) — never usable.
- `act:11` `type` "John" → one debounced `GET /openmrs/ws/rest/v1/patient?q=John&v=custom:(…)`, 200,
  26 K, 8 results. `until: { request: "/rest/v1/patient?q=John", landed: true }` held at 604 ms.
  Each row is `a[href='/openmrs/spa/patient/<uuid>/chart/']`.
- Before typing, the panel shows "10 recent search results" — from
  `user.userProperties.patientsVisited` (a comma-separated uuid list), each hydrated with its own
  `GET patient/<uuid>` + `visit?patient=` + `obs?patient=` fan-out. ~30 requests of noise per panel open.
- `act:12` clicking a result: `until { url: "/chart" }` held in 210 ms but the page was still the
  header only — the chart microfrontend had not been fetched. **URL is not a chart anchor.**
- `act:13` the real anchor is `[aria-label='patient banner']` (aria `banner "patient banner"`).
- `act:15` cold `navigate(chartUrl)` + banner anchor: ~2.9 s, 220 requests. Wire during it:
  `fhir2/R4/Patient/<uuid>`, `rest/v1/visit?patient=`, `rest/v1/systemsetting/visits.enabled`,
  `rest/v1/obs?patient=&concept=736e8771…` (sticky note), `fhir2/R4/Observation?…code=5085,5086,…`
  (vitals), `fhir2/R4/Condition?patient=…&category=problem-list-item`,
  `rest/v1/order?patient=&careSetting=…&orderTypes=…`, `rest/v1/conceptreferencerange/?…`.
- Chart left nav (12 tabs): patient-summary, vitals-and-biometrics, medications, orders, results,
  visits, allergies, conditions, procedures, immunizations, attachments, programs, appointments,
  billing-history, growth-chart. Right rail: Order basket, Visit note, Task list, Clinical forms,
  Patient lists.
- `act:17` `click nav a[href$='/chart/allergies']` → `h4 "Allergies"` in 436 ms, one request:
  `GET /openmrs/ws/fhir2/R4/AllergyIntolerance?patient=<uuid>…` 200 2.3 K.
- Conditions tab issues **no request at all** — the patient-summary widget already fetched
  `Condition?patient=`, and the app's SWR cache serves the tab. A `{ request }` predicate there
  never fires; the check asserts `body === null || Bundle`.
- `act:18-21` home apps, each with its own wire:
  appointments → `rest/v1/appointmentService/all/default` + `rest/v1/appointments?forDate=…`;
  patient-lists → `rest/v1/cohortm/cohort?v=custom:(…)`;
  laboratory → 7× `rest/v1/order?orderTypes=52a447d3-…` (one per tab);
  ward → `rest/v1/admissionLocation/<loc>` + `rest/v1/emrapi/inpatient/admission` + `…/request`.
  `patient-lists` and `laboratory` have **no `<main>` heading** — my `main h1..h4` anchor expired twice
  at 25 s each (50 s). Their anchors are tabs: `role=tab[name='Starred lists']`,
  `role=tab[name='Tests ordered']`.
- `act:23-24` Logout: the "User menu options" list is always in the DOM *and* always `visible` to
  Playwright — the header only slides it in. `until: {selector: "role=button[name='Logout']"}` on the
  My Account click is `alreadyTrue`. Click My Account bare, then Logout with `#username` as the
  postcondition (~1.5 s).
- `act:25-28` re-login lands on `/spa/home/service-queues` directly, so `{ url: "/spa/home" }` covers
  both landings.
- `act:155` App Menu (header): System Administration, Queue screen, Dispensing, Fast Data Entry —
  each a separately lazy-loaded `openmrs-esm-*-app` chunk fetched on menu open.
- Modules on this server (`rest/v1/module`): fhir2 4.2.0, webservices.rest 3.5.0, queue 3.1.0,
  appointments 2.1.0, bedmanagement 7.2.0, billing 2.4.0, cohort 3.7.3, idgen 5.0.4, attachments 4.0.0,
  o3forms 2.3.0, stockmanagement 3.0.0, emrapi 3.5.0, patientflags 3.0.10, … (31 total).
- Patient lists (cohorts) present: nini (3), Uche Happiness U (0), Adama Hospital Medical College (0),
  Akash Hospital patient (0), GYMNOTT (0).
- Console noise on every page: `Failed to load resource: 404` (the PWA manifest icon
  `$SPA_PATH/icon_144x144…png` — an unsubstituted template variable) and
  `Unknown config key '@openmrs/esm-laboratory-app.labTableColumns'`. Both are constant; ignore.
