# openmrs — the wire

Single origin: **`https://dev3.openmrs.org`**. No iframes, no WebSockets, no EventSource.
Two API families live under it, plus the SPA's own static config.

- `/openmrs/ws/rest/v1/…` — OpenMRS REST. `{ results: [...], totalCount? }`.
  Field selection is `?v=default | full | custom:(a,b:(c))`.
- `/openmrs/ws/fhir2/R4/…` — HL7 FHIR R4 façade. `Bundle` (`{ total, entry:[{resource}] }`),
  usually `?_summary=data` (which stamps every resource with a `SUBSETTED` meta tag).

Bodies are cited by `body_hash` prefix — `./disco body <prefix>` prints them.
All rows below are **GET / read** unless marked otherwise.

## Config and identity

| Endpoint | R/W | Carries | Cited |
|---|---|---|---|
| `GET /openmrs/spa/config-core_demo.json` | R | the deployment's micro-frontend config (which apps/tabs exist) | `8fb130b78d5b2284` |
| `GET /ws/rest/v1/session` | R | **the auth oracle.** `{authenticated, sessionId, user:{uuid,display,roles[]}, sessionLocation:{uuid,display}, currentProvider, locale, allowedLocales}` | anon `f4aea521735410bd` (129 B, `authenticated:false`) · admin `cdc3400db41e79f3` (3.1 K) |
| `GET /ws/rest/v1/session` + `Authorization: Basic base64(u:p)` | **W (session)** | the login. Response sets `Set-Cookie: JSESSIONID=…; Path=/openmrs; HttpOnly`. **Always 200** — read `authenticated` | act:5 |
| `GET /ws/rest/v1/module?v=custom:(uuid,version)` | R | installed OpenMRS modules + versions | `0034d54e26f6c3ec` |
| `POST /ws/rest/v1/user/<uuid>?v=custom:(userProperties)` | **W** | the app writing `recentlyViewedPatients` when you open a chart. Unavoidable side effect of chart navigation | act:9 |
| `GET /ws/rest/v1/patientidentifiertype?v=custom:(…)` · `addresstemplate` · `relationshiptype` · `metadatamapping/termmapping?code=emr.primaryIdentifierType` | R | registration/display metadata, fetched once per shell load | `822add7bb2cca816`, `90dc409d3d045d2f`, `4c2c80fc8265547e`, `9f807db760fdd897` |

## Patient identity and search

| Endpoint | Carries | Cited |
|---|---|---|
| `GET /ws/rest/v1/patient?q=<term>&v=custom:(patientId,uuid,identifiers,display,patientIdentifier:(…),person:(gender,age,birthdate,birthdateEstimated,personName,addresses,display,dead,deathDate),attributes:(…))` | header search results. Debounced, one call per pause | `Miller` → `744d661942874dd9` (7.1 K, 2 hits) |
| `GET /ws/fhir2/R4/Patient/<uuid>?_summary=data` | chart identity: `name[0]`, `gender`, `birthDate`, `identifier[]`, `address[]`, person-attribute extensions | `b4fa32d17bce1b9a` (1.4 K) |
| `GET /ws/rest/v1/person/<uuid>?v=custom:(causeOfDeath:(display),causeOfDeathNonCoded)` | the deceased flag on the banner; `{}`-ish 74 B when alive | `75d46e1ff6c0e218` |

## Chart tabs — one endpoint family each

