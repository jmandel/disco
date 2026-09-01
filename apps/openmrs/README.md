# openmrs — dev3.openmrs.org (OpenMRS 3.x / "O3")

`https://dev3.openmrs.org/openmrs/spa/login` · `admin` / `Admin123` · public demo, synthetic data.
**This pack is read-only.** Nothing in `lib.ts` submits a form or creates/edits a clinical record.

## 1. What it is

OpenMRS is an open-source **electronic medical record system** — a patient chart plus the clinic
workflow around it. This deployment is its "O3" frontend: a **microfrontend single-page app**. The
document at `/openmrs/spa/<anything>` is a 3.3 KB shell; each feature (login, primary navigation,
patient search, patient chart, service queues, appointments, patient lists, laboratory, ward,
billing, registration) is a separately versioned ES module under
`/openmrs/spa/openmrs-esm-<name>-app-<version>/…js`, wired together by
`GET /openmrs/spa/config-core_demo.json`. The HTML carries no content; **the accessibility tree is
the only honest picture of the screen** and the JSON on the wire is the only honest source of facts.

Two JSON APIs, same origin, both cookie-authenticated:

* `/openmrs/ws/rest/v1/…` — the native **OpenMRS REST API**. `{"results":[…]}`, projections chosen
  with `?v=custom:(a,b,c:(d))`, pagination with `limit/startIndex/totalCount`.
* `/openmrs/ws/fhir2/R4/…` — a **FHIR R4 facade**. `Patient`, `Observation`, `Condition`,
  `AllergyIntolerance`, `Immunization`, `Location`. Searchset `Bundle`s.

Which one serves a given chart tab is not guessable — see `wire.md`, the table is the map.

**Auth** is a session cookie: `GET /openmrs/ws/rest/v1/session` with
`Authorization: Basic base64(user:pass)` returns the identity and sets
`JSESSIONID=…; Path=/openmrs; HttpOnly`; `DELETE` on the same URL logs out (204). Wrong credentials
still return **HTTP 200** with `authenticated:false` — never read the status code as the verdict.

No iframes, no WebSocket, no SSE, and **no background polling** was observed in two runs
(`SELECT … FROM requests WHERE action_id IS NULL` is empty apart from page-load traffic).
That is unusual and pleasant: every request in a report is one you caused.

## 2. Glossary — the app's nouns

| Noun | On screen | On the wire |
|---|---|---|
| **Patient** | the chart, the search results, the banner | `patient` (REST) / `Patient` (FHIR). Identified by a uuid everywhere; the human-facing id is an **identifier** |
| **Identifier** | `CR Number: 100002U` in the banner | `identifiers[].identifier`; type from `patientidentifiertype`, the primary one named by `metadatamapping/termmapping?code=emr.primaryIdentifierType` |
| **Visit** | "Active Visit" tag; the Visits tab | `visit` — a stay/attendance, with `visitType`, `startDatetime`, `stopDatetime`, and a list of encounters |
| **Encounter** | a row inside a visit | `encounter` — one clinical interaction; carries `obs`, `orders`, `diagnoses`, `form` |
| **Obs** (observation) | vitals numbers, form answers | `obs` (REST) / `Observation` (FHIR). Everything measured is an obs against a **Concept** |
| **Concept** | the label of a measurement | uuid like `5085AAAA…` (systolic BP). The vitals request is literally a list of concept uuids |
| **Condition** | the Conditions tab / summary widget | FHIR `Condition`, `category=problem-list-item` |
| **Order** | Medications tab, Laboratory worklist | `order` — a drug order (`orderTypes=131168f4-…`) or a test order (`orderTypes=52a447d3-…`) |
| **Program** | Programs tab | `programenrollment` against a `program` (HIV care, TB…) |
| **Queue / queue entry** | Service queues: "Waiting list", "Attending" | `queue-entry` — a patient waiting in a service queue at a location, with `priority` and `status` |
| **Patient list** | the Patient lists app | **`cohortm/cohort`** — a list *is* a cohort; its rows are `cohortm/cohortmember` |
| **Form** | Clinical forms workspace | `form` — a data-entry form definition (`resources[].valueReference` points at the JSON schema) |
| **Provider / session location** | "Outpatient Clinic" in the header | `session.currentProvider`, `session.sessionLocation` — the location scopes queues, wards and billing |
| **Workspace** | the right side-rail panels | not a wire concept: a client-side panel stack in `#omrs-workspaces-container` |

