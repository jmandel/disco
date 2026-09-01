# openmrs — the wire

Origin: **`https://dev3.openmrs.org`** (everything, same-origin; no iframes, no WebSocket,
no SSE observed in 2 runs / ~140 acts).

Three families live under it:

| Prefix | What it is |
|---|---|
| `/openmrs/spa/…` | the SPA: a 3.3 KB HTML shell + one ES module per microfrontend (`openmrs-esm-<name>-app-<version>/…js`) + `config-core_demo.json` |
| `/openmrs/ws/rest/v1/…` | the **OpenMRS REST API** — the app's native API. Collections answer `{"results":[…]}`; `?v=custom:(a,b,c:(d))` selects the projection; `?limit=&startIndex=&totalCount=true` paginates |
| `/openmrs/ws/fhir2/R4/…` | the **FHIR R4 facade** (`fhir2` module). Answers FHIR `Bundle` `type:"searchset"` with `total` and `entry[].resource`; `_summary=data` strips narrative |

Bodies are cited by `body_hash` prefix — `./disco body --app openmrs <prefix>` prints them.
The empty-collection body `{"results":[]}` is `5021e624e752` (14 B) and shows up everywhere;
`4f53cda18c2b` is `[]` (2 B).

## Auth

| Endpoint | R/W | Carries |
|---|---|---|
| `GET /openmrs/ws/rest/v1/session` | read | the whole identity. With `Authorization: Basic base64(user:pass)` it **is** the login call and the response sets `JSESSIONID=…; Path=/openmrs; HttpOnly`. `24cd60f44e47` (3.1 KB): `{"authenticated":true,"user":{"uuid":"82f18b44-…","display":"admin","systemId":"admin","userProperties":{…},"roles":[{"display":"System Developer"},{"display":"Provider"}]},"sessionLocation":{"uuid":"44c3efb0-…","display":"Outpatient Clinic"},"currentProvider":{"display":"admin - Super User"}}` |
| `DELETE /openmrs/ws/rest/v1/session` | **write** | logout → `204`, cookie invalidated (act:79) |

* The app sends `Disable-WWW-Authenticate: true` on the login call so a 401 does not raise
  Chromium's native basic-auth dialog.
* **Wrong credentials still return HTTP 200** with `authenticated:false`. The status code is not
  the signal; the body is (and in the UI, the `[role=status]` toast).
* `POST /openmrs/ws/rest/v1/user/<uuid>` — the only write this pack ever causes: opening a chart
  appends the patient to the `patientsVisited` user property (act:8).

## Configuration / metadata (fetched on every full page load)

| Endpoint | Carries |
|---|---|
| `GET /openmrs/spa/config-core_demo.json` | `8fb130b78d5b` (622 B) — the whole frontend config: which extension slots each app fills, `labTableColumns`, brand colour |
| `GET /openmrs/ws/rest/v1/module?v=custom:(uuid,version)` | `0034d54e26f6` — installed backend modules (tells you which features exist) |
| `GET /openmrs/ws/rest/v1/patientidentifiertype?v=custom:(…)` | `822add7bb2cc` — identifier types (`CR Number` is the primary one on dev3) |
| `GET /openmrs/ws/rest/v1/metadatamapping/termmapping?v=full&code=emr.primaryIdentifierType` | `9f807db760fd` — which identifier type is "primary" |
| `GET /openmrs/ws/rest/v1/addresstemplate`, `relationshiptype`, `idgen/autogenerationoption`, `idgen/identifiersource` | registration form metadata; issued on *every* shell load, not only on the registration route |
| `GET /openmrs/ws/rest/v1/systemsetting/visits.enabled?v=custom:(value)` | `afffb49646bc` |

## Patient