| Tab | Endpoint | Cited |
|---|---|---|
| Vitals & Biometrics | `GET /ws/fhir2/R4/Observation?subject:Patient=<uuid>&code=5085…,5086…,5087…,5088…,5092…,5242…&_summary=data&_sort=-date&_count=100` (**vitals**) | `42a6259ce0631d20` (131 K, `total: 96`) |
| " | `…&code=5090…,5089…,1343…,1342…` (**biometrics**: height, weight, MUAC, BMI inputs) | `1ae8e25aa31a6ab0` (32 K) |
| " | `…&code=165095…&_sort=-date` (a single concept; **513 B, `total:0`** — the trap in README §7.5) | `cf28dd8cb09709e0` |
| " | `GET /ws/rest/v1/conceptreferencerange/?patient=<uuid>&concept=…&v=full` | `81fb6642e781997c` |
| " | `GET /ws/rest/v1/concept/1114…?v=custom:(setMembers:(uuid,display,units))` — units for the table headers | `d0b54d492bcc534a` |
| Medications | `GET /ws/rest/v1/order?patient=<uuid>&careSetting=6f0c9a92-6f24-11e3-af88-005056821db0&orderTypes=131168f4-15f5-102d-96e4-000c29c2a5d7&v=custom:(…drug:(uuid,display,strength,dosageForm),dose,doseUnits,frequency,route,duration,…)&excludeDiscontinueOrders=true` | empty here: `5021e624e752b001` |
| Orders | `GET /ws/rest/v1/ordertype` · `GET /ws/rest/v1/order?patient=…&activatedOnOrAfterDate=…&activatedOnOrBeforeDate=…` | `13750f9f4df03195` |
| Results | `GET /ws/rest/v1/obstree?patient=<uuid>&concept=<panel uuid>` ×3 (Hematology / Bloodwork / other) | `896e587b758d35c4`, `b413b674bdd913bd`, `6e289ecaed4f5577` |
| Visits | `GET /openmrs**//**ws/rest/v1/visit?patient=<uuid>&v=custom:(uuid,location,encounters:(…obs,orders,diagnoses,form,encounterType,encounterProviders…),visitType,startDatetime,stopDatetime,attributes)&limit=10&startIndex=0&totalCount=true` — **note the double slash** | `d33c7ed1c11d903e` (259 K) |
| " | `GET /ws/rest/v1/encounter?patient=<uuid>&v=custom:(…)&order=desc&limit=20&totalCount=true` ("All encounters" tab) · `GET /ws/rest/v1/encountertype` | `7b72b21594625947` (227 K), `0b825d82269465ff` |
| Allergies | `GET /ws/fhir2/R4/AllergyIntolerance?patient=<uuid>&_summary=data` | `723f6f03e14065c6` (empty bundle, 456 B) |
| Conditions | `GET /ws/fhir2/R4/Condition?patient=<uuid>&category=http://terminology.hl7.org/CodeSystem/condition-category\|problem-list-item&_count=100&_summary=data` | `b36054d623e10113` (22 K, `total: 16`) |
| Immunizations | `GET /ws/fhir2/R4/Immunization?patient=<uuid>&_summary=data` | `cbed16c92882dd30` |
| Programs | `GET /ws/rest/v1/programenrollment?patient=<uuid>&v=custom:(…states:(startDate,endDate,state:(concept:(display))))` · `GET /ws/rest/v1/program?v=custom:(uuid,display,allWorkflows,concept)` | `4f3c81ddaf1315c9` (12.5 K — the program catalogue) |
| Attachments | `GET /ws/rest/v1/attachment?patient=<uuid>&includeEncounterless=true` · `GET /ws/rest/v1/systemsetting?q=attachments.allowedFileExtensions` | `d032929c111e917f` |
| Appointments | **`POST` `/ws/rest/v1/appointments/search`** — a read delivered as a POST; JSON body is the date/patient filter | `eb386a9036f1f3f5` (1.3 K) |
| Summary extras | `GET /ws/rest/v1/billing/patientPaymentStatus/<uuid>` · `GET /ws/rest/v1/queue-entry?…&patient=<uuid>` · `GET /ws/rest/v1/systemsetting/visits.enabled?v=custom:(value)` | `0d4c9fb0392dfc01`, `42378806167bcc64` |

## Home dashboards

