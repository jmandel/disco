# openmrs — `https://dev3.openmrs.org/openmrs/spa`

Characterised 2026-09-01 against the public **dev3** demo instance (synthetic data), driven
**read-only** with disco. Credentials `admin` / `Admin123`. `lib.ts` wraps only reads;
`node scripts/run-check.ts openmrs` proves them (9 steps, ~20 s, green cold and warm).

## 1. What it is

**OpenMRS 3.x ("O3") — an open-source electronic medical record system for clinics and hospitals.**
It is a *single-spa* microfrontend SPA: `GET /openmrs/spa/<anything>` returns the same 3.3 KB shell
HTML, which reads `importmap.json` and `routes.registry.json` and then lazily fetches one
`@openmrs/esm-*-app` JS chunk per feature (login, primary navigation, patient chart, service queues,
appointments, laboratory, ward, billing, dispensing…). Nothing is server-rendered, there are no
iframes, and there is no WebSocket — **every fact on screen arrives as JSON over `fetch`**, so the
log is a complete transcript of what the user could know.

Two APIs, same origin, same cookie: **OpenMRS REST** at `/openmrs/ws/rest/v1/` for metadata and
workflow (session, patient search, visits, orders, queues, appointments, cohorts, wards) and
**FHIR R4** at `/openmrs/ws/fhir2/R4/` for the clinical record the chart renders (Patient,
Observation, Condition, AllergyIntolerance, Immunization, Location). Auth is a `JSESSIONID` cookie
obtained by a single Basic-auth `GET .../session`; there is no token and no CSRF header on reads,
so `s.evaluate("fetch('/openmrs/ws/…')")` is a first-class way to read anything (`lib.ts:api()`).
Facts belong to the wire here — the tables on screen are a rendering of a body you already have.

The app's two halves: a **home** side (`/spa/home/<app>`) for the clinic's day — who is waiting,
who is booked, which labs are outstanding, which beds are full — and a **patient chart**
(`/spa/patient/<uuid>/chart/<tab>`) for one person's record. You get from one to the other through
the header patient search.

## 2. Glossary — the app's nouns

| Noun | On screen | On the wire |
|---|---|---|
| **Patient** | search row, patient banner | `rest/v1/patient?q=` (`results[].uuid`), `fhir2/R4/Patient/<uuid>` |
| **Identifier** | "CR Number: 100008E" in the banner | `patientIdentifier.identifier`; types from `patientidentifiertype` ("OpenMRS ID", "CR Number") |
| **Visit** | the "Active Visit" pill; the Visits tab | `rest/v1/visit?patient=` — has a type, a location, `startDatetime`/`stopDatetime`, and encounters |
| **Encounter** | a row inside a visit | `visit.encounters[]` |
| **Obs (observation)** | every vital, biometric and form answer | `fhir2/R4/Observation` (chart) or `rest/v1/obs` (widgets) |
| **Concept** | the *name* of an obs — "Systolic blood pressure" | CIEL uuids (`5085AAAA…` = SBP, `5086`=DBP, `5087`=pulse, `5088`=temp, `5089`=weight, `5090`=height) |
| **Condition** | the Conditions table ("Heart disease · Active") | `fhir2/R4/Condition…category=problem-list-item`, `code.text`, `clinicalStatus` |
| **Allergy** | Allergies table | `fhir2/R4/AllergyIntolerance`, `code.text` / `reaction[0].severity` / `manifestation[]` |
| **Order** | Medications, Orders, and the whole Laboratory app | `rest/v1/order?patient=&orderTypes=` (lab order type `52a447d3-…`) |
| **Queue / queue entry** | Service queues "Waiting list" | `rest/v1/queue-entry` |
| **Appointment** | Appointments app and the chart's Appointments tab | `rest/v1/appointments?forDate=` |
| **Patient list** | Patient lists app | `rest/v1/cohortm/cohort` — a patient list **is** a cohort |
| **Location** | header "Change location"; `sessionLocation` | `fhir2/R4/Location?_tag=queue location`; the session's is "Outpatient Clinic" |
| **Provider** | who you are acting as | `session.currentProvider` ("admin - Super User") |

## 3. Anchors

Each screen's cheapest true assertion. **Never anchor a chart on its URL** — client-side routing
changes the URL hundreds of milliseconds before the microfrontend is even fetched (`act:12`).

