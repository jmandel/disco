# openmrs — OpenMRS 3.x reference application (`dev3.openmrs.org`)

## 1. What it is

**OpenMRS 3 (O3)** is an open-source electronic medical record system for clinics and hospitals,
mostly deployed in low-resource settings. `dev3.openmrs.org` is the public demo of its *reference
application*: synthetic patients, real code. The UI is a **single-page app built from independently
deployed micro-frontends** ("esm-\*" apps composed at runtime by `single-spa` + `import-map`), served
under `/openmrs/spa/`; the HTML document is an empty shell, so **`./disco aria` is the only honest
picture of a screen**. There are **no iframes, no WebSockets, no server-sent events** — every fact
travels over ordinary XHR/fetch.

It talks to **two REST APIs on the same origin**:

- `/openmrs/ws/rest/v1/…` — the OpenMRS REST API. Everything operational: sessions, visits,
  encounters, orders, queues, cohorts (patient lists), forms, billing, bed management.
  Responses are `{ results: [...], totalCount? }`. Field selection is a query parameter:
  `?v=custom:(uuid,display,patient:(uuid,person:(display)))`.
- `/openmrs/ws/fhir2/R4/…` — a **HL7 FHIR R4 façade** over the same data. Everything *clinical* that
  the chart shows: `Patient`, `Observation`, `Condition`, `AllergyIntolerance`, `Immunization`,
  `Location`. Responses are FHIR `Bundle`s (`{ total, entry: [{ resource }] }`), usually requested
  with `_summary=data`.

Config comes from `/openmrs/spa/config-core_demo.json`; which micro-frontends exist is decided there
and in the import map, which is why the left-nav differs between deployments.

**Auth** is `GET /openmrs/ws/rest/v1/session` with an `Authorization: Basic base64(user:pass)` header.
The response sets `JSESSIONID=…; Path=/openmrs; HttpOnly` and every later call rides that cookie.
There is no bearer token anywhere. **The endpoint always answers `200`** — even with a wrong password,
and even when the cookie overrides a garbage `Authorization` header — so the verdict is the JSON field
`authenticated`, never the status code (requests `r1-981` & `r1-982`; `disco eval` rows carry no act id).

**What it is *for*.** Everything above is scaffolding for one job: keeping a longitudinal record of a
patient's care and moving that patient through a clinic day. The nouns are the write surfaces — you
**register** a person, **start a visit** for them, put them in a **queue** for a service, record
**observations** and **conditions** and **allergies** into **encounters** that hang off that visit,
**order** drugs and lab tests, and close the visit. `lib.ts` now drives all of those (§5).

**Writes in this pack.** Every record created here is obviously synthetic and marked: patients are
`Discotest Zzdiscotest` (family name `Zzdiscotest`), and free-text fields carry the literal string
`DISCOTEST` plus a timestamp. Nothing edits or deletes a record this pack did not create.
Cleanup handles: `GET /openmrs/ws/rest/v1/patient?q=Zzdiscotest`, and cohorts whose name contains
`DISCOTEST`; `await o.findMarkedRecords(s)` returns both.
One write happens whether you want it or not: opening a chart makes the app
`POST /openmrs/ws/rest/v1/user/<uuid>?v=custom:(userProperties)` to remember the patient in
"recently viewed".

## 2. Glossary — the app's nouns