| Dashboard | Endpoint | Cited |
|---|---|---|
| Service queues | `GET /ws/rest/v1/queue-entry?v=custom:(uuid,display,queue:(uuid,display,name),status:(uuid,display),patient:(uuid,display,person:(uuid,display,age,birthdate,gender),identifiers),priority,…)` | `d6ab34ea7792a856` (29 K) |
| " | `GET /ws/rest/v1/queue-entry-metrics?metric=averageWaitTime&startedOnOrAfter=…&status=<uuid>&location=<uuid>` | `decf426ed34d0642` |
| " | `GET /ws/fhir2/R4/Location?_summary=data&_tag=queue%20location` · `…?_id=<uuid>&_include:iterate=Location:partof` | — |
| Appointments | `GET /ws/rest/v1/appointmentService/all/default` · `GET /ws/rest/v1/appointments?forDate=<ISO>` · `GET /ws/rest/v1/visit?includeInactive=false&v=custom:(uuid,patient:(uuid),startDatetime,stopDatetime)` | `4b505d9a67d93ccb`, `eeae9d8448b83141` |
| Laboratory | `GET /ws/rest/v1/order?orderTypes=52a447d3-a64a-11e3-9aeb-50e549534c5e&…` ×7 (one per tab: ordered / in progress / completed / declined) | `5021e624e752b001` |
| Patient lists | `GET /ws/rest/v1/cohortm/cohort?v=custom:(uuid,name,description,display,size,attributes,cohortType,location)&totalCount=true` | `cb0c543590a88a91` (3.9 K) |
| One list | `GET /ws/rest/v1/cohortm/cohort/<uuid>?v=custom:(…)` · `GET /ws/rest/v1/cohortm/cohortmember?cohort=<uuid>&startIndex=0&limit=10&v=full&q=` | act:33 |
| Wards | `GET /ws/rest/v1/admissionLocation/<location uuid>?v=custom:(ward,totalBeds,occupiedBeds,bedLayouts:(…))` · `GET /ws/rest/v1/emrapi/inpatient/admission?currentInpatientLocation=…` · `GET /ws/rest/v1/emrapi/inpatient/request?dispositionType=ADMIT,TRANSFER&…` | `cf2c7e3a2206b0e7` |
| Billing | `GET /ws/rest/v1/billing/bill?v=custom:(id,uuid,dateCreated,status,receiptNumber,patient,lineItems:(…))&pageSize=10&status=PENDING` | `f44b887600f26ef3` (4.7 K) |

## Workspaces

| Trigger | Endpoint | Cited |
|---|---|---|
| "Clinical forms" launcher | `GET /ws/rest/v1/form?v=custom:(uuid,name,display,encounterType:(…),version,published,retired,resources:(…))` — 17 forms | `41371aabd76c58a9` (10.7 K) |
| " | `GET /ws/rest/v1/encounter?v=custom:(uuid,encounterDatetime,encounterType,form,…)` — which forms this patient already has | `32eb95e546fa5393` |

## Ambient traffic (`action_id IS NULL`, or in *every* report)

While the **service-queues** dashboard is mounted it fetches, **per visible row**:
`patient/<uuid>?v=…`, `visit?patient=<uuid>`, `person/<uuid>?v=custom:(causeOfDeath…)`,
`obs?patient=<uuid>&concept=736e8771-e501-4615-bfa7-570c03f4bef5&v=full`. Ten rows → ~40 requests
that belong to no act of yours. `GET /ws/rest/v1/session` is also re-issued on most route changes.

## Bodies worth knowing by sight

| Hash | What |
|---|---|
| `5021e624e752b001` | `{"results":[]}` — 14 B. The most common body on this demo; every empty tab returns it |
| `4f53cda18c2baa0c` | `[]` — 2 B (the appointments list) |
| `cdc3400db41e79f3` | the authenticated `session` for `admin` @ Outpatient Clinic (roles: System Developer, Provider) |
| `f4aea521735410bd` | the anonymous `session` — `authenticated:false`, 129 B |

## Auth summary

```
GET /openmrs/ws/rest/v1/session          Authorization: Basic YWRtaW46QWRtaW4xMjM=
→ 200  Set-Cookie: JSESSIONID=…; Path=/openmrs; HttpOnly
→ {"authenticated":true,"user":{"display":"admin","roles":[{"display":"System Developer"},{"display":"Provider"}]},
   "sessionLocation":{"uuid":"44c3efb0-2583-4c80-a79e-1f756a03c0a1","display":"Outpatient Clinic"},
   "currentProvider":{"display":"admin - Super User"}}
```
Every later request is cookie-authenticated. **A wrong password also returns 200**; and once the cookie
exists, a deliberately corrupt `Authorization` header is ignored and the answer is still
`authenticated:true` (probed via `disco eval`; rows `r1-981` and `r1-982`, `action_id IS NULL`). The status code is never the verdict.

---

# The write side

