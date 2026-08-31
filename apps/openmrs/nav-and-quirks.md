# Navigation & quirks — OpenMRS O3 reference application (dev3.openmrs.org), 2026-08-30

Discovery per GUIDANCE §7 against the public dev demo, `admin` / `Admin123`. Evidence lives in
`apps/openmrs/store/` (run 1 = the aborted o3 attempt, **run 2 = everything below**); citations are act ids
(`act:N`, rows in `actions`) and event cursors (`ev:a-b`). Companions: `ledger.md`, `friction.md`, `lib.ts`,
`check.ts`, `screenshots/`.

**Host note.** The task named `https://o3.openmrs.org`. It sits behind a Cloudflare Turnstile challenge that a
headless Chromium does not pass — the page stays at `403 "Just a moment..."` with a `challenges.cloudflare.com`
iframe (run 1, `screenshots/o3-cloudflare-turnstile.jpg`; the plain `curl` gets a 403, a browser-UA `curl` a 200,
so it is bot-scoring, not IP blocking). Everything here is **dev3.openmrs.org**, the same reference application
build (`openmrs-esm-*-app` 10.x/11.x/12.x pre-releases, core `10.0.1-pre.5263`).

## 1. Layout

A single-page app (React + single-spa microfrontends, Carbon design system) under `/openmrs/spa/…`. **No
iframes, no shadow DOM, no canvas** on the pages visited; one CDP target the whole time. The backend is
OpenMRS REST (`/openmrs/ws/rest/v1/*`) plus FHIR R4 (`/openmrs/ws/fhir2/R4/*`); everything the UI shows is JSON
on the wire first. `routes.registry.json` (captured on load) lists the page routes: `login`, `home`, `search`,
`^patient/.+/chart`, `patient/<uuid>/edit`, `logout`, `patient-registration`, `laboratory`, `forms`, ….

- **Header** (every logged-in page): location pin + current location, `button[aria-label="Change location"]`,
  `button[aria-label="Search patient"]` (**the shell landmark**), Implementer Tools, Add patient, My Account,
  App Menu.
- **Home** `/spa/home/service-queues` — left nav (Service queues / Appointments / Patient lists / Laboratory /
  Wards / Billing), "Attending" cards, "Waiting List" table (Carbon DataTable).
- **Chart** `/spa/patient/<uuid>/chart/<tab>` — patient banner (avatar, name, sex, tags, identifiers, Actions),
  left nav of tabs (Patient summary, Vitals & Biometrics, Medications, Orders, Results, Visits, Allergies,
  Conditions, Immunizations, Procedures, Attachments, Programs, Appointments, Billing history, Growth chart),
  right-hand action rail (order basket, notes, …). Widgets are independent microfrontends that each fetch
  their own data — the page is "loaded" per widget, never as a whole (`still-active` on every chart open).
- **Search** — two faces of one component: the header icon opens an overlay with `[data-testid="patientSearchBar"]`
  (act:9) and the full page `/spa/search?query=<q>` renders the same bar + a "Refine search" panel (act:13).
  Results are `<a href="/openmrs/spa/patient/<uuid>/chart/">` cards.

Selector strategy: **`data-testid` where O3 provides one** (`patientSearchBar`, `patient-banner-button-col`,
`numeric-observation-card`, `searchPatientIcon`), then **`role=`+accessible name** (Carbon buttons carry
`aria-label`s), then attribute selectors on stable form names (`input[name="loginLocations"]`, `#username`,
`#password`). Never Carbon ids (`#search-input-:r5o:` — React `useId`, changes per mount) and never CSS-module
classes (`-esm-patient-banner__patient-banner__container___S…` — hashed).

## 2. Anchors (cheap predicates — `lib.ts::whereAmI` reads all of them in one `evaluate`)