| Screen | URL contains | Element |
|---|---|---|
| Login (step 1) | `/spa/login` | `#username` |
| Login (step 2) | `/spa/login` | `role=button[name='Log in']` |
| App shell (any home app) | `/spa/home` | `nav a[href$='/home/appointments']` |
| Service queues | `/home/service-queues` | `h2:has-text('Waiting list')` |
| Appointments | `/home/appointments` | `h2:has-text('Appointments for')` |
| Patient lists | `/home/patient-lists` | `role=tab[name='Starred lists']` |
| Laboratory | `/home/laboratory` | `role=tab[name='Tests ordered']` |
| Wards | `/home/ward` | `main h2` |
| Patient search panel | — | `input[placeholder='Search for a patient by name or identifier number']` |
| Patient chart (any tab) | `/chart` | `[aria-label='patient banner']` |
| Chart: Allergies | `/chart/allergies` | `h4:text-is('Allergies')` |
| Chart: Conditions / summary | `/chart/conditions` | `h4:text-is('Conditions')` |

`lib.ts` exports these as `anchors`, `homeApps`, `chartTabs`.

## 4. Workflows

### 4.1 Log in — `login(s, "admin", "Admin123")` — `act:3-7`

Two screens in **one** page, no navigation between them.

```ts
await s.fill("#username", user);
await s.click("role=button[name='Continue']", { until: { selector: "role=button[name='Log in']" } });
await s.fill("#password", pass);
await s.click("role=button[name='Log in']", { until: { any: [
  { url: "/spa/home",      label: "home" },       // ← this instance
  { url: "/login/location", label: "location" },   // when the user has no default location
  { selector: "[role=alert]:has-text('Invalid')", label: "bad" },
] } });
```

Postcondition ~250 ms warm, ~4 s cold. The whole login is **one request**:
`GET /openmrs/ws/rest/v1/session` with `Authorization: Basic …` → 200 +
`set-cookie: JSESSIONID=…; Path=/openmrs; HttpOnly`. There is no POST. `/spa/home` immediately
redirects to `/spa/home/service-queues`.

*What varies:* a user without `userProperties.defaultLocation` gets a location picker at
`/spa/login/location` first. `admin` on dev3 has one, so that arm is **unverified** (see §8).

### 4.2 Find a patient — `searchPatients(s, "John")` — `act:10-11`

```ts
await s.click("role=button[name='Search patient']", { until: { selector: SEARCH_BOX } });
await s.fill(SEARCH_BOX, "");                                   // start clean
await s.type(SEARCH_BOX, q, {                                   // keystrokes: the box is debounced
  until: { request: `/rest/v1/patient?q=${encodeURIComponent(q)}`, landed: true } });
const hits = s.store.latestJson(`/rest/v1/patient?q=…`, r.action).results;
```

One `GET /openmrs/ws/rest/v1/patient?q=<q>&v=custom:(…)` fires after the last keystroke (~600 ms to
landed). **Read the hits off that body, not off the rows** — the rows are a lossy rendering
(`"Male 4 yrs, 11 mths · 25-Sept-2021 · CR Number: 100008E"` glued into one aria line). Each hit's
`uuid` is the chart key; each row is `a[href='/openmrs/spa/patient/<uuid>/chart/']`.

Search matches names *and* identifiers, so `searchPatients(s, "100008E")` is the exact-lookup form.

### 4.3 Open a chart — `openChart(s, uuid)` — `act:15`

```ts
await s.navigate(`${SPA}/patient/${uuid}/chart/`, { until: { selector: "[aria-label='patient banner']" }, timeout: 30000 });
const p = s.store.latestJson(`/fhir2/R4/Patient/${uuid}`, r.action);   // id, name, gender, birthDate, identifier[]
```

~2.9 s and ~220 requests cold. The banner then carries name · gender · age · birthdate · identifier ·
an "Active Visit" pill when a visit is open, plus a vitals strip (BP, HR, R. rate, SpO2, temp,
weight, height, BMI) that is `Observation` + `conceptreferencerange` under the hood.

Clicking a search result works too (`act:12`) but only if you anchor on the banner: the
`{ url: "/chart" }` predicate held in 210 ms with nothing but the header on screen.

### 4.4 Move around the chart — `openChartTab(s, uuid, "allergies")` — `act:17`

