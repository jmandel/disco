# wire.md — openmrs (dev3.openmrs.org)

Two APIs under one origin, one cookie:

| | |
|---|---|
| `/openmrs/ws/rest/v1/…` | **OpenMRS REST** (webservices.rest 3.5.0). Everything metadata- and workflow-shaped. Responses are `{ results: [...] }`; the client picks fields with `?v=custom:(a,b:(c))` or `?v=full`. |
| `/openmrs/ws/fhir2/R4/…` | **FHIR R4** (fhir2 4.2.0). Everything clinical the chart renders: Patient, Observation, Condition, AllergyIntolerance, Immunization, Location. Responses are `Bundle` (`entry[].resource`), `content-type: application/fhir+json`. |
| `/openmrs/spa/…` | static: the shell HTML, `importmap.json`, `routes.registry.json`, hashed JS/CSS chunks, `config-core_demo.json`. |

Auth: **cookie `JSESSIONID`** (`Path=/openmrs; HttpOnly`), obtained by one Basic-auth GET (below).
No bearer token, no CSRF header on reads. `s.evaluate("fetch('/openmrs/ws/…')")` therefore just works
and lands in the log; `lib.ts:api()` is that one line.

## Auth

| Endpoint | Carries |
|---|---|
| `GET /openmrs/ws/rest/v1/session` | **the login endpoint too.** With `Authorization: Basic base64(user:pass)` it authenticates and replies `set-cookie: JSESSIONID=…`. Without it, it is "who am I": `{authenticated, locale, allowedLocales, user:{uuid,display,userProperties,person}, privileges, roles[], sessionLocation, currentProvider}`. Anonymous body is 129 B (`f4aea521735410bd`); authenticated is 3.1 K (`92eb98e6952959a3`). |
| `DELETE /openmrs/ws/rest/v1/session` → **204** | logout (the UI's Logout button). |
| `POST /openmrs/ws/rest/v1/user/<uuid>?v=custom:(userProperties)` | **the only write the read-only tour triggers on its own** — the app persists `patientsVisited` / `starredPatientLists` in user properties when you open a chart. Unavoidable; it touches no clinical record. |

`user.userProperties` is a junk drawer of client state: `defaultLocale`, `lastLoginTimestamp`,
`defaultLocation`, `starredPatientLists`, `order_favorites_drugs` (a JSON string), and
`patientsVisited` (comma-separated patient uuids — the "recent search results" list).

## Patient identity

| Endpoint | Carries |
|---|---|
| `GET /openmrs/ws/rest/v1/patient?q=<text>&v=custom:(patientId,uuid,voided,identifiers,display,patientIdentifier:(uuid,identifier),person:(gender,age,birthdate,birthdateEstimated,personName,addresses,dead,deathDate),attributes)&limit=…` | **the header search.** One debounced request per query. `results[]`: `uuid` (the chart key), `display` = `"<identifier> - <name>"`, `person.personName.display`, `person.gender` (M/F), `person.age`, `person.birthdate`. Example body `8a26dc592fdc11be` (q=John, 8 hits, 26 K). |
| `GET /openmrs/ws/fhir2/R4/Patient/<uuid>?_summary=data` | the chart's demographics: `id`, `name[0].given/family`, `gender`, `birthDate`, `identifier[]` (`type.text` = "OpenMRS ID" / "CR Number"), `deceasedDateTime`. What `openChart()` returns. |
| `GET /openmrs/ws/rest/v1/patientidentifiertype?v=custom:(…)` · `metadatamapping/termmapping?code=emr.primaryIdentifierType` · `idgen/identifiersource` · `idgen/autogenerationoption` · `addresstemplate` · `relationshiptype` | registration metadata; fetched on **every** shell load whether or not you register anyone. Constant noise in every report. |

## The chart (all reads)

| Endpoint | Widget / tab |
|---|---|
| `GET /openmrs/ws/fhir2/R4/Condition?patient=<uuid>&category=…\|problem-list-item&_count=…` | Conditions (summary widget **and** the Conditions tab — the tab is served from the SWR cache) |
| `GET /openmrs/ws/fhir2/R4/AllergyIntolerance?patient=<uuid>&_summary=data` | Allergies tab + the banner's allergy flag. `entry[].resource.code.text`, `reaction[0].severity`, `reaction[0].manifestation[].text` |
| `GET /openmrs/ws/fhir2/R4/Observation?subject:Patient=<uuid>&code=5085,5086,5087,5088,5090,5089,5242,5242,1343,1342…&_sort=-date&_summary=data` | Vitals & Biometrics. Concept uuids are the classic CIEL numerics (`5085`=SBP, `5086`=DBP, `5087`=pulse, `5088`=temp, `5089`=weight, `5090`=height, `5242`=resp. rate). |
| `GET /openmrs/ws/rest/v1/obs?patient=<uuid>&concept=736e8771-e501-4615-bfa7-570c03f4bef5&v=full` | the **sticky note** obs (fired once per patient, everywhere, including for every "recent" patient in the search panel) |
| `GET /openmrs/ws/rest/v1/obs?patient=<uuid>&concept=165095AAAA…&v=custom:(…)` | patient-summary misc obs |
| `GET /openmrs/ws/rest/v1/visit?patient=<uuid>&v=custom:(uuid,display,voided,indication,startDatetime,stopDatetime,encounters:(…))` | the visit header ("Active Visit" pill) and the Visits tab |
| `GET /openmrs/ws/rest/v1/visit/<uuid>?v=custom:(…)` | one visit with its encounters/obs |
| `GET /openmrs/ws/rest/v1/order?patient=<uuid>&careSetting=6f0c9a92-…&orderTypes=131168f4-…&v=custom:(…)` | Medications / Orders |
| `GET /openmrs/ws/rest/v1/conceptreferencerange/?patient=<uuid>&concept=<uuids>&v=full` | the ↑/↓ arrows next to vitals (per-patient reference ranges) |
| `GET /openmrs/ws/rest/v1/concept/1114AAAA…?v=custom:(setMembers:(uuid,display,units))` | the vitals concept set (column headers + units) |
| `GET /openmrs/ws/rest/v1/systemsetting/visits.enabled?v=custom:(value)` | feature flag read on chart open |

## Home apps

| Endpoint | App |
|---|---|
| `GET /openmrs/ws/rest/v1/queue-entry?v=custom:(uuid,display,queue:(…),status:(…),patient:(…))&location=<loc>` | Service queues — the waiting list |
| `GET /openmrs/ws/rest/v1/queue-entry-metrics?metric=averageWaitTime&…` | the "Avg. wait time" tile |
| `GET /openmrs/ws/rest/v1/appointments?forDate=<iso>` · `appointmentService/all/default` | Appointments |
| `GET /openmrs/ws/rest/v1/cohortm/cohort?v=custom:(uuid,name,description,display,size,attributes,cohortType,location,…)` | Patient lists (a "patient list" **is** a cohort) |
| `GET /openmrs/ws/rest/v1/order?orderTypes=52a447d3-a64a-11e3-9aeb-50e549534c5e&v=custom:(…)` ×7 | Laboratory (one per tab: Tests ordered / In progress / Completed / Declined) |
| `GET /openmrs/ws/rest/v1/admissionLocation/<loc>?v=custom:(ward,totalBeds,occupiedBeds,bedLayout…)` · `emrapi/inpatient/admission` · `emrapi/inpatient/request` | Wards |
| `GET /openmrs/ws/fhir2/R4/Location?_summary=data&_tag=queue%20location` · `Location?_id=<loc>&_include:iterate=Location:partof` | the header's "Change location" picker |
| `GET /openmrs/ws/rest/v1/module?v=custom:(uuid,version)` | the server's module list — the cheapest "what is installed here" probe |

## Static / config

| Path | Carries |
|---|---|
| `GET /openmrs/spa/importmap.json` (5.5 K) | every `@openmrs/esm-*-app` microfrontend and its URL — the app's full feature inventory |
| `GET /openmrs/spa/routes.registry.json` (67 K, `2e9bdb67080775bf`) | **every route, extension slot and page in the SPA.** Read this instead of clicking around. |
| `GET /openmrs/spa/config-core_demo.json` (622 B) | this deployment's config overrides |

## Bodies worth citing by hash

| Hash prefix | What |
|---|---|
| `f4aea521735410bd` | anonymous `session` (`authenticated:false`) |
| `92eb98e6952959a3` | authenticated `session` — roles, sessionLocation, currentProvider, userProperties |
| `8a26dc592fdc11be` | `patient?q=John` — 8 hits, the full search row shape |
| `60ca4f861dbadb4c` | `AllergyIntolerance?patient=c6e4d203…` — one allergy (Bee stings / Moderate / Anaemia) |
| `2e9bdb67080775bf` | `routes.registry.json` |

## Not on the wire

Nothing important. This app is API-first: every fact the chart shows is in a JSON body in the log.
The only screen-only facts are computed ones — age in years, BMI, the ↑/↓ arrows, "wait time" —
and each of those has its inputs on the wire.