Every row below was observed at least once with a **201** and its response re-read from the server.
Act ids are run 6. Nothing here is a guess: the request bodies are quoted from `requests.req_body`.

| # | Endpoint | Carries (request) | Response | Act |
|---|---|---|---|---|
| 1a | `POST /ws/rest/v1/idgen/identifiersource/<source uuid>/identifier` | `{}` — an empty body; the call *reserves* the next identifier | **201** `{"identifier":"1000KTP"}` (24 B, `cbbc771f2efa49ff`) | act:255 |
| 1b | `POST /ws/rest/v1/patient/` | **the client mints the uuid**: `{"uuid":"ba9fe922-…","person":{"uuid":<same>,"names":[{"preferred":true,"givenName":"Discotest","middleName":"","familyName":"Zzdiscotest"}],"gender":"F","birthdate":"1990-1-1","birthdateEstimated":false,"attributes":[],"addresses":[{"cityVillage":"DISCOTEST …"}],"dead":false},"identifiers":[{"identifier":"1000KTP","identifierType":"05a29f94-c0ed-11e2-94be-8c13b969e334","location":"44c3efb0-…","preferred":true}]}` | **201** 1.9 K `e1cec19ec02c1170` → `display:"1000KTP - Discotest Zzdiscotest"` | act:255 |
| 2 | `POST /ws/rest/v1/visit` | `{"visitType":"7b0f5697-…","location":"f47ac10b-58cc-4372-a567-0e02b2c3d479","startDatetime":null,"stopDatetime":null,"patient":"<uuid>"}` — `startDatetime:null` means *now*; **the location is the workspace's default (Ubuntu Hospital), not the session location** | **201** 1.3 K `f6a7cacd6fb651fa` | act:261 |
| 3 | `POST /ws/rest/v1/encounter` (vitals) | `{"patient":"<uuid>","obs":[{"concept":"5085AAAA…","value":118},{"concept":"5086AAAA…","value":76},{"concept":"5242AAAA…","value":16},{"concept":"5092AAAA…","value":98},{"concept":"5087AAAA…","value":72},{"concept":"5088AAAA…","value":37.2},{"concept":"165095AAAA…","value":"DISCOTEST synthetic vitals …"}]}` — **one obs per field, keyed by concept uuid**; the free-text note is concept `165095AAAA…` | **201** 3.9 K `d40adce1f320aefe` | act:272 |
| 4 | `POST /ws/fhir2/R4/Condition` | a FHIR resource: `{"resourceType":"Condition","clinicalStatus":{"coding":[{"system":".../condition-clinical","code":"active"}]},"code":{"coding":[{"code":"139084AAAA…","display":"Headache"}]},"onsetDateTime":"2026-08-15T00:00:00-05:00","recordedDate":"…","subject":{"reference":"Patient/<uuid>"},"recorder":{"reference":"Practitioner/<user uuid>"}}` | **201** 1.2 K `4808acec68d03e6f` | act:279 |
| 5 | `POST /ws/rest/v1/patient/<uuid>/allergy` | `{"allergen":{"allergenType":"DRUG","codedAllergen":{"uuid":"162298AAAA…"}},"severity":{"uuid":"1498AAAA…"},"comment":"DISCOTEST …","reactions":[{"reaction":{"uuid":"512AAAA…"}}]}` — **REST, although allergies are READ over FHIR** | **201** 1.6 K `ad2bd357a11d430b` | act:288 |
| 6 | `POST /ws/rest/v1/cohortm/cohort/` | `{"name":"DISCOTEST list …","description":"…","cohortType":"","location":"<session location>","startDate":"<ISO>","groupCohort":false,"definitionHandlerClassname":"org.openmrs.module.cohort.definition.handler.DefaultCohortDefinitionHandler"}` | **201** 919 B `297709cd585047a7` → new cohort `uuid` | act:293 |
| 7 | `POST /ws/rest/v1/cohortm/cohortmember` | `{"cohort":"<cohort uuid>","patient":"<patient uuid>","startDate":"<ISO with offset>"}` | **201** 988 B `edbd1aa8f883c858` | act:299 |
| 8 | `POST /ws/rest/v1/encounter` (orders) | `{"patient":"<uuid>","location":"<session location>","encounterType":"39da3525-afe4-45ff-8977-c53b7b359158","visit":"<visit uuid>","obs":[],"orders":[{"action":"NEW","type":"testorder","patient":"<uuid>","careSetting":"6f0c9a92-…","orderer":"<provider uuid>","encounter":null,"concept":"1019AAAA…","instructions":"DISCOTEST …"}]}` — **there is no `POST /order`; orders ride inside an encounter** | **201** 1.8 K `b5571d02e561c5f6`; `orders[]` comes back as **refs only** (`uuid`, `display`, `type` — no `orderNumber`) | act:309 |
| 9 | `POST /ws/rest/v1/visit-queue-entry` | `{"visit":{"uuid":"<visit uuid>"},"queueEntry":{"status":{"uuid":"51ae5e4d-…"},"priority":{"uuid":"f4620bfa-…"},"queue":{"uuid":"d692a223-…"},"patient":{"uuid":"<uuid>"},"startedAt":"<ISO>","sortWeight":0}}` — one call creates the entry *and* links it to the visit | **201** 8.8 K `7a92978e214d385d` | act:315 |
| — | `POST /ws/rest/v1/user/<uuid>?v=custom:(userProperties)` | the app's own bookkeeping: `recentlyViewedPatients`. Fires on **every chart open**, unavoidable | 200 | act:9 |