| Endpoint | Carries |
|---|---|
| `GET /openmrs/ws/rest/v1/patient?q=<q>&v=custom:(patientId,uuid,identifiers,display,person:(gender,age,birthdate,birthdateEstimated,personName,addresses,display,dead,deathDate))` | **patient search** (name *or* identifier). `{"results":[…]}`; `q=1000` → 10 hits, `q=Miller` → 2, `q=a` → 0 |
| `GET /openmrs/ws/fhir2/R4/Patient/<uuid>?_summary=data` | the chart's demographics. `b4fa32d17bce` (1.4 KB): `name[0].text`, `gender`, `birthDate`, `identifier[].value`, `address`, `deceasedDateTime?` |
| `GET /openmrs/ws/rest/v1/patient/<uuid>?v=custom:(…)` | the REST projection the *recent-searches* list renders from |
| `GET /openmrs/ws/rest/v1/person/<uuid>?v=custom:(causeOfDeath:(display),causeOfDeathNonCoded)` | `75d46e1ff6c0` (74 B) — the banner's deceased tag |

## Chart tabs → the request each one is fed by

| Tab (`/patient/<uuid>/chart/<tab>`) | Request | Body |
|---|---|---|
| `patient-summary` | all of the widgets below at once | — |
| `vitals-and-biometrics` | `GET /ws/fhir2/R4/Observation?subject:Patient=<uuid>&code=5085,5086,5087,5088,5092,5242…&_summary=data&_sort=-date&_count=100` (BP/pulse/temp/SpO2) and a second call for `5090,5089,1343,1342` (height/weight/MUAC) | `38237822c0a9` (162 KB), `37121cd6e2ae` (32 KB) — FHIR searchset of `Observation` |
| `medications` | `GET /ws/rest/v1/order?patient=<uuid>&careSetting=6f0c9a92-…&orderTypes=131168f4-…&v=custom:(…drug:(…),dose,doseUnits,frequency,route…)&excludeDiscontinueOrders=true` | `{"results":[…]}` |
| `results` | `GET /ws/rest/v1/obstree?patient=<uuid>&concept=<panel uuid>` (one call per panel: Bloodwork `ae485e65-…`, etc.) | `b413b674bdd9` — a nested `{display, subSets:[…], obs:[], datatype, lowNormal, hiNormal, units}` tree |
| `visits` | `GET /openmrs//ws/rest/v1/visit?patient=<uuid>&v=custom:(uuid,location,encounters:(…obs:(…),orders:full…),visitType,startDatetime,stopDatetime,attributes)&limit=10&startIndex=0&totalCount=true` — **note the double slash** after `/openmrs` | `d33c7ed1c11d` (259 KB) |
| | `GET /ws/rest/v1/encounter?patient=<uuid>&v=custom:(…)&order=desc&limit=20` | `7b72b2159462` (227 KB) |
| `allergies` | `GET /ws/fhir2/R4/AllergyIntolerance?patient=<uuid>&_summary=data` | `3058585a6460` — searchset Bundle, `total:0` for a patient with no allergies |
| `conditions` | `GET /ws/fhir2/R4/Condition?patient=<uuid>&category=…\|problem-list-item&_count=100&_summary=data` | `494cfd53051d` (22 KB, `total:16`): `entry[].resource.code.text`, `.clinicalStatus.coding[0].code`, `.onsetDateTime`, `.recordedDate` |
| `immunizations` | `GET /ws/fhir2/R4/Immunization?patient=<uuid>&_summary=data` | `ef73a7830e12` |
| `procedures` | `GET /ws/rest/v1/procedure?patient=<uuid>&v=full&startIndex=0&limit=10&totalCount=true` | `81f0a4bf82c6` (29 B) — **REST, not FHIR `Procedure`** |
| `attachments` | `GET /ws/rest/v1/attachment?patient=<uuid>&includeEncounterless=true` | |
| `programs` | `GET /ws/rest/v1/programenrollment?patient=<uuid>&v=custom:(…states:(…))` + `GET /ws/rest/v1/program?v=custom:(uuid,display,allWorkflows,concept:(uuid,display))` (`4f3c81ddaf13`, 12.5 KB) | |
| `appointments` | `POST /ws/rest/v1/appointments/search` with `{"patientUuid":"<uuid>","startDate":"<ISO>"}` → `eb386a9036f1` | the only POST-as-read in the app |
| `billing-history` | `GET /ws/rest/v1/billing/bill?v=full&patientUuid=<uuid>` | |
| (banner) | `GET /ws/rest/v1/billing/patientPaymentStatus/<uuid>` → `0d4c9fb0392d`; `GET /ws/rest/v1/queue-entry?…&patient=<uuid>` for the queue tag | |
| (vitals widget) | `GET /ws/rest/v1/conceptreferencerange/?patient=<uuid>&concept=5085,…&v=full` → `bdfb12eff5c6` — the normal ranges the ↑/↓ arrows come from | |