| anchor | URL | landmark | notes |
|---|---|---|---|
| `login.username` | `/spa/login` | `button[type=submit]` with text **Continue**; `#username` | `#password` is ALSO in the DOM here (hidden) — do not use it to tell the steps apart |
| `login.password` | `/spa/login` | submit button **Log in**; `#password` visible | reached client-side from Continue (no wire, act:2 settled:visual 110ms) |
| `login.location` | `/spa/login/location[?returnToUrl=…&update=true]` | `input[name="loginLocations"]` radios (50), searchbox "Search for a location", **Confirm** submit | act:5–8; `screenshots/location-picker.jpg` |
| `home` | `/spa/home/*` | header `button[aria-label="Search patient"]` | lands on `/home/service-queues` after login |
| `shell` | any other `/spa/*` | same header button | generic "logged in" |
| `search` | `/spa/search?query=…` | `[data-testid="patientSearchBar"]` | result cards `a[href*="/patient/<uuid>/chart"]` |
| `chart` | `/spa/patient/<uuid>/chart/<tab>` | `[data-testid="patient-banner-button-col"]` | the banner needs `GET /fhir2/R4/Patient/<uuid>`; widgets keep loading after it |

Recovery from anywhere: `login(s)` — it reads `whereAmI`, navigates to `/spa/login` if lost (an authenticated user
is bounced back into the shell, handled), and treats the location picker as optional.

## 3. Transitions (settlement profile + wire signature)

