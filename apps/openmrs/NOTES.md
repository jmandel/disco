# openmrs — NOTES

Raw observations in the order they were made, with the act id (run 1) that shows each.
Distilled into README.md / wire.md; kept here because the act ids are the evidence.

- **act:1** `open openmrs https://dev3.openmrs.org/openmrs/spa/login`. The document is an empty shell;
  `aria` shows only `img "OpenMRS logo"`, `textbox "Username"`, an empty `alert`, `button "Continue"`.
  Two fetches on load: `config-core_demo.json` and `ws/rest/v1/session` (`authenticated:false`, 129 B,
  `f4aea521735410bd`). The anonymous session response already sets `JSESSIONID`.
- **act:2–act:5** Login is two-step: Username → **Continue** (postcondition `input[type=password]`
  visible, 219 ms) → password → **Log in**. The click lands `GET /ws/rest/v1/session` 200 in 209 ms with
  `Authorization: Basic YWRtaW46QWRtaW4xMjM=` and the URL becomes `/openmrs/spa/home`.
  **No login-location picker on this deployment** — the session already had `Outpatient Clinic`.
- **act:6** `until --until-text "Login Location"` expired (3 s, my probe) — confirms the picker is absent.
  The URL had meanwhile become `/openmrs/spa/home/service-queues`: **`/spa/home` redirects**.
- **act:6 aria** Home shell: left nav *Service queues · Appointments · Laboratory · Patient lists ·
  Wards · Billing*; header *Change location (Outpatient Clinic) · Search patient · Implementer Tools ·
  Add patient · My Account · App Menu*. Main pane = the service-queues dashboard (Avg. wait time,
  Waiting 0, Attending 14, then patient cards linking to `/patient/<uuid>/chart`).
- **act:7** `click "Search patient"` — opens a header searchbox named *"Search for a patient by name or
  identifier number"* plus "10 recent search results". The 19-request wire block is **ambient**: the
  queue table lazily fetching `patient/<uuid>`, `obs?patient=…` per row.