| Noun | On screen | On the wire |
|---|---|---|
| **Patient** | patient banner, search results | `fhir2/R4/Patient/<uuid>` (`name[0]`, `birthDate`, `identifier[]`); `rest/v1/patient?q=` for search |
| **Identifier** | "CR Number: 100002U" | `identifiers[].display` (REST) / `identifier[].value` (FHIR). `patientidentifiertype` lists the kinds |
| **Chart** | everything under `/patient/<uuid>/chart/` | not a resource — a set of tabs, each with its own endpoint (§4) |
| **Visit** | "Active Visit" pill; Visits tab | `rest/v1/visit?patient=` — `visitType`, `startDatetime`, `stopDatetime`, `encounters[]` |
| **Encounter** | a row inside a visit; "All encounters" tab | `rest/v1/encounter?patient=` — `encounterType`, `form`, `obs[]`, `encounterProviders[]` |
| **Obs (observation)** | vitals numbers, result values | `fhir2/R4/Observation?subject:Patient=…&code=<concept uuid>` or `rest/v1/obs` / `rest/v1/obstree` |
| **Concept** | the dictionary behind every coded value | uuids like `5085AAAA…` (systolic BP). `rest/v1/concept/<uuid>` |
| **Condition** | Conditions tab | `fhir2/R4/Condition?patient=…&category=…|problem-list-item`; non-coded ones hide in `extension[url$=non-coded-condition].valueString` |
| **Order** | Orders / Medications tabs, Laboratory | `rest/v1/order?patient=…&orderTypes=<uuid>` — drug orders and test orders are the same resource with different `orderTypes` |
| **Form** | "Clinical forms" workspace | `rest/v1/form?v=custom:(…)` — 17 published forms on this demo |
| **Queue / queue entry** | Service queues dashboard | `rest/v1/queue-entry` — `queue`, `status` (Waiting/Attending), `priority` (Urgent/Not Urgent) |
| **Patient list** (= *cohort*) | Patient lists dashboard | `rest/v1/cohortm/cohort` (the lists) and `rest/v1/cohortm/cohortmember?cohort=<uuid>` (the members) |
| **Location** | "Outpatient Clinic" in the header | `fhir2/R4/Location?_tag=queue%20location`; the *session* location is `session.sessionLocation` |
| **Provider** | "admin - Super User" | `session.currentProvider` |
| **Program** | Care Programs tab | `rest/v1/programenrollment?patient=` |

## 3. Anchors

| Screen | URL contains | Element |
|---|---|---|
| Login (step 1) | `/spa/login` | `role=textbox[name="Username"]` |
| Login (step 2) | `/spa/login` | `input[type=password]` |
| Home shell | `/spa/home` | `nav a[href$="/home/service-queues"]` |
| Any patient chart | `/chart` | `role=banner[name="patient banner"]` |
| Header patient search open | — | `role=searchbox[name="Search for a patient by name or identifier number"]` |

`/openmrs/spa/home` **redirects to `/home/service-queues`** — that is the default dashboard, so a
`{ url: "/home/service-queues" }` predicate is `alreadyTrue` the moment you are home.
`/openmrs/spa/login` does **not** redirect an already-authenticated session away; it shows the form
again, which makes `login()` idempotent and safe to call from anywhere.

## 4. Read workflows

All of these are in `lib.ts`; every transition carries an `until`, and every fact is read from the log.

### Log in — `login(s)` (act:2–5)
```
navigate /openmrs/spa/login       until: role=textbox[name="Username"]
fill  Username = admin
click "Continue"                  until: input[type=password] visible      # two-step form
fill  password
click "Log in"                    until: any[ nav a[href$="/home/service-queues"] , text "Incorrect username or password" ]
```
Ends on the home shell. `sessionInfo(s)` then reads `authenticated / user / roles / sessionLocation`.
No location picker appeared on this deployment — the server session already carries
`sessionLocation = Outpatient Clinic` (open question §8).