```ts
await s.click(`nav a[href$='/chart/allergies']`, { until: { selector: "h4:text-is('Allergies')" } });
// 436 ms, one request: GET /openmrs/ws/fhir2/R4/AllergyIntolerance?patient=<uuid> → Bundle
```

Tabs: `patient-summary · vitals-and-biometrics · medications · orders · results · visits · allergies ·
conditions · procedures · immunizations · attachments · programs · appointments · billing-history ·
growth-chart`. The right rail (Order basket, Visit note, Task list, Clinical forms) is **write** —
not wrapped.

### 4.5 Read without the UI — `allergies() · conditions() · visits() · appointmentsForDate() · patientLists()`

```ts
await s.evaluate("fetch('/openmrs/ws/fhir2/R4/AllergyIntolerance?patient=<uuid>').then(r=>r.json())")
```

Runs with the page's cookie **and** lands in the log. This is the fastest way to answer a question
about a patient the chart would take 3 s to render, and it is what the check uses to cross-check the
screen against the record.

### 4.6 The clinic's day — `openHomeApp(s, app)` — `act:18-21`

| App | What it is for | Anchor | Wire |
|---|---|---|---|
| Service queues | who is waiting, their priority/status/wait time; "Queue screen" is a waiting-room display | `h2:has-text('Waiting list')` | `queue-entry`, `queue-entry-metrics` |
| Appointments | today's booked appointments, by service; calendar view | `h2:has-text('Appointments for')` | `appointments?forDate=`, `appointmentService/all/default` |
| Patient lists | saved cohorts (starred / system / mine / all) | `role=tab[name='Starred lists']` | `cohortm/cohort` |
| Wards | bed occupancy and admission/transfer requests for the session location | `main h2` | `admissionLocation/<loc>`, `emrapi/inpatient/admission`, `…/request` |
| Laboratory | lab orders by state: Tests ordered / In progress / Completed / Declined | `role=tab[name='Tests ordered']` | 7× `order?orderTypes=52a447d3-…` |
| Billing | patient billing | `main` | billing module |

From the shell, `openHomeApp` clicks the nav link (client-side, fast). From a chart the home nav does
not exist — pass `{ via: "url" }`, which reloads (~3 s).

Header **App Menu** adds four more: System Administration, Queue screen, Dispensing, Fast Data Entry
(`act:155`) — each a separate chunk fetched when the menu opens.

### 4.7 Log out — `logout(s)` — `act:23-24`

`DELETE /openmrs/ws/rest/v1/session` → 204, back to `/spa/login`. See §6 for why the account menu
needs a bare act.

## 5. Interstitials and recovery

- **None appeared anywhere in this tour** (login, search, 6 home apps, a chart and 3 of its tabs, logout). No modal, no "what's new", no session-expiry dialog, no
  native dialog. The only conditional screen is the login **location picker** (§4.1), handled as an
  `any` arm.
- **Expiry** arrives as data, not as a dialog: the shell keeps rendering and API calls return 401 /
  `authenticated:false`. Every anchor in `lib.ts` that can bounce (`goHome`, `login`) carries the
  login screen as an `any` arm, so a dead session costs a redirect instead of a 25 s budget.
- **Recovery from anywhere:** `goHome(s)` → `navigate("/openmrs/spa/home")` with
  `any: [shell, login]`. From the chart that is the only way back to the home nav.
- **Toasts**: transient `[role=status]` notifications appear after actions; none is needed for a read.

## 6. Input recipes

- **Header patient search** — `type`, never `fill`. `fill` fires one input event and the debounce
  still coalesces, but keystrokes are what the widget is built for; always `fill(box, "")` first, or
  the second search reads `JohnMary`. Postcondition is the **request**, not the rows:
  `{ request: "/rest/v1/patient?q=<encoded q>", landed: true }`.
- **The account / logout menu** — the "User menu options" list is always in the DOM *and* always
  `visible` to Playwright (the header only slides it into view). So
  `click("role=button[name='My Account']", { until: { selector: "role=button[name='Logout']" } })`
  is **`alreadyTrue`** and `reached()` throws. Click My Account **bare** (`{ window: 200 }`), then
  click Logout with `#username` as the postcondition.
- **Icon buttons** — every header control (`Search patient`, `Add patient`, `My Account`, `App Menu`,
  `Implementer Tools`) is an icon with an `aria-label` and **no text node**.
  `button:has-text('Search patient')` is `not-found`; use `role=button[name='Search patient']`.