## 3. Anchors

| Screen | URL contains | Element |
|---|---|---|
| Login (username step) | `/spa/login` | `role=textbox[name='Username']` |
| Login (password step) | `/spa/login` | `input[type=password]` |
| Shell / home | `/spa/home` | `nav[aria-label='Left navigation'] a[href$='/home/appointments']` |
| Patient search overlay | (any) | `role=searchbox[name='Search for a patient by name or identifier number']` |
| Patient chart | `/patient/<uuid>/chart` | `[aria-label='patient banner']` |
| A chart tab | `/chart/<tab>` | the tab's request landing (see `chartTabs` in `lib.ts`) |
| Workspace open | (any) | `#omrs-workspaces-container [aria-label='Workspace header']` |
| User menu open | (any) | `.cds--header-panel--expanded` |
| Registration | `/patient-registration` | `role=button[name='Register patient']` (starts `[disabled]`) |

`{ url: "/spa/" }` is useless as a predicate — everything is under it. Anchor on the element.

## 4. Workflows

All of these are in `lib.ts`; act ids are from run 1 unless noted.

### Log in (`login`, `ensureLoggedIn`) — act:2 … act:5

```ts
await s.navigate(LOGIN_URL, { until: { selector: "role=textbox[name='Username']", visible: true } });
await s.fill("role=textbox[name='Username']", "admin");
await s.click("role=button[name='Continue']", { until: { selector: "input[type=password]", visible: true } });
await s.fill("input[type=password]", "Admin123");
await s.click("role=button[name='Log in']", { until: { any: [
  { selector: anchors.home.el,               label: "shell" },
  { text: "Invalid username or password",    label: "bad-credentials" } ] }, timeout: 30000 });
```

Two screens, not one. On success the URL becomes `/spa/home` and then immediately
`/spa/home/service-queues`. Cold: ~4 s. Warm: ~1.5 s.

`ensureLoggedIn` is the normal entry point: navigate to `/spa/home` with an `any` of the shell and
the login box, and only log in when asked.

### Search for a patient (`searchPatients`) — act:6, act:7, act:91

```ts
await s.click("role=button[name='Search patient']", { until: { selector: BOX, visible: true } });
await s.fill(BOX, "1000", { until: { request: "/ws/rest/v1/patient?q=", landed: true }, timeout: 20000 });
const hits = s.store.latestJson("/ws/rest/v1/patient?q=", r.action).results;
```

`fill` is enough (controlled React input; one input event starts the request). Searching matches
**name or identifier**: `1000` → 10 hits (every CR Number starts `1000`), `Miller` → 2, `a` → 0
(the server wants a longer term). Results carry `uuid`, `person.display`, `identifiers[0].identifier`,
`person.gender`, `person.age`. Result links go to `/openmrs/spa/patient/<uuid>/chart/`.
Opening the overlay with an empty box shows the **10 most recently viewed** patients, fetched one
`GET /patient/<uuid>` at a time from the `patientsVisited` user property.

### Open a chart and read demographics (`openChart`) — act:8, act:28, act:63

Always by full navigation to `/openmrs/spa/patient/<uuid>/chart/patient-summary`, with
`until: { all: [ { selector: "[aria-label='patient banner']" }, { request: "fhir2/R4/Patient/<uuid>", landed: true } ] }`.
Demographics come from that FHIR `Patient`, not from the banner text (the banner glues name, sex,
age, birth date and identifier into one aria line — see *Selector gotchas* in the root README).
Cold: ~3 s.

### Read a chart tab (`chartTab`, and `conditions` / `allergies` / `vitals` / `visits`) — act:30 … act:41

Precondition: already on that patient's chart. Click the left-nav link, wait on the **URL**, then
wait on the tab's request with a **short** budget, then read the body from the log scoped to the
patient uuid:

```ts
await s.click(`nav[aria-label='Left navigation'] a[href$="/chart/conditions"]`, { until: { url: "/chart/conditions" } });
await s.until({ request: "fhir2/R4/Condition?patient=", landed: true }, { timeout: 2500 });  // may expire: cache
const bundle = wireJson(s, "fhir2/R4/Condition", uuid);   // newest matching body this run
```

