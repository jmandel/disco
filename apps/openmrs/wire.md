# OpenMRS O3 — where the facts live

Every row was observed in this pack's store (run 2 unless noted); re-query any of them with
`bun cli/disco.ts sql openmrs "SELECT … FROM requests WHERE url LIKE '%<family>%'"`.
Host prefix throughout: `https://dev3.openmrs.org/openmrs`.

## The two APIs

O3 talks to **two** back-end APIs on the same session cookie:

- **`/ws/rest/v1/…`** — the OpenMRS REST API. Query-string **projection language**:
  `?v=custom:(uuid,display,person:(gender,age,birthdate))`, plus `limit` / `startIndex` / `totalCount`.
- **`/ws/fhir2/R4/…`** — FHIR R4, returning `Bundle`s (`entry[].resource`). **The chart's clinical facts
  are here.**

Rule of thumb the flows use: *identity and workflow* come from REST, *clinical content* from FHIR.

## Endpoint families

| Family | Carries | R/W | Used by |
|---|---|---|---|
| `GET /ws/rest/v1/session` | `{authenticated, user:{uuid,display,roles[]}, sessionLocation, currentProvider, locale}` — the app's own auth probe | read | login; re-read on most route changes (SWR). **Never mark ambient**: it fires *with* actions. |
| `GET /ws/rest/v1/session` (Basic auth header) | the login handshake itself — **there is no login POST** | read | `login` |
| `DELETE /ws/rest/v1/session` | logout | **write** (session only) | `logout` |
| `GET /ws/rest/v1/patient?q=&v=custom:(…)&includeDead=false&limit=10\|50&totalCount=true` | **patient search** — `{results:[…], totalCount}`; each result has `uuid`, `display` ("100010X - Michelle Lewis"), `patientIdentifier.identifier`, `person.{gender,age,birthdate,personName.display}` | read | `findPatient`. Overlay asks `limit=10`; the `/spa/search` results page asks `limit=50` and pages further on scroll. |
| `GET /ws/rest/v1/patient/<uuid>` | one patient (identity) | read | the search overlay's "recent results" list |
| `GET /ws/fhir2/R4/Patient/<uuid>` | banner demographics | read | patient banner |
| `GET /ws/fhir2/R4/Condition?patient=<uuid>&category=…\|problem-list-item&_count=100&_summary=data` | **problem list** — `entry[].resource.code.text`, `clinicalStatus.coding[0].code` (`active`/`inactive`) | read | `extractSummary().problems` (Michelle Lewis: 33) |
| `GET /ws/fhir2/R4/AllergyIntolerance?patient=<uuid>` | **allergies** — `code.text`, `reaction[].manifestation` | read | `extractSummary().allergies`. **Only fetched on the Allergies section**, not on the summary dashboard. |
| `GET /ws/fhir2/R4/Observation?subject:Patient=<uuid>&code=<concept-uuid,…>&_sort=-date&_summary=data` | **vitals & biometrics** — `code.coding[0].display`, `valueQuantity.{value,unit}`, `effectiveDateTime`. Three separate calls: one single-code, one vital-signs panel (temp/SBP/DBP/pulse/RR/SpO2), one biometrics panel (weight/height/MUAC) | read | `extractSummary().vitals` / `latestVitals` (Lewis: 90 + 30 entries) |
| `GET /ws/rest/v1/order?patient=<uuid>&careSetting=<uuid>&orderTypes=<drugorder uuid>&v=custom:(…)` | **medications** — `drug.display`, `dose`, `doseUnits.display`, `frequency.display`, `route`, `orderNumber`, `action` (NEW/RENEW/DISCONTINUE), `dateActivated`, `dateStopped`, `autoExpireDate` | read | `extractSummary().medications` |
| `GET /ws/rest/v1/visit?patient=<uuid>&v=custom:(…)` | **visits**. Two different projections: the banner's returns only the **active** visit (n=1); the Visits section's returns the **history** with `encounters[]` + `diagnoses` (n=10 for Lewis). The section's URL really does contain a double slash — `/openmrs//ws/rest/v1/visit` | read | `listVisits` (take the richest body) |
| `GET /ws/rest/v1/encounter?patient=<uuid>&…` / `GET /ws/rest/v1/encountertype` | encounters + their types | read | Visits section, "All encounters" tab |
| `GET /ws/rest/v1/conceptreferencerange/?patient=<uuid>` | vitals reference ranges (drives the "abnormal" flags) | read | vitals widgets |
| `GET /ws/rest/v1/billing/patientPaymentStatus/<uuid>` | `PAID` / `UNPAID` — the banner's billing tag | read | patient banner |
| `GET /ws/rest/v1/obs?patient=<uuid>&concept=736e8771-…&v=full` | one queue/triage concept per patient | read | **both** the queue dashboard's 60s poll **and** every patient-search result row — so it cannot be ambient-ruled by URL (see nav-and-quirks §2) |
| `GET /ws/rest/v1/queue-entry…`, `GET /ws/rest/v1/queue-entry-metrics` | service-queue dashboard rows/metrics | read | home dashboard; **60.0s poll → ruled ambient** |
| `GET /ws/fhir2/R4/Location?_summary=data&_tag=queue%20location` | queue locations | read | home dashboard; **60.0s poll → ruled ambient** |
| `GET /ws/rest/v1/systemsetting/<key>`, `metadatamapping/termmapping`, `patientidentifiertype`, `idgen/*`, `addresstemplate`, `relationshiptype`, `module`, `concept/<uuid>` | configuration & metadata, fetched once per app load | read | shell + registration app |
| `GET /spa/importmap.json`, `/spa/routes.registry.json`, `/spa/config-core_demo.json` | the micro-frontend import map, route registry and runtime config | read | app shell |
| **`POST /ws/rest/v1/user/<uuid>?v=custom:(userProperties)`** | **the only non-GET the flows cause.** Rewrites the logged-in user's `userProperties`: `patientsVisited` (the recently-viewed MRU, one uuid per chart open), plus `defaultLocale`, `defaultLocation`, `starredPatientLists`, `order_favorites_drugs` echoed back | **write** (user preference; **no patient data**) | fired by the app on chart open — see nav-and-quirks §7 and the stance note in `lib.ts` |