## Home apps

| App (`/spa/home/<app>`) | Request | Body |
|---|---|---|
| `service-queues` | `GET /ws/rest/v1/queue-entry?v=custom:(uuid,display,queue:(…),status:(…),patient:(…identifiers…),visit:(…),priority,startedAt…)&…` — **twice per load**, once per section | `d6ab34ea7792` (29 KB, the attending rows) and `81f0a4bf82c6` (29 B, the empty waiting list). Also `queue-entry-metrics?metric=averageWaitTime…` → `decf426ed34d`, and `GET /ws/fhir2/R4/Location?_summary=data&_tag=queue%20location` |
| `appointments` | `GET /ws/rest/v1/appointments?forDate=<ISO with tz>` (`4f53cda18c2b` = `[]` today) · `GET /ws/rest/v1/appointmentService/all/default` (`4b505d9a67d9`) · `GET /ws/rest/v1/visit?includeInactive=false&v=custom:(uuid,patient:(uuid),startDatetime,stopDatetime)` | |
| `patient-lists` | `GET /ws/rest/v1/cohortm/cohort?v=custom:(uuid,name,description,display,size,attributes,cohortType,location:(…))` → `cb0c543590a8` | a **patient list is a cohort** |
| `patient-lists/<uuid>` | `GET /ws/rest/v1/cohortm/cohort/<uuid>?v=custom:(…)` (`680d947b15d5`) + `GET /ws/rest/v1/cohortm/cohortmember?cohort=<uuid>&startIndex=0&limit=10&v=full` (`9f17b80066be`, 22 KB) | members are `results[].patient` |
| `laboratory` | `GET /ws/rest/v1/order?orderTypes=52a447d3-a64a-11e3-9aeb-50e549534c5e&v=custom:(uuid,orderNumber,patient:(…),…)` — one call per worklist tab (Tests ordered / In progress / Completed / Declined) | `52a447d3-…` is the **Test** order type (`GET /ws/rest/v1/ordertype/52a447d3-…` → `8db2c5fe4cac`) |
| `ward` | `GET /ws/rest/v1/admissionLocation/<location uuid>?v=custom:(ward,totalBeds,occupiedBeds,bedLayouts:(…))` (`cf2c7e3a2206`) · `GET /ws/rest/v1/emrapi/inpatient/admission?currentInpatientLocation=<uuid>` · `…/inpatient/request?dispositionType=ADMIT,TRANSFER` | |
| `billing` | `GET /ws/rest/v1/billing/bill?v=custom:(id,uuid,dateCreated,status,receiptNumber,patient:(uuid,display)…)` → `f44b887600f2` | |

## Workspaces / forms

| Endpoint | Carries |
|---|---|
| `GET /ws/rest/v1/form?v=custom:(uuid,name,display,encounterType:(uuid,name),version,published,retired,resources:(uuid,name,dataType,valueReference))` | `41371aabd76c` (10.7 KB) — the "Clinical forms" workspace list |
| `GET /ws/rest/v1/encountertype` | `0b825d822694` (4.7 KB) |

## Useful queries against the log

```sql
-- the endpoint map for one act
SELECT method, url, status, body_size FROM requests WHERE action_id='act:33' ORDER BY t_start;
-- everything this run fetched about one patient
SELECT method, path, status, body_size FROM requests
 WHERE run=2 AND url LIKE '%32351061-0a24-4fc2-a3d3-0251870330d2%' ORDER BY t_start;
-- where did a name on screen come from?
SELECT r.method, r.path, r.status FROM bodies_fts f JOIN bodies b ON b.rowid=f.rowid
 JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH '"Barbara Miller"';
-- what the app does with nobody driving it (polling? none observed)
SELECT t_start, method, path, status FROM requests WHERE action_id IS NULL AND run=2 ORDER BY t_start;
```