The short budget matters: `patient-summary` has already fetched Conditions, Vitals, Medications and
Visits, so those tabs are react-query cache hits and issue nothing. `chartTab` returns
`fromCache: true` when that happens; the body is identical either way.

### Patient lists (`patientLists`, `openPatientList`) — act:55, act:57

`/spa/home/patient-lists` → `cohortm/cohort` (uuid, name, size, `cohortType`: *My List* / *System List*).
Tabs are Starred / System / My / All — client-side filters over the same body. Opening a list
navigates to `/spa/home/patient-lists/<uuid>` and fetches `cohortm/cohortmember?cohort=<uuid>`;
rows are `results[].patient`, and each name links to that patient's chart.

### Service queues (`serviceQueues`) — act:43, act:61

The default home app. Two metric tiles (average wait, waiting count), an "Attending" strip of
patient cards, and a "Waiting list (N)" table. Both sections come from
`GET /ws/rest/v1/queue-entry?…`, issued **twice**; see *Gotchas*.

### Appointments (`appointmentsForDate`) — act:45, act:59

`/spa/home/appointments`: a date picker, five metric tiles, and a table
(Patient name / Identifier / Location / Service type / Appointment time / Visit start time / Status).
`GET /ws/rest/v1/appointments?forDate=<ISO>` — `[]` on the day tested.
A patient's own appointments are `POST /ws/rest/v1/appointments/search` with
`{"patientUuid":"…","startDate":"…"}`.

### Laboratory, Ward, Billing — act:49, act:51, act:53

Worklists over the same primitives: lab = `order?orderTypes=52a447d3-…` split across four tabs
(Tests ordered / In progress / Completed / Declined) with a date-range filter; ward =
`admissionLocation/<location>` + `emrapi/inpatient/admission`; billing = `billing/bill`.

### Clinical forms workspace (`clinicalForms`) — act:65 … act:72

`role=button[name="Clinical forms"]` in the right side rail →
`until: { selector: "#omrs-workspaces-container [aria-label='Workspace header']:has-text(\"Clinical forms\")" }`.
The panel lists every form with its "Last completed" date; **the pack never opens a form**
(opening one starts an encounter draft). Close with
`s.click("#omrs-workspaces-container >> role=button[name='Close']", { until: { gone: … } })`.

### Log out (`logout`) — act:78, act:79

`openUserMenu` first (see *Gotchas*), then `role=button[name='Logout']` with
`until: { selector: "role=textbox[name='Username']" }`. `DELETE /ws/rest/v1/session` → 204.

## 5. Interstitials and recovery

* No modal interstitial ever appeared in ~140 acts (no "what's new", no session warning, no allergy
  prompt). The only conditional screens are the **login page** (when the cookie is gone) and the
  **failed-login toast**.
* Session expiry arrives as the login page. Every anchor in `lib.ts` that can be reached
  unauthenticated should be an `any` with `anchors.login.el` as the second arm — `ensureLoggedIn`
  already is, so a refusal costs ~2 s, not a 30 s budget.
* **Way back to the shell from anywhere:** `s.navigate(HOME_URL, { until: { any: [shell, login] } })`.
  A full navigation also clears the workspace stack and the react-query cache.

## 6. Input recipes

* **Login** is two screens; `Continue` before the password field exists.
* **Patient search** takes `fill` (not `type`); the endpoint is `patient?q=`, *not* anything with
  `search` in it. Queries shorter than ~3 characters return nothing.
* **Date pickers** (appointments, laboratory) are Carbon multi-`spinbutton` groups whose accessible
  names are enormous run-on strings (`"day, Start Date, month, Start Date, year, …"`). Prefer the
  wire (`?forDate=`) over driving them.
* **The user menu** must be opened by clicking `My Account` even though its items already pass
  Playwright's visibility check.
* Mixing selector engines in one target needs `>>`:
  `"#omrs-workspaces-container >> role=button[name='Close']"`. Without it Playwright throws
  `Unexpected token "=" while parsing css selector`.

## 7. Gotchas