### Find a patient — `searchPatients(s, "Miller")` (act:7, act:8)
```
click role=button[name="Search patient"]     until: the header searchbox
fill  searchbox ""                            # start clean
type  searchbox "Miller"                      until: { request: "/ws/rest/v1/patient?q=", landed: true }
```
Debounced — `type` (keystrokes), not `fill`. **Two searchboxes exist on the service-queues dashboard**
(the header one and the table's "Filter table"), so `role=searchbox` alone matches 2; always use the
accessible name. Results come off the wire, not the DOM: `results[].uuid / person.display / identifiers[]`.

### Open a chart — `openChart(s, uuid)` (act:9, act:35)
Navigate to `/openmrs/spa/patient/<uuid>/chart/`, `until: any[{ request: fhir2/R4/Patient/<uuid>, landed },
{ selector: patient banner }]`. Identity is read from the FHIR `Patient`. The route redirects itself to
`/chart/patient-summary`.

### Read a chart tab — `openChartTab(s, uuid, tab)` (act:11–21)
Click `nav a[href$="/chart/<tab>"]`, `until: { request: <the tab's endpoint>, landed: true }`.

| Tab (route) | Endpoint it lands | Left-nav label |
|---|---|---|
| `patient-summary` | `fhir2/R4/Patient/<uuid>` (+ everything below, as cards) | Patient summary |
| `vitals-and-biometrics` | `fhir2/R4/Observation?subject:Patient=…&code=5085AAAA…` (vitals), `…code=5090AAAA…` (biometrics), `…code=165095AAAA…` (MUAC) | Vitals & Biometrics |
| `medications` | `rest/v1/order?…&orderTypes=131168f4-15f5-102d-96e4-000c29c2a5d7` (drug orders) | Medications |
| `orders` | `rest/v1/ordertype`, `rest/v1/order?…&activatedOnOrAfterDate=` | Orders |
| `results` | `rest/v1/obstree?patient=…&concept=<panel uuid>` ×3 | Results |
| `visits` | `rest/v1/visit?patient=…&limit=10&totalCount=true`, `rest/v1/encounter?…&order=desc&limit=20` | Visits |
| `allergies` | `fhir2/R4/AllergyIntolerance?patient=` | Allergies |
| `conditions` | `fhir2/R4/Condition?patient=…&category=…|problem-list-item&_count=100` | Conditions |
| `immunizations` | `fhir2/R4/Immunization?patient=` | Immunizations |
| `procedures` | *(not probed)* | Procedures |
| `programs` | `rest/v1/programenrollment?patient=`, `rest/v1/program` | Programs |
| `attachments` | `rest/v1/attachment?patient=` | Attachments |
| `appointments` | **`POST` `rest/v1/appointments/search`** — a read delivered as a POST | Appointments |
| `billing-history`, `growth-chart` | *(not probed)* | |

`conditions(s,uuid)`, `vitals(s,uuid)`, `visits(s,uuid)` are typed wrappers that parse those bodies.

### Home dashboards — `openHomeApp(s, name)` (act:23–28)

| Left-nav | Route | Lands |
|---|---|---|
| Service queues | `/home/service-queues` | `rest/v1/queue-entry?v=custom:(…)`, `rest/v1/queue-entry-metrics?metric=averageWaitTime` |
| Appointments | `/home/appointments` | `rest/v1/appointmentService/all/default`, `rest/v1/appointments?forDate=` |
| Laboratory | `/home/laboratory` | `rest/v1/order?orderTypes=52a447d3-… (Test Order)` ×7, one per tab/filter |
| Patient lists | `/home/patient-lists` | `rest/v1/cohortm/cohort?…&totalCount=true` |
| Wards | `/home/ward` | `rest/v1/admissionLocation/<location uuid>`, `rest/v1/emrapi/inpatient/admission`, `…/request` |
| Billing | `/home/billing` | `rest/v1/billing/bill?…&status=PENDING` |

App Menu (act:29) offers four more apps: **Dispensing** `/spa/dispensing`, **System Administration**
`/spa/system-administration`, **Fast Data Entry** `/spa/forms`, **Queue screen**
`/spa/home/service-queues/screen`.

### Patient lists — `patientLists(s)` / `openPatientList(s, uuid)` (act:31–33)
List of lists from `cohortm/cohort`; a list's page is `/home/patient-lists/<cohort uuid>` and its
members come from `cohortm/cohortmember?cohort=<uuid>&startIndex=0&limit=10&v=full`.
Tabs: Starred / System lists / My lists / All lists — a client-side filter, no new request.

### Clinical forms — `clinicalForms(s)` (act:36)
On a chart, the right rail has the workspace launchers: **Order basket, Visit note, Clinical forms,
Task list, Patient lists**. `role=button[name="Clinical forms"]` opens a side panel and fetches
`rest/v1/form?v=custom:(…)` (17 forms here) plus the patient's `rest/v1/encounter?…`. `Escape` closes it.
`lib.ts` reads the catalogue and closes the panel; **it never fills or submits a form.**

## 5. Write workflows

Nine tasks that change records, in the order a clinic day uses them. Each is a function in `lib.ts`
and a step in `check.ts`; each verifies itself by **re-reading the server**, never by the toast.
Act ids are run 6 of `apps/openmrs/store`.

| # | Workflow | Precondition | The button that persists | On the wire | Act |
|---|---|---|---|---|---|
| 1 | `registerPatient` | logged in, any screen | "Register patient" | `POST /ws/rest/v1/idgen/identifiersource/<uuid>/identifier` **201** then `POST /ws/rest/v1/patient/` **201** | act:255 |
| 2 | `startVisit` | on a chart, no active visit | "Start visit" | `POST /ws/rest/v1/visit` **201** | act:261 |
| 3 | `recordVitals` | on a chart | "Save and close" | `POST /ws/rest/v1/encounter` **201** (one `obs` per field) | act:272 |
| 4 | `addCondition` | on a chart | "Save & close" | `POST /ws/fhir2/R4/Condition` **201** | act:279 |
| 5 | `recordAllergy` | on a chart | "Save and close" | `POST /ws/rest/v1/patient/<uuid>/allergy` **201** | act:288 |
| 6 | `createPatientList` | Patient lists dashboard | "Create list" | `POST /ws/rest/v1/cohortm/cohort/` **201** | act:293 |
| 7 | `addPatientToList` | on a chart | "Save" | `POST /ws/rest/v1/cohortm/cohortmember` **201** | act:299 |
| 8 | `orderLabTest` | on a chart **with an active visit** | "Sign and close" | `POST /ws/rest/v1/encounter` **201**, body carries `orders:[{type:"testorder"}]` | act:309 |
| 9 | `addToQueue` | patient has an active visit | "Add patient to queue" | `POST /ws/rest/v1/visit-queue-entry` **201** | act:315 |

**Two facts that shape all of them.**

- **Read and write endpoints are not symmetric.** Conditions are read *and* written over FHIR.
  Allergies are read over FHIR (`AllergyIntolerance`) but written over REST
  (`/patient/<uuid>/allergy`). Orders are read from `/ws/rest/v1/order` but written as
  `orders[]` **inside an encounter** — there is no `POST /order`. Never assume the read URL takes a POST.
- **The client mints uuids.** `POST /ws/rest/v1/patient/` sends the `uuid` it wants for both the
  patient and the person. The identifier, by contrast, is reserved server-side first
  (`POST /idgen/…/identifier` returns e.g. `{"identifier":"1000KTP"}`) and then submitted with the patient.

### 1. Register a patient — `registerPatient(s)` (act:246 → act:255)
```
navigate /spa/patient-registration        until: role=textbox[name="First Name"]
fill "First Name" / "Family Name"
click role=radio[name="Female"]  { js: true }          # Carbon: a real click is `occluded`
fill day/month/year spinbuttons of "Date of birth"
fill "City/Village (optional)"  = "DISCOTEST <stamp>"  # the marker
click "Register patient"                  until: { request: "/ws/rest/v1/patient/", landed: true }
```
Postcondition: the URL is the **new** patient's chart, and the POST returned 201 with
`display: "1000KTP - Discotest Zzdiscotest"`. Verified by searching the server for the brand-new
identifier. Required fields: first name, family name, sex, date of birth. The identifier is
auto-generated; everything in §2 Contact Details and §3 Relationships is optional.

### 2. Start a visit — `startVisit(s)` (act:258 → act:261)
```
click "Actions"                           until: role=menuitem[name="Add visit"]
click menuitem "Add visit"                until: role=radio[name="Facility Visit"]
click role=radio[name="Facility Visit"] { js: true }
click "Start visit"                       until: { request: "/ws/rest/v1/visit", landed: true }
```
Request body is four fields: `{visitType, location, startDatetime:null, patient}`.
**The visit-location default is not the session location** — this deployment preselects
"Ubuntu Hospital" while the header says "Outpatient Clinic", which is why a newly-visited patient
does *not* appear in the Outpatient Clinic queue until workflow 9 puts them there.
Verified with `readVisits(s, uuid)`: the visit is present with `stopDatetime: null`.

### 3. Record vitals — `recordVitals(s)` (act:262 → act:272)
```
click "Record vital signs"                until: role=spinbutton[name="Temperature"]
fill  Temperature / systolic / diastolic / Pulse / Respiration rate / Oxygen saturation / Weight / Height
fill  "Notes" = "DISCOTEST synthetic vitals <stamp>"
click "Save and close"                    until: { request: "/ws/rest/v1/encounter", landed: true }
```
The request body is `{patient, obs:[{concept:"5085AAAA…",value:118}, …]}` — **one obs per filled
field, keyed by concept uuid**, with the free-text note as concept `165095AAAA…`. That is the
marker's home. Verified with `readEncounterObs(s, encounterUuid)`: systolic `118` and the
`DISCOTEST` note both come back from the server.
Input ids here are React-generated (`:r5d:-temperature`) and change every render — accessible names only.

### 4. Add a condition — `addCondition(s, "Headache")` (act:273 → act:279)
```
click "Record conditions"                 until: role=searchbox[name="Enter condition"]
type  "Headache"                          until: { request: "/ws/rest/v1/concept?name=", landed: true }
click role=menuitem[name="Headache"]      until: { gone: same }
fill  day/month/year of "Onset date"
click "Save & close"                      until: { request: "/ws/fhir2/R4/Condition", landed: true }
```
The typeahead is `GET /ws/rest/v1/concept?name=<q>&searchType=fuzzy&class=8d4918b0-…` (the Diagnosis
concept class). The write is a **FHIR Condition resource** with `subject.reference: "Patient/<uuid>"`
and `recorder.reference: "Practitioner/<user uuid>"`. A condition is a coded concept, so no marker
string fits in it; it is identifiable by hanging off a marked patient.

### 5. Record an allergy — `recordAllergy(s, uuid)` (act:281 → act:288)
```
(allergies tab)
click "Record allergy intolerances"       until: role=combobox[name="Allergen"]
click combobox "Allergen"                 until: role=option[name="ACE inhibitors"]
click option "ACE inhibitors"             until: { gone: same }
click role=checkbox[name="Rash"] { js: true }      # reaction
click role=radio[name="Mild"]   { js: true }       # severity
fill  "Comments" = "DISCOTEST synthetic allergy <stamp>"
click "Save and close"                    until: { request: "/allergy", landed: true }
```
Body: `{allergen:{allergenType:"DRUG",codedAllergen:{uuid}}, severity:{uuid}, comment, reactions:[{reaction:{uuid}}]}`.
Verified by re-reading `fhir2/R4/AllergyIntolerance` — the same record, over the other API.

### 6+7. Patient list, and putting a patient on it — `createPatientList` / `addPatientToList` (act:290 → act:299)
```
(Patient lists dashboard)  click "New list"   until: role=textbox[name="List name"]   # a WORKSPACE
fill "List name" = "DISCOTEST list <stamp>" ; fill the description
click "Create list"                       until: { request: "/ws/rest/v1/cohortm/cohort/", landed: true }

(on the chart)  click "Actions" -> menuitem "Add to list"   until: role=searchbox[name="Search for a list"]   # a MODAL
type the list name                        until: role=checkbox[name="<list name>"]
click that checkbox { js: true }
click "Save"                              until: { request: "/ws/rest/v1/cohortm/cohortmember", landed: true }
```
`cohortType` is posted as `""` and comes back `null` — the field is optional despite the label.
The add-to-list picker paginates at 5, so **filter by name rather than paging**.

### 8. Order a lab test — `orderLabTest(s)` (act:300 → act:309)
```
click "Order basket"                      until: role=button[name="Sign and close"]
click role=button[name="Add"] >> nth=1    until: role=searchbox[name="Search for a test type"]   # nth=1 = Lab orders
type  "Complete blood count"              until: { text: '1 result for "Complete blood count"' }
click "Order form"                        until: role=textbox[name="Reference number"]
fill  "Reference number" / "Additional instructions" = "DISCOTEST …"
click "Save order"                        until: { gone: role=button[name="Save order"] }
click "Sign and close"                    until: { request: "/ws/rest/v1/encounter", landed: true }
```
Signing the basket POSTs an **encounter that contains the orders** — `{patient, location, encounterType,
visit, obs:[], orders:[{action:"NEW", type:"testorder", concept, careSetting, orderer, instructions}]}`.
The POST's response `orders[]` is a *ref* representation (uuid/display/type only, **no `orderNumber`**);
re-read `/ws/rest/v1/order?patient=` for the number (`readOrders`).
Two traps, both real: "Sign and close" is **`disabled`** while any basket item is *Incomplete*
(disco says so in ~100 ms — act:304), and it is **visible the whole time**, so it can never be the
postcondition of "Save order".

### 9. Put a patient in a service queue — `addToQueue(s, identifier)` (act:311 → act:315)
```
(Service queues dashboard)
click "Add a patient to this list"        until: the workspace searchbox
type  the patient's CR Number             until: { request: "/ws/rest/v1/patient?q=", landed: true }
click role=button[name*="<identifier>"]   until: select:has(option:text-is("Outpatient Triage"))
select the Service <select>               until: role=radio[name="Not Urgent"]
click "Add patient to queue"              until: { request: "/ws/rest/v1/visit-queue-entry", landed: true }
```
One POST creates the queue entry **and** links it to the visit:
`{visit:{uuid}, queueEntry:{status, priority, queue, patient, startedAt, sortWeight}}`.
Address the patient by **identifier**, not by name — every run of this pack creates another
`Zzdiscotest` and a name search would match all of them.
The workspace only lists "checked-in patients" for the *session* location, so a patient whose visit
is at another location must be found through its search box (see workflow 2).

## 6. Interstitials and recovery

- **No *unsolicited* modal appeared in either session** — no "what's new", no session-expiry dialog,
  no allergy interstitial. Everything that overlays the page is something you opened.
- **Three overlay kinds, three different anchors.** Guessing wrong costs a whole budget, so learn them:

  | Kind | Looks like | Anchor | Closes with |
  |---|---|---|---|
  | **Workspace** | right-hand side panel: every "Record …" form, Start-a-visit, Order basket, New patient list, Add-patient-to-queue | `role=banner[name="Workspace header"]` | its "Close" button, or `Escape` |
  | **Modal** | centred Carbon dialog: **Add to list** only, so far | `role=dialog` | "Cancel" / `Escape` |
  | **Snackbar** | green toast, top-right: "New Patient Created", "Visit started", "Order placed" | `role=alertdialog` | auto, or "Close snackbar" |

  A snackbar is **never** a postcondition — it is the app's optimism, and disco's whole point is that
  you wait for the wire instead. Every write in §5 waits on its POST.
- The banner **Actions** menu (act:37, act:258) is the patient-level write surface. On a patient with
  no active visit it offers `Add to list · Edit patient details · Add visit · Mark patient deceased`;
  with an active visit it grows `End active visit · Delete active visit`. This pack uses
  *Add visit* and *Add to list* and touches none of the destructive ones.
- **Recovery from anywhere:** `goHome(s)` = `navigate(/openmrs/spa/home)` with
  `until: any[home anchor, login anchor]`; it throws with a clear message if the session bounced to
  login. `login(s)` is idempotent and works from any URL.
- Session expiry was not observed in ~50 minutes. If it happens it will show up as `authenticated:false`
  from `sessionInfo(s)`, not as a status code (§1).

## 7. Input recipes

- **Two-step login.** Username → `Continue` → password → `Log in`. The password field does not exist
  until `Continue` is pressed; `input[type=password]` is the postcondition.
- **Header search is debounced.** `fill(box,"")` then `type(box, term)` with
  `until: { request: "/ws/rest/v1/patient?q=", landed: true }`. `fill` alone also fires it, but `type`
  is what a human does and is what the debounce is tuned for.
- **Date pickers** (Orders tab, Laboratory, Appointments) are three `spinbutton`s (day/month/year) plus
  a calendar button, each with a long compound accessible name — address them by
  `role=spinbutton[name*="year, Start Date"]`, not by position. Not exercised here.
- **Every Carbon radio and checkbox needs `{ js: true }`.** Carbon hides the real `<input>` under a
  styled `<span class="cds--radio-button__appearance">`, so a real mouse click is diagnosed
  `occluded — role=radio[name="Female"] is covered by span.cds--radio-button__appearance` (act:249).
  `s.click(target, { js: true })` dispatches the DOM event and works every time; `lib.ts` wraps it as
  `tick()`. This applies to sex, visit type, allergy reactions, allergy severity and queue priority.
- **Carbon dropdown (`role=combobox`) vs native `<select>`.** The allergen picker is a *Carbon*
  combobox: click it, wait for `role=option`, click the option, wait for it to be `gone`. The queue's
  Service picker is a real `<select>`: `s.select(...)` works. Tell them apart in the aria tree —
  a native select prints its `option`s inline; the Carbon one only shows a `listbox` once opened.
- **Concept typeaheads** (condition, lab test) are debounced: `type`, with
  `until: { request: <the search endpoint>, landed: true }`, then click the `menuitem` /
  `Order form` button in the results.
- Nothing needed a drag, a canvas click, or a keyboard-only widget.

## 8. Gotchas

1. **Skeletons are real tables.** `/home/patient-lists/<uuid>` paints a complete `<table>` with empty
   `<td>`s and an `<h1>` of `--` before the data lands. `until: { selector: "table" }` resolves on the
   skeleton and you read nothing. Wait for `cohortm/cohortmember` instead.
2. **Headings on the summary page are already true.** `patient-summary` renders cards titled
   "Conditions", "Vitals", "Allergies"… so `role=heading[name="Conditions"]` holds *before* you click the
   Conditions tab. `reached()` caught this as `alreadyTrue`. Never use a chart heading as a
   postcondition — use the tab's request.
3. **`{ url }` arms lose the race.** Client-side routing flips `location.href` synchronously on click,
   so a `{ url: "/chart/conditions" }` arm wins instantly and you read a stale body. Wire arms only.
4. **SWR caching costs a whole budget.** `patient-summary` pre-fetches the Condition bundle, so opening
   the Conditions tab afterwards issues **no request at all** and a `{ request }` predicate burns its
   full timeout. `openChartTab` therefore checks the log first
   (`s.store.requests({ url: family, status: 200, run: s.run })`) and drops the budget to 4 s when the
   family has already answered in this run — 21 s → 4.6 s on that step.
5. **One tab, three requests of the same family.** The vitals tab fires three
   `fhir2/R4/Observation?subject:Patient=…` reads with different `code=` sets, so `latestJson("/Observation?")`
   is a coin flip and often returns the 513-byte MUAC bundle (`total: 0`). Select by `code=<concept uuid>`
   (`VITALS_CODES` / `BIOMETRICS_CODES` in `lib.ts`).
6. **A double slash in a real URL.** The Visits widget builds
   `https://dev3.openmrs.org/openmrs//ws/rest/v1/visit?patient=…`. Match on `ws/rest/v1/visit?patient=`,
   not on `/openmrs/ws/…`.
7. **`GET /session` is always 200.** Read `authenticated`. With a valid `JSESSIONID` the server ignores a
   bogus `Authorization: Basic` header entirely and still answers `authenticated: true`.
8. **Ambient traffic is heavy.** The service-queues dashboard lazily fetches one
   `rest/v1/patient/<uuid>`, one `rest/v1/visit?patient=`, one `rest/v1/person/<uuid>` and one
   `rest/v1/obs?patient=…&concept=736e8771…` **per row**. Any act performed while that dashboard is
   mounted shows 10–20 unrelated rows in its `wire` block. It is not your click.
9. **`role=` selectors match the accessible name as a substring** — `role=searchbox` alone matched 2
   elements on the queues dashboard (`report.matches` said so). Always name them.
10. **A button that is visible for the whole flow can never be a postcondition.** The order basket
    stays mounted behind the order form, so `role=button[name="Sign and close"]` is visible before and
    after "Save order" — `reached()` refused it as `alreadyTrue`. `{ gone: 'role=button[name="Save order"]' }`
    is the predicate that is actually false beforehand.
11. **`disabled` is a workflow fact, not a failure.** "Sign and close" is disabled until every basket
    item leaves the *Incomplete* state; disco diagnoses it in ~100 ms, which is how the order-form step
    was discovered (act:304). Read the diagnosis rather than adding a wait.
12. **POST responses are not full representations.** The encounter returned after signing orders lists
    `orders[]` as refs — `uuid`, `display`, `type`, and **no `orderNumber`**. Re-read
    `/ws/rest/v1/order?patient=` for anything the ref does not carry.
13. **`latestJson` is wrong for a write.** The app navigates on success, so GETs to the same endpoint
    family land inside the same act window and the "newest" body is a read, not your write. `lib.ts`
    uses `s.store.requests({ url, method: "POST", action, run })` and takes that row's body.
14. **Names are not unique; identifiers are.** Every run of this pack adds another
    `Discotest Zzdiscotest`. Anywhere the app asks you to pick a patient (the queue workspace), address
    them by CR Number.
15. **Empty-state pages are normal.** Most demo patients have no medications, allergies, immunizations,
    programs or attachments; those tabs render "There are no … to display" plus a `Record …` button, and
    the endpoint answers `{"results":[]}` (14 bytes, hash `5021e624e752b001` — the single most common
    body on the wire).

## 9. Open questions

- **Login location picker.** Other O3 deployments show a location chooser after the password step
  (`/spa/login/location`, fed by `fhir2/R4/Location?_tag=login location`). It never appeared here — the
  server session already had `Outpatient Clinic`. *Experiment:* `open` with `{ fresh: true }` (wipes the
  profile) and log in; watch for `Location?_tag=login`.
- **Session expiry / 401 handling.** Never observed. *Experiment:* delete the `JSESSIONID` cookie
  (`s.context.clearCookies()`), then `openChartTab` and read what the app does with the 401.
- **`procedures`, `billing-history`, `growth-chart` chart tabs** were not opened.
- **Write paths still not exercised:** the *Visit note* workspace (an encounter with a coded
  diagnosis), filling one of the 17 **clinical forms** (the form engine — likely the richest write
  surface in the app), **drug** orders (the basket's other half, with dose/frequency/route),
  **appointments**, **program enrollment**, **attachments** (file upload), and **billing**.
  Each is a workspace with the same shape as §5; the pattern is established.
- **Editing and ending.** `Edit patient details`, `End active visit`, transitioning a queue entry
  (the banner's "Move" button), and `Remove from list` were not driven — the stance was
  create-only. *Experiment:* run them against a `Zzdiscotest` patient this pack created.
- **Whether `POST /ws/rest/v1/visit` honours a `startDatetime`.** The app sends `null` and the server
  stamps now; the "In the past" tab of the start-visit workspace presumably sends a real one.
- **Pagination.** `cohortmember` is fetched with `limit=10` and visits with `limit=10&startIndex=0`;
  the paging control was not driven. *Experiment:* click the pager and diff `startIndex`.
- **`Fast Data Entry` / `Dispensing` / `System Administration` / `Queue screen`** apps were only seen in
  the App Menu, never opened.

## 10. Running this pack

```sh
node scripts/run-check.ts openmrs        # 15 steps, ~75 s: 6 read steps then 9 write steps
./disco open openmrs https://dev3.openmrs.org/openmrs/spa/login
./disco close openmrs                    # then run-check again for a cold run
```

**Every run writes.** One `Discotest Zzdiscotest` patient with a visit, a vitals encounter, a
condition, an allergy, a lab order and a queue entry, plus one `DISCOTEST list …` cohort. To find
everything this pack has ever created on the server:

```ts
const found = await o.findMarkedRecords(s);   // { patients: [...], lists: [...] }
```
or `GET /openmrs/ws/rest/v1/patient?q=Zzdiscotest`. Deleting them is a `DELETE` on each resource,
which this pack deliberately does not do.
Budgets: `SLOW = 20000` for anything that hits dev3 (a shared demo box; chart routes take 1–8 s and the
occasional 15 s), `PROBE = 1500` for anchor assertions. Do not raise them to fix a failing predicate —
every failure in this pack's history was a wrong predicate, not a slow server.