## Reads that support the write forms

| Endpoint | Feeds |
|---|---|
| `GET /ws/rest/v1/concept?name=<q>&searchType=fuzzy&class=8d4918b0-c2cc-11de-8d13-0010c6dffd0f&v=custom:(uuid,display)` | the **condition** typeahead (`class` = Diagnosis) |
| `GET /ws/rest/v1/concept/1748a953-d12e-4be1-914c-f6b096c6cdef?v=custom:(display,names,uuid,setMembers:(…))` | the **lab test** catalogue — 57 KB of `setMembers`, fetched once when the order panel opens |
| `GET /ws/rest/v1/concept/162552AAAA…?v=full` ×4 | the **allergen** groups (drug / food / environment / other) |
| `GET /ws/rest/v1/visittype` · `location?tag=Visit+Location` · `emrapi/locationThatSupportsVisits` · `systemsetting/visits.allowOverlappingVisits` | the **start-a-visit** workspace |
| `GET /ws/rest/v1/queue?v=custom:(…allowedPriorities,allowedStatuses…)` · `queue-entry-number?location=&queue=` | the **add-to-queue** workspace |
| `GET /ws/rest/v1/cohortm/cohorttype` | the **new list** workspace |
| `GET /ws/rest/v1/ordertype/52a447d3-a64a-11e3-9aeb-50e549534c5e` | the **order basket** (Test Order type) |
| `GET /ws/rest/v1/idgen/identifiersource` · `idgen/autogenerationoption` | which identifier source registration reserves from |

## Verifying a write off the wire

`lib.ts` never trusts the toast. Each write is confirmed by an independent GET issued from inside the
page (so it carries the cookie and lands in the log):

| Helper | Reads |
|---|---|
| `readVisits` | `GET /ws/rest/v1/visit?patient=&v=custom:(uuid,visitType,startDatetime,stopDatetime,location)` |
| `readEncounterObs` | `GET /ws/rest/v1/encounter/<uuid>?v=custom:(uuid,obs:(uuid,display,concept,value))` |
| `readConditions` | `GET /ws/fhir2/R4/Condition?patient=&_count=100&_summary=data` |
| `readAllergies` | `GET /ws/fhir2/R4/AllergyIntolerance?patient=&_summary=data` |
| `readOrders` | `GET /ws/rest/v1/order?patient=&careSetting=…&v=custom:(uuid,orderNumber,display,fulfillerStatus,instructions,orderType)` |
| `readQueueEntries` | `GET /ws/rest/v1/queue-entry?patient=&v=custom:(uuid,queue,status,priority,endedAt)` |
| `readListMembers` | `GET /ws/rest/v1/cohortm/cohortmember?cohort=&v=full` |
| `findMarkedRecords` | `GET /ws/rest/v1/patient?q=Zzdiscotest` + `GET /ws/rest/v1/cohortm/cohort` filtered by name |