1. **`[role=alert]` on the login page is always there and always empty** — it is Carbon's
   text-input character counter. The real error is `[role=status]` with the text
   `Error Invalid username or password`, and it **lingers** after the form resets to the username
   step, so a second attempt's `until: { text: … }` is satisfied instantly. `login()` navigates to a
   fresh login document every time to avoid this.
2. **You cannot test a password while a session cookie is live.** `/spa/login` redirects itself to
   the shell after ~1–2 s when `session.authenticated` is true, so *any* password "succeeds".
   `logout()` first. (This failed a check step before it was fixed.)
3. **The user-menu panel is off-screen, not hidden.** `role=button[name='Logout']` is attached and
   passes `visible`, so `until` on it is `alreadyTrue` and clicking it is diagnosed `occluded`.
   The panel's open state has **no aria signal at all** (the `ui` diff after clicking `My Account`
   is empty); the only anchor is the Carbon class `.cds--header-panel--expanded`.
4. **react-query caches per document.** A tab you already visited issues no request; an
   `until: { request }` then burns its whole budget. Keep such budgets ≤ 2.5 s and read bodies from
   the log scoped by the patient uuid (`wireJson`).
5. **`store.latestJson` picks the newest response, which is not always the one on screen.**
   Service queues fires `queue-entry` twice; the *newer* body is the empty waiting list (29 B) while
   the rows you see came from the earlier 29 KB body. `serviceQueues()` selects by `body_size`.
6. **The Visits tab requests `/openmrs//ws/rest/v1/visit`** — a real double slash. Predicates that
   assume a single slash miss it.
7. **Opening a chart writes.** `POST /ws/rest/v1/user/<uuid>` appends to the `patientsVisited` user
   property. Harmless, but it is a write, and it is what makes the search overlay's "recent" list
   change under you.
8. **Every full page load re-fetches ~15 metadata endpoints** (`addresstemplate`, `relationshiptype`,
   `idgen/*`, `patientidentifiertype`, `module`, `session` ×3). They will be in every report window;
   they are the registration app warming up, not something you triggered.
9. **`/openmrs/ws/rest/v1/obs?…` returns `{"results":[]}` (14 B) constantly** — the same body hash
   `5021e624e752` appears ~125 times. An empty result is not an error.
10. **Response bodies are big.** The Visits tab pulls 259 KB + 227 KB, vitals 162 KB. Reads are fast
    on dev3 (50–900 ms) but do not assume the report's `[body pending]` means failure.

## 8. Budgets

dev3 is shared and sometimes slow. Numbers actually observed (two full `run-check` passes):

| Step | Cold | Warm | Budget used |
|---|---|---|---|
| login (navigate + 2 screens) | 4.3 s | 1.5 s | 30 s |
| chart open (full navigation + FHIR Patient) | 3.1 s | 2.9 s | 30 s |
| a chart tab, fetched | 0.2–0.9 s | | 20 s url + 2.5 s request |
| a chart tab, cache hit | 2.5 s (the expiring grace) | | |
| home app (full navigation) | 1.5–3.8 s | | 30 s |
| whole `check.ts` (11 steps) | 30.6 s | 30.6 s | |

## 9. Open questions

* **Ward and Laboratory were only opened, not driven.** The lab worklist was empty on the day
  tested; to characterise it, place no order — instead find a patient with an existing test order
  (`GET /ws/rest/v1/order?orderTypes=52a447d3-…&v=full` across patients) and open the worklist row.
* **`orders` and `growth-chart` chart tabs** are in the nav but were never opened.
* **Does the session expire on its own, and how does the SPA present it?** The experiment:
  `s.evaluate("fetch('/openmrs/ws/rest/v1/session',{method:'DELETE'})")` from a chart page, then
  click a tab and read the report — does it redirect to `/spa/login`, or render an error?
* **Locations.** `Change location` in the header rewrites `session.sessionLocation`, which scopes
  queues/wards/billing. Not exercised (it is a write to the session).
* **`?v=custom:(…)` is a projection language** — the same endpoint returns very different bodies for
  different `v`. `s.evaluate("fetch(…)")` against `?v=full` is a fast way to see everything a
  resource has, and lands in the log.
* Anything that creates data — registration, visit note, order basket, form entry, queue moves — was
  deliberately left untouched. Each one's endpoint is visible in `wire.md` by the shape of its read.