| transition | act | verdict, settle | wire signature | notes |
|---|---|---|---|---|
| Load `/spa/login` | run-check act:1 | `still-active` ~1.7s, `until #username` 753ms | `importmap.json`, `routes.registry.json`, `config-core_demo.json`, `GET /ws/rest/v1/session` ×2 (`authenticated:false`), ~50 JS chunks | **Cold load hydrates late**: the form can render before handlers attach (run-check #1 failure — see §5.1) |
| fill `#username` → Continue | act:1–2, 20–21, 24–25 | `settled:dom` ~110ms; Continue `settled:visual` ~120ms, until `Log in` button ≤26ms | none | purely client-side step switch |
| fill `#password` → Log in (good creds) | act:4 (ev:455-626), act:31, run-check act:5 | `still-active` 1.1–1.6s (79 req) | **`GET /ws/rest/v1/session` with `Authorization: Basic …` → 200 `{authenticated:true, user, sessionLocation, currentProvider}`** (task), then the home bundle: `/module`, `/addresstemplate`, `/relationshiptype`, `/patientidentifiertype`, `/metadatamapping/termmapping`, `/idgen/*`, `/fhir2/R4/Location?_tag=queue location`, `/queue-entry`, `/queue-entry-metrics`, `/obs?patient=…` | login is a **GET, not a POST**; URL → `/spa/home/service-queues`; **no location picker** when the user has `userProperties.defaultLocation` (admin does: "Mobile Clinic") — n=3 logins, 0 pickers |
| Log in (bad creds) | act:23, act:27 | `settled:visual` ~190–280ms, 0 attributed req | `GET /ws/rest/v1/session → 200 {authenticated:false}` (**no 401**; the daemon tagged it `ambient` — §5.4) | inline Carbon notification `.cds--inline-notification--error[role=status]` "Error Invalid username or password"; form drops back to the **username** step (`screenshots/login-invalid-credentials.jpg`) |
| Change location (header) | act:5 (ev:694-709) | `settled:network` 294ms | `GET /session`; `GET /fhir2/R4/Location?_summary=data&_count=50&_tag=Login+Location` (41.7KB bundle = the radio list), `Location?_id=<current>`, `Location?_count=1&_tag=Login+Location` | URL `/spa/login/location?returnToUrl=<from>&update=true` |
| pick a location radio | act:6 ✗ / act:7 ✓ | act:6 **diagnosis: occluded** by `span.cds--radio-button__appearance` (the input is visually hidden); act:7 `settled:dom` 8ms | none | **click the `label[for="<uuid>"]`**, not `role=radio` |
| Confirm location | act:8 (ev:716-763) | `settled:network` 840ms, until shell 506ms | `POST /ws/rest/v1/session {"sessionLocation":"<uuid>"}` ✎ → 200; `POST /ws/rest/v1/user/<userUuid>` ✎ (`userProperties.defaultLocation`); then the home bundle again | snackbar `alertdialog "Location updated"` (sentinel dialog + toast); back at `returnToUrl` |
| header Search patient | act:9 (ev:767-809) | `still-active` 1.1s, until searchbox 75ms | 10× `GET /rest/v1/patient/<uuid>` ("recent patients" = `userProperties.patientsVisited`), then `/person/<uuid>`, `/visit?patient=` per card | overlay; input autofocused |
| type in the search bar | act:10 (ev:911-947) | `settled:dom` 110ms, until wire 1013ms | **`GET /ws/rest/v1/patient?q=<text>&v=custom:(patientId,uuid,voided,identifiers,display,patientIdentifier:(uuid,identifier),person:(gender,age,birthdate,birthdateEstimated,personName,addresses,display,dead,deathDate),attributes:(…))&includeDead=false&limit=10&totalCount=true`** → `{results:[…], totalCount}` (window); then per hit `/visit?patient=`, `/person/<uuid>` | debounced (~300ms); spaces encode as `+` (`q=Susan+Lopez`, act:16) |
| navigate `/spa/search?query=<q>` | act:13, 14, 16, 17; run-check act:6 | `navigated` 1.3–2.4s, until wire 1.0–1.9s | full SPA reload (~130 req) + the same `patient?q=` request | the deterministic form `lib.ts::findPatient` uses |
| click a result card | act:11 (ev:949-1207), 15, 18 | `still-active` 1.8–2.7s (112 req) or `settled:visual` 42ms with until 1.1s | **`POST /ws/rest/v1/user/<userUuid>` ✎** (patientsVisited — a write on a read flow), `GET /fhir2/R4/Patient/<uuid>?_summary=data`, `/rest/v1/visit?patient=…&includeInactive=false`, `/visit/<uuid>`, `/person/<uuid>`, `/billing/patientPaymentStatus/<uuid>`, `/order?…`, `/fhir2/R4/Observation` ×3 (vitals, biometrics, one empty code set), `/conceptreferencerange/*` ×3, `/fhir2/R4/Condition?patient=…` | URL `/patient/<uuid>/chart/patient-summary`; widgets settle one by one — the banner is the anchor, not the page |
| chart tab Allergies | act:12 (ev:1209-1215) | `settled:network` 287ms, until 203ms | `GET /fhir2/R4/AllergyIntolerance?patient=<uuid>&_summary=data` (task) | client-side route; only this tab fetches allergies |
| `/spa/logout` | act:19 (ev:2928-3087) | `navigated` 767ms | `DELETE /ws/rest/v1/session → 204` ✎; then `GET /ws/rest/v1/module → 500` (harmless, app keeps going) | lands on `/spa/login` at the username step |

Settlement stats (run 2, 31 acts, `bun scripts/timing-report.ts openmrs`): `settled:dom` p50 111ms;
`settled:visual` p50 124ms; `settled:network` p50 294ms; `navigated` p50 1.4s; `still-active` p50 1.4s, max 2.7s
(chart open). `until` matched 24/24, p50 197ms, p90 1.1s, max 1.9s. Daemon overhead 5% of act time.

## 4. Wire-available facts (prefer these over scraping — §2.3)

| fact | endpoint | shape |
|---|---|---|
| who am I / where am I logged in | `GET /ws/rest/v1/session` (re-fetched on every page; ~25× in the run) | `{authenticated, locale, user:{uuid,display,systemId,userProperties:{defaultLocation, patientsVisited, starredPatientLists, …}}, sessionLocation:{uuid,display}, currentProvider:{uuid,display}}` |
| login locations | `GET /ws/fhir2/R4/Location?_summary=data&_count=50&_tag=Login+Location` | FHIR Bundle, `entry[].resource.{id,name}` (50 here; the picker's searchbox covers the rest) |
| patient search | `GET /ws/rest/v1/patient?q=…` (params above) | `results[].{uuid, display:"<id> - <name>", identifiers[].{identifier,preferred,identifierType}, person:{display,gender,age,birthdate,dead}}`, `totalCount` |
| patient header | `GET /ws/fhir2/R4/Patient/<uuid>?_summary=data` | FHIR Patient: `name[0].text`, `gender`, `birthDate`, `identifier[].value` |
| conditions (problem list) | `GET /ws/fhir2/R4/Condition?patient=<uuid>&category=…problem-list-item&_count=100&_summary=data` | Bundle; `resource.code.text`, `clinicalStatus.coding[0].code`, `onsetDateTime`, `recordedDate` (Susan Lopez: 15) |
| allergies | `GET /ws/fhir2/R4/AllergyIntolerance?patient=<uuid>&_summary=data` | Bundle (0 entries for the sampled patient — the shape of a populated one is **unobserved**, ledger #7) |
| vitals | `GET /ws/fhir2/R4/Observation?subject:Patient=<uuid>&code=5085,5086,5087,5088,5092,…&_summary=data&_sort=-date&_count=100` | Bundle of numeric Observations: `code.text` ("Systolic blood pressure", "Pulse", "Temperature (c)", "Respiratory rate", "Arterial blood oxygen saturation (pulse oximeter)"), `valueQuantity.{value,unit}`, `effectiveDateTime`; 64 entries = 8 vitals sets |
| biometrics | same, `code=5090,5089,1343,1342` | Weight (kg), Height (cm), MUAC; **BMI is computed client-side, not on the wire** |
| active visit | `GET /ws/rest/v1/visit?patient=<uuid>&v=custom:(…encounters…)&includeInactive=false` | `results[].{uuid, visitType.display, startDatetime, stopDatetime, location.display, encounters[]}` |
| waiting list / attending | `GET /ws/rest/v1/queue-entry?v=custom:(…)&status=<uuid>&isEnded=false` | `results[].{patient:{uuid,display,person:{display,age,gender},identifiers}, queue.display, status.display, priority.display, startedAt}` — a free list of **patient names that exist right now** (`check.ts::pickKnownName`) |
| SPA config | `GET /openmrs/spa/config-core_demo.json`, `routes.registry.json`, `importmap.json` | which apps/routes are mounted |

Concept uuids on the wire (each is `<n>AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`): the "vitals" request asks for
`5085,5086,5087,5088,5092,5090,5089,5242` (systolic, diastolic, pulse, temperature, SpO2, height, weight, respiratory
rate — matched to `code.text` in the bodies); the "biometrics" request asks for `5090,5089,1343,1342`; a third request
for `165095` returned 0 entries for this patient. (Mapping of 1343/1342/165095 is inferred from the widget — MUAC and
two unknowns — not observed as named observations.)

## 5. Failure modes actually seen (instances of the §8 catalog)

1. **Cold-load hydration race (re-render race).** `run-check` #1: `#username` rendered, `fill` + `Continue` looked
   fine, then `role=button[name="Log in"]` was not found and the diagnosis still listed the **Continue** button +
   pending JS chunks. The form re-rendered over the fill (controlled input reset → HTML5 `required` swallowed the
   submit with zero DOM change). Handled in `lib.ts::login`: postcondition of the fill is `#username.value === u`,
   postcondition of Continue is the **Log in** button (not `#password`, which exists hidden throughout), and the
   step retries once. The second cold run passed (run-check act:1–5).
2. **Hidden native inputs behind Carbon's custom controls.** `role=radio[name=…]` resolves to the `<input>` that Carbon
   hides under `span.cds--radio-button__appearance` → `diagnosis: occluded` (act:6). Recipe: click the
   `label[for="<uuid>"]` (act:7). Expect the same for checkboxes/toggles.
3. **Conditional interstitial — the location picker.** Present after login only when the user has no stored
   default location (or the deployment forces it); absent for `admin` on dev3 (n=3). Reached deliberately via
   "Change location" (act:5). `login()` handles both directions; **an unobserved branch** remains: the picker
   appearing directly after Log in (same route/component, but n=0 — ledger #2).
4. **Login's own request classified ambient.** The app fetches `GET /ws/rest/v1/session` in 2–3-request bursts on
   every page; after ~20 the classifier tagged the family `ambient (chained)`, so act:23/27/31's reports show
   "0 req, ~1 ambient" for the one request that decides login. `lib.ts` reads the newest session body from the
   store regardless of attribution (`sessionInfo`) — never gate on the report's attributed list for this family.
5. **Writes on read flows.** Opening a chart POSTs `/ws/rest/v1/user/<uuid>` (patientsVisited); picking a location
   POSTs `/session` and `/user/<uuid>`; logout DELETEs `/session`. All flagged ✎ correctly. There is no way to open
   a chart without the userProperties write — declare it in any read-only stance.
6. **Widget-by-widget loading.** Every chart open is `still-active` at 1.8–2.7s (dom + pixels) while 100+ requests
   land; "the page is ready" is meaningless — anchor on the banner and on the specific FHIR body you need.
7. **Sentinel noise.** The toast sentinel fires on Carbon `role=status` loaders ("loading", "Loading …",
   "Logging in…", "Submitting") and on **DataTable rows** (`"Auto9263 Patient15--Not UrgentWaiting…"`, `"Osteoarthritis
   of knee04 — Aug — 2026Active…"`): 50 toast sentinels in run 2, ~3 real. The error sentinel fires on the manifest
   icon 404. Read them as a hint, never as a gate (`friction.md` #8).
8. **Home-page polls.** `/queue-entry` ×2, `/fhir2/R4/Location` ×2, `/obs?patient=…` ×3 re-fetch every ~60s (SWR
   revalidation; one 120s gap observed under headless throttling). Not auto-classified after 120s idle (bursts of the
   same family give cv 1.3–1.9); marked manually with `disco families --ambient` for `queue-entry` and `obs`
   (**not** `Location` — that family also carries the login-location list, ledger #5).
9. **Post-login actionable toast (optional, non-blocking).** "Some modules have unresolved backend dependencies"
   — a Carbon `cds--actionable-notification--toast[role=alertdialog]` top-right with **View modules** / **close
   notification**; not `aria-modal`, persists until closed, overlaps the header area (act:31 sentinel dialog seq 63;
   1 of 4 logins). Dismissed by `login()` via `actIfPresent(s, 'role=alertdialog >> role=button[name="close
   notification"]')` (act:32, `settled:visual` 20ms). Selector chaining (`>>`) works as README promises.
10. **No native dialogs, no beforeunload, no session-expiry warning** in ~30 minutes of driving; `react-joyride`
    (user-onboarding tour) is mounted but never showed a step on a fresh profile (ledger #4).

## 6. Auth / session behaviour

- Login = `GET /ws/rest/v1/session` with `Authorization: Basic base64(user:pass)`; success is `authenticated:true`
  in the body, failure is `authenticated:false` with HTTP 200. The JSESSIONID cookie then carries the session; the
  app re-GETs `/session` on every route change (that is why it is "ambient").
- Logout = `DELETE /ws/rest/v1/session` (204) via `/spa/logout`.
- `userProperties.defaultLocation` decides whether the location picker appears; `Confirm` writes it (`POST /user/<uuid>`).
- Idle timeout: not observed within the run (longest idle ≈ 2.5 min); no keepalive beyond the SWR polls. Open (ledger #8).

## 7. How to drive it (the short version — `lib.ts`)

```
login(s)                       whereAmI → (navigate /spa/login) → fill+Continue (retry once) → fill+Log in
                               → shell | location picker (label click + Confirm) | inline error (throws with the text)
findPatient(s, name)           login → navigate /spa/search?query=… until GET /patient?q= landed → results off the wire
openPatient(s, uuid|name)      (findPatient) → click the card if on screen else navigate /patient/<uuid>/chart
                               until URL + banner → Patient FHIR body
extractSummary(s)              assertChart → Condition / Observation(vitals+biometrics) / AllergyIntolerance bodies
                               (opens the tab that fetches a missing one) → reduced facts + which endpoint each came from
```