- **React ids are generated** — `#search-input-:r1d:`, `#table-toolbar-search-:rv:`. Never select on
  them; use the placeholder, the `aria-label`, or the role.

## 7. Gotchas

1. **The URL is not the screen.** Client-side routing lands the URL first and fetches the
   microfrontend after. `{ url: "/chart" }` held with an empty page (`act:12`). Anchor on an element.
2. **The SWR cache eats your `{ request }` predicate.** The patient-summary widgets pre-fetch
   `Condition`, `Observation` and `order` for the patient, so opening the *Conditions*, *Vitals* or
   *Medications* tab issues **no request at all**. `openChartTab()` returns `body: null` there; re-read
   with `conditions()` when you need the data. Anchor those tabs on their heading only.
3. **Opening the search panel is expensive.** Before you type, it hydrates ~10 "recent" patients from
   `user.userProperties.patientsVisited` — roughly 30 `patient/<uuid>`, `visit?patient=`,
   `obs?patient=` requests, many of which are still `[pending]` when your report prints. They are
   noise; scope wire reads to `report.action` *and* the URL.
4. **Reading a chart writes one thing.** The app `POST`s
   `user/<uuid>?v=custom:(userProperties)` to remember `patientsVisited`. It is the only non-GET the
   read-only tour produces (besides `DELETE session` on logout) and it touches no clinical record.
5. **Constant console noise** on every page: a 404 for the PWA icon
   `/openmrs/spa/$SPA_PATH/icon_144x144….png` (an unsubstituted template variable) and
   `Unknown config key '@openmrs/esm-laboratory-app.labTableColumns'`. Neither means anything failed.
6. **Aria lines glue neighbours together.** A search row reads
   `text: "Male 4 yrs, 11 mths · 25-Sept-2021 · CR Number: 100008E"` — one aria line, four facts, all
   of them separately present in the search body. Assert on the body.
7. **The whole app is behind one cookie.** A second script joining the browser inherits the login;
   a `--fresh` launch does not. `check.ts` logs in as its first step for exactly that reason.
8. **`h4` is the chart's section heading level** and several are substrings of each other
   (`Conditions` vs. nothing; `Allergies` vs. `Allergies and reactions` in some configs) — use
   `:text-is()`.

## 8. Timing

dev3 is a shared demo server. Measured on 2026-09-01 (three full check runs):

| Step | Warm | Cold (new browser) |
|---|---|---|
| login (navigate + 2 clicks) | 3.4 s | 4.1 s |
| patient search (panel + type + landed) | 4.5–5.0 s | 4.5 s |
| open a chart cold | 2.9 s | 2.9 s |
| chart tab (client-side) | 0.4–1.1 s | 0.5–0.7 s |
| a home app via URL | ~2 s | ~2 s |
| a wire-only read (`fetch` in page) | 40–150 ms | 40–150 ms |

`check.ts` therefore sets `timeouts: { until: 25000, navigate: 40000 }` — ~5× the observed worst
case, because the server is shared and occasionally stalls. Individual acts keep tighter budgets
(8 s for in-page transitions, 30 s for a cold chart).

## 9. Open questions

- **The login location picker** (`/spa/login/location`). Never seen, because `admin` has
  `userProperties.defaultLocation`. *Experiment:* log in as a user without one, or
  `POST user/<uuid>` clearing `defaultLocation` — that is a write, so it was not attempted.
- **Session expiry behaviour.** Assumed to be a 401 / `authenticated:false`, never observed.
  *Experiment:* `s.evaluate("fetch('/openmrs/ws/rest/v1/session', {method:'DELETE'})")` then act,
  and read the diagnosis — cheap and read-only, just untried inside the hour.
- **Write workflows** — Add patient, Add allergy/condition, the order basket, visit note, clinical
  forms (o3forms), appointment status changes, Fast Data Entry. Each is a visible affordance whose
  endpoint is guessable from `wire.md`, all deliberately untouched.
- **The `results` chart tab** renders lab results as trees/trends; its exact anchor was not pinned
  (`main` is the placeholder in `chartTabs`). *Experiment:* one bare click on the tab and read the diff.
- **`routes.registry.json` (67 K)** was never fully read. It is the complete route/extension
  inventory and would answer "what else is here?" without a single click.