- **act:8** `type "Miller"` into `role=searchbox` — **matched 2 elements** (the header box and the
  table's "Filter table" box); disco used the first and said so (`report.matches`). Debounced:
  one `GET /ws/rest/v1/patient?q=Miller&v=custom:(…)` 200, 7.1 K, `744d661942874dd9` → 2 hits
  (Barbara Miller `32351061-…`, Emmawas Miller `e22dd80b-…`).
- **act:9** click the result link → `/patient/<uuid>/chart/`, which self-redirects to
  `/chart/patient-summary`. The click also fires **`POST /ws/rest/v1/user/<uuid>?v=custom:(userProperties)`** —
  the app persisting "recently viewed patients". The only write this pack causes.
- **act:10 aria** Chart left nav (15 tabs): Patient summary, Vitals & Biometrics, Medications, Orders,
  Results, Visits, Allergies, Conditions, Immunizations, Procedures, Attachments, Programs,
  Appointments, Billing history, Growth chart. Right rail = workspace launchers: Order basket,
  Visit note, Clinical forms, Task list, Patient lists. `banner "patient banner"` is the chart anchor.
- **act:11–act:21** One click per chart tab; each tab has exactly one endpoint family (table in
  README §4 / wire.md). Highlights:
  - vitals fires **three** `fhir2/R4/Observation?subject:Patient=…` reads with different `code=` sets;
  - visits builds `https://dev3.openmrs.org/openmrs**//**ws/rest/v1/visit?...` (double slash) and pulls
    259 K + 227 K of encounters;
  - appointments is **`POST /ws/rest/v1/appointments/search`** — a read as a POST;
  - medications/allergies/immunizations/programs/attachments are all empty for this patient and all
    return the same 14-byte body `{"results":[]}` (`5021e624e752b001`).
- **act:23–act:28** The six home dashboards, one endpoint family each (wire.md). Laboratory issues the
  same `order?orderTypes=52a447d3…` **seven times** (one per tab/filter) on a single route change.
- **act:29** App Menu → four more apps: Dispensing `/spa/dispensing`, System Administration
  `/spa/system-administration`, Fast Data Entry `/spa/forms`, Queue screen `/spa/home/service-queues/screen`.
- **act:31–act:33** Patient lists = OpenMRS *cohorts*. `cohortm/cohort` for the lists, tabs
  (Starred/System/My/All) are a client-side filter. Opening a list navigates to
  `/home/patient-lists/<uuid>` and fetches `cohortm/cohort/<uuid>` + `cohortm/cohortmember?cohort=…`.
  **Gotcha found here:** `until: { selector: "table" }` resolved in ~1 s on a *loading skeleton* — a real
  `<table>` with empty cells and `<h1>--`. The data arrived seconds later.
- **act:35** `navigate` straight to `/chart/patient-summary` with
  `until: { request: "/fhir2/R4/Patient/", landed: true }` — clean, 1.4 K FHIR Patient, `b4fa32d17bce1b9a`.
- **act:36** `click "Clinical forms"` opens the workspace side panel; fetches
  `rest/v1/form?v=custom:(…)` → **17 forms** (Covid 19, ERU Intake Form, Fit to Fly Certificate,
  Laboratory Test Results, Mental Health Assessment Form, …) and `rest/v1/encounter?v=…`.
- **act:37** patient-banner **Actions** menu = the write surface: Add to list · Edit patient details ·
  Add visit · End active visit · Mark patient deceased · Delete active visit. Not used.
- **`disco eval` probes (requests `r1-981`, `r1-982`, `action_id IS NULL`)**
  `fetch('/openmrs/ws/rest/v1/session', {headers:{Authorization:'Basic '+btoa('admin:definitely-wrong')}})`
  → **200**, and the body still says `authenticated:true, user:admin`: with a valid `JSESSIONID` the
  server ignores the bad header entirely. **`/session` is never a status-code check.**
- **Navigating to `/openmrs/spa/login` while authenticated does NOT redirect to home** — the form is
  shown again. That is what makes `login()` idempotent from any state.
- **Cold `run-check` failures that taught the real predicates** (both correctly refused by `reached()`):
  1. `openHomeApp("Service queues")` with a `{ url: "/home/service-queues" }` arm → *"until route was
     already true before the action"*, because `/spa/home` had already redirected there.
  2. `openChartTab("conditions")` with a `role=heading[name="Conditions"]` arm → *already true*, because
     the patient-summary dashboard renders a card with that heading.
- **SWR caching, measured:** with the Condition bundle already fetched by patient-summary, clicking the
  Conditions tab issues **no request**, and a `{ request }` predicate burned its whole 20 s budget
  (step time 20 957 ms). Probing the log first and dropping the budget to 4 s took it to 4 588 ms.

---

# Pass 2 — the write side (run 6)

Stance changed: the demo's synthetic data may be written to. Everything created carries the marker
`DISCOTEST` / family name `Zzdiscotest`. The patient created while exploring is
**`ba9fe922-75a1-4037-bc45-161b2825efec` — "Discotest Zzdiscotest", CR Number `1000KTP`**; the list is
**`3d34c597-69c1-4f91-80ed-be481b190948` — "DISCOTEST list 2026-09-01"**. Every `run-check` since adds
one more of each.

- **act:246** header "Add patient" → `/openmrs/spa/patient-registration`. A three-section form
  (Basic Info / Contact Details / Relationships) with a sticky "Register patient". Required: First
  Name, Family Name, Sex, Date of birth. The identifier is *Auto-generated*.
- **act:249 — the single most useful failure of the pass.**
  `reached(s.click('role=radio[name="Female"]'))` →
  `occluded — role=radio[name="Female"] is covered by span.cds--radio-button__appearance`.
  That is **Carbon Design System**, not a modal: the real `<input>` is hidden under a styled span.
  `{ js: true }` fixes every radio and checkbox in the app (act:250, 260, 285, 286, 298).
  disco named the covering element, which is what turned a guess into a rule.
- **act:255 register.** Two POSTs: `idgen/identifiersource/<uuid>/identifier` (201, body `{}`, returns
  `{"identifier":"1000KTP"}`) then `patient/` (201). **The client mints the patient/person uuid** and
  posts it. Lands on the new chart with a snackbar "New Patient Created".
- **act:258–261 start a visit.** Actions → Add visit → a workspace with `New / Ongoing / In the past`
  tabs, a Visit location combobox **pre-set to "Ubuntu Hospital"** (not the session's Outpatient
  Clinic), five visit types as radios, and a Billing details section.
  `POST /ws/rest/v1/visit` 201 with `{visitType, location, startDatetime:null, patient}`.
- **act:262–272 vitals.** "Record vital signs" → a workspace of `spinbutton`s whose input ids are
  React-generated (`:r5d:-temperature`) — accessible names only. `POST /encounter` 201 with **one obs
  per filled field keyed by concept uuid**; the free-text Notes field is concept `165095AAAA…` and is
  where the marker lives.
- **act:273–279 condition.** Typeahead → `GET /ws/rest/v1/concept?name=Headache&searchType=fuzzy&class=8d4918b0-…`
  (Diagnosis class). Save posts a **FHIR resource**: `POST /ws/fhir2/R4/Condition` 201.
- **act:281–288 allergy.** Read is FHIR, **write is REST**: `POST /ws/rest/v1/patient/<uuid>/allergy` 201.
  Allergen is a Carbon combobox (click → `role=option` → click); reactions are checkboxes; severity radios.
- **act:290–293 new patient list.** "New list" opens a **workspace**, not a dialog — my `role=dialog`
  predicate burned 10 s. `POST /ws/rest/v1/cohortm/cohort/` 201; `cohortType:""` is accepted and comes
  back `null`.
- **act:296–299 add to list.** "Add to list" opens a **Carbon modal** (`role=dialog`) — my
  `role=banner[name="Workspace header"]` predicate burned 15 s. So the app has *both* overlay kinds and
  they are not interchangeable. The picker paginates at 5; filter by name instead.
  `POST /ws/rest/v1/cohortm/cohortmember` 201.
- **act:300–309 order basket.** Right rail → basket with two sections (Drug orders, Lab orders), each
  with its own "Add" (`role=button[name="Add"] >> nth=1` is Lab). Search → "Order form" → Reference
  number + instructions → "Save order" → "Sign and close".
  **act:304 taught the flow:** clicking "Sign and close" with an *Incomplete* basket item returned
  `disabled — role=button[name="Sign and close"] is disabled` in ~100 ms. Filling the order form flips
  the item to *New* and enables it.
  Signing POSTs an **encounter that contains the orders** — there is no `POST /order`. The response's
  `orders[]` is a ref (no `orderNumber`); the number needs a re-read of `/ws/rest/v1/order`.
- **act:311–315 service queue.** "Add a patient to this list" → workspace search (the patient did NOT
  appear under "Checked in patients" because their visit is at Ubuntu Hospital) → pick the card →
  Queue Location `<select>` (defaults to the session location) → Service `<select>` → Priority radios
  → "Add patient to queue". `POST /ws/rest/v1/visit-queue-entry` 201, body nesting
  `{visit:{uuid}, queueEntry:{…}}`.
- **All ten writes returned 201**, first time, no retries:
  `SELECT action_id, method, path, status FROM requests WHERE run=6 AND method='POST'`.
- **Two `alreadyTrue` refusals in the write pass**, both correct and both about a control that never
  goes away: `role=button[name="Sign and close"]` is visible behind the order form for the whole flow.
  `{ gone: role=button[name="Save order"] }` is the predicate that actually changes.
- **`latestJson` is the wrong reader for a write.** After a successful POST the app navigates, and the
  GETs it fires land in the same act window — so the "newest body for this family" is a read.
  `lib.ts` reads the POST row explicitly: `s.store.requests({ url, method: "POST", action, run })`.