## The read-POST pass (GUIDANCE §8)

**Done, and the answer is "there are none."** Across every run in this store: **1258 GET, 5 POST**
(`SELECT method, count(*) FROM requests GROUP BY method`). Three of the POSTs are Cloudflare's
`challenge-platform` beacons from run 1 (the bot wall on `o3.openmrs.org`); the other two are the
`userProperties` write above, which disco's write-flag correctly reported as `write_kind=write`.
So **`--mark-read` was never needed**: unlike OpenEMR, O3 delivers no read over POST, and the write flag
is meaningful as-is. That is a finding, not an omission — an all-GET read surface is what makes
`extractFromWire` so cheap here.

## No standing channels

`ws_frames` and `sse_events` are both **empty** for every run: no WebSocket, no EventSource, no long-poll.
All liveness is plain interval polling (the 60s dashboard refresh). Nothing about attribution depends on
content-matching a standing channel.

## Bodies worth citing (run 2)

| Handle (blob prefix) | What |
|---|---|
| `358deeb0051be8ba` | `GET /ws/rest/v1/session` — admin, roles `System Developer` + `Provider`, `sessionLocation` "Outpatient Clinic" |
| `6176465025888dd5` | `Condition` bundle for Michelle Lewis — `total: 33` |
| `5abc679c2f830e61` | `Observation` bundle, vital-signs panel — 90 entries, latest 2026-07-19T14:57 |
| `bde1f07dbb52af9e` | `Observation` bundle, biometrics — 30 entries (Weight 84 kg, Height 189 cm) |
| `2c20e177e102298f` | `order` — 2 drug orders (RENEW 2026-08-25, NEW 2026-07-23) |
| `78a118afb9a96931` | `visit` history for Lewis — 10 visits, latest `Facility Visit` 2026-08-25 |
| `432f738bbfda48cc` | `patient?q=1000&limit=50` — `totalCount: 373`, the paging case |
