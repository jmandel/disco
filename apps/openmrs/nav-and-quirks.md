# OpenMRS O3 — navigation & quirks

Instance #4 of the pack series. Everything here was observed through disco against the **public demo**
build; every claim cites an act id (`act:N`, this pack's `store/`, run 2 unless noted) or a store query.
Observed = seen in a report/body. Inferred = reasoned from the product, not directly seen; marked *(inferred)*.

## 0. Session contract

| | |
|---|---|
| **Target** | OpenMRS O3 Reference Application 3.x, `https://dev3.openmrs.org/openmrs/spa` |
| **Host note** | The job named `o3.openmrs.org`. **It is Cloudflare-gated**: `session new --launch --headless` there attached to a bot challenge (`title "Just a moment..."`, disco's own instrument-step detector said so — run 1). Switched to `dev3.openmrs.org`, the same O3 build, which serves headless browsers directly. |
| **Roles** | `admin` / `Admin123` → roles **System Developer + Provider** (`GET /ws/rest/v1/session`, run 2). A second, lower-privilege role was probed — see §9. |
| **Stance** | **Read-only.** No form that persists was submitted: no orders, notes, demographics edits, visit start/stop, queue changes. Reads delivered over POST would have been fine; the app makes none (§ wire.md). |
| **Data posture** | Synthetic demo data on a public OpenMRS demo server. No PHI. |
| **Budget** | ~25 min of driving; depth over breadth. |
| **Done means** | login · findPatient (past page 1, read off the wire) · openPatient · extractSummary (problems/allergies/meds/latest vitals) · list visits + latest visit date/type off the wire; ≥3 patients in the ledger; `bun scripts/run-check.ts openmrs` green. |

## 1. Architecture (observed)

**One page, no frames.** `disco targets` after launch shows a single target with a single frame
(`https://dev3.openmrs.org/openmrs/spa/login`) — no iframes anywhere in the flows below, no cross-origin
islands, no shadow DOM in the paths driven, no canvas. This is the opposite of the OpenEMR pack's nested
`dynamic_finder.php` / `demographics.php` world: **no `frame:` argument is needed anywhere in `lib.ts`.**

**A micro-frontend SPA.** The shell is `openmrs-esm-app-shell` loading an **import map**
(`GET /openmrs/spa/importmap.json`, `routes.registry.json`) of independently versioned ESM apps —
`openmrs-esm-primary-navigation-app-10.0.1`, `-patient-search-app-11.1.1`, `-patient-chart-app`,
`-service-queues-app`, `-billing-app`, `-laboratory-app` … Each route change lazily loads that app's JS
chunks, so **the first visit to a route is chunk-heavy and slow; the second is not** (measured: first
chart open 5.6 s vs. later sections sub-second — §5). UI kit is **Carbon Design System** (`cds--*`
classes); ids like `#username`/`#password` exist on the login form, but inside the app the stable handles
are **ARIA roles/names and `data-testid`**, not ids (§4 selector strategy).

**Routing** is client-side under `/openmrs/spa/…` (`react-router`); `location.pathname` is the cheapest
anchor predicate and it is *always* correct after a transition (no hash routing, no `#`).

**Two APIs, side by side** (full table in `wire.md`):
- `/openmrs/ws/rest/v1/…` — the OpenMRS REST API, with a projection language in the query string
  (`?v=custom:(uuid,display,person:(uuid,age,gender))`). Session, patient search, visits, queues.
- `/openmrs/ws/fhir2/R4/…` — FHIR R4. `Condition`, `AllergyIntolerance`, `MedicationRequest`,
  `Observation`, `Location`, `Patient`. **The chart's clinical facts are FHIR bundles.**

**Auth = a servlet session cookie.** `GET /ws/rest/v1/session` returns
`{authenticated, user:{uuid,display,roles:[…]}, sessionLocation, currentProvider, locale}` and is the
app's own "am I logged in" probe; it is re-read on route changes (SWR revalidation), which is why it must
**not** be classified ambient (§2). Login itself is `GET /ws/rest/v1/session` with a Basic auth header —
**there is no login POST** (observed: zero POSTs in the whole run — see `wire.md`). Logout is
`DELETE /ws/rest/v1/session`. No bearer token, no refresh, no `Authorization` header after login.

## 2. Ambient traffic, and the rules the pack registers

**The heartbeat is 60.0 s and the classifier cannot learn it in a sane warm-up.** The service-queues home
dashboard refreshes three families on one timer; measured inter-arrival gaps, no action window open
(run 2, `t_start` 81.5 s → 141.5 s):

| family | gap |
|---|---|
| `GET /ws/rest/v1/queue-entry` | 60 051 ms |
| `GET /ws/rest/v1/obs?…concept=736e8771…` | 60 001 ms |
| `GET /ws/fhir2/R4/Location?…_tag=queue location` | 60 003 ms |

`disco idle 150000` (2.5 cycles) reported **"133 families, 0 ambient"** — the ambient rule needs ≥3
samples, so a 60 s heartbeat needs **≥4 minutes** of idle. Rather than pay that, the pack states the
conclusion as rules (`lib.ts::registerRules`, called from `login`, so every run starts right):

| rule | why | evidence |
|---|---|---|
| `ignore("queue-entry")` | dashboard poll (`queue-entry` + `queue-entry-metrics`) | 60 051 ms gap, idle window |
| `ignore("_tag=queue")` | dashboard poll (FHIR queue `Location`) | 60 003 ms gap, idle window |
| `mute("toast", text "loading"/"Loading")` | every lazily-loaded micro-frontend raises a Carbon "Loading…" toast; 38 toast-sentinel firings in run 2, none of them information | act:4, act:23, act:30 |
| `mute("error", url "$SPA_PATH")` | **every full page load** 404s on `GET /openmrs/spa/$SPA_PATH/icon_144x144….png` — an un-substituted template literal in the manifest, an app bug, not a signal | act:1, act:8 |

**A rule deliberately NOT registered** (this is the interesting one): `obs?…&concept=736e8771-…` *looks*
like the third leg of the poll, and I did mark it ambient at first — then act:16's report showed the
**patient-search results list firing the identical URL once per row**, i.e. an action's own traffic
tagged `attribution=ambient`. The URLs are byte-identical, so no URL-substring rule can separate them.
The rule was removed (`disco rules --remove 2`); the poll is left attributed and the dashboard is simply
left behind after login. *This is the "a request that fired with your action is tagged ambient" case from
the field guide, met in the wild.*

## 3. Anchors (cheap predicates)

| Anchor | URL | Landmark | `lib.ts` |
|---|---|---|---|
| **login** | `/openmrs/spa/login` | `#username` visible | `assertLoginPage` |
| **shell** | any `/openmrs/spa/…` that is not `/login` | `[data-testid="searchPatientIcon"]` **or** the search-panel input **or** `button[aria-label="App Menu"]` | `assertShell` |
| **search results** | `/openmrs/spa/search?query=<q>` | `h2` "N search results", `a[href*="/chart"]` | — |
| **chart** | `/openmrs/spa/patient/<uuid>/chart/<section>` | `role=link[name="Patient summary"]` (the chart's left nav) | `assertChart(uuid?)` |
| **chart section** | `…/chart/{patient-summary,vitals-and-biometrics,medications,orders,results,visits,allergies,conditions,…}` | the section's own widget + its request | `openSection` |

Two traps, both paid for:

1. **The shell landmark must be a disjunction.** Opening the patient-search overlay *replaces* the header
   magnifier with a "Close Search Panel" button, so a single-selector shell anchor reports "shell not
   reached" while you are standing in the shell (check run 2 failed exactly there).
2. **Route slugs are lowercase and hyphenated; link labels are not.** `role=link[name="Allergies"]` →
   `/chart/allergies`; `"Vitals & Biometrics"` → `/chart/vitals-and-biometrics`. act:25 asserted
   `endsWith("/Allergies")` and the diagnosis census printed the real URL in one turn.

## 4. Selector strategy

- **ARIA roles/names first** (`role=link[name="Visits"]`, `role=button[name="Confirm"]`) — Carbon renders
  real roles and the labels are stable across the micro-frontend versions.
- **`data-testid` where it exists** — only three in the shell (`searchPatientIcon`,
  `globalImplementerToolsButton`, `patient-banner-button-col`); use them when present.
- **Never ids inside the app.** They are React `useId` output: `#search-input-:r1j:`,
  `#table-toolbar-search-:rr:` — new every render. (`#username` / `#password` on the *login* page are
  real and stable.)
- **CSS-module class *prefixes*** are stable, hashes are not: `form[class*="patient-search-bar"]` works,
  `.-esm-patient-search__patient-search-bar__searchArea___AwmMr` will not survive a rebuild.
- **Beware the second search box.** `input[type=search]` matches the queue table's "Search this list"
  filter on the home dashboard *before* it matches the patient search. The first check run typed a
  patient name into the queue filter and waited 12 s for a request that was never going to fire
  (act:33 diagnosis: `focused: "#table-toolbar-search-:rr:"`). `lib.ts::SEARCH_INPUT` is the fix.

## 5. Transitions (settle profile + wire signature)

Measured on the demo over a full `run-check` (durations are the check's per-step wall clock, which
includes disco overhead of ~6 % — `bun scripts/timing-report.ts openmrs`).

| Transition | Action | Verdict | Settle | Postcondition (`until`) | Wire signature |
|---|---|---|---|---|---|
| login → username step | `fill #username` + click `button[type=submit]` | `settled:dom` / `settled:visual` | 114–152 ms | `#password` **visible** (it is in the DOM from the start — `visible` matters) | none |
| username → shell | `fill #password` + click submit | `still-active` (chunk storm) | ~1 000 ms | `any[picker \| shell \| refusal]`, ~5.0 s total | `GET /ws/rest/v1/session` (Basic) then ~40 JS chunks for every micro-frontend |
| shell → search overlay | click `[data-testid="searchPatientIcon"]` | `still-active` | ~1 030 ms | search input visible (34 ms) | `session`, `patient/<uuid>` ×7 (recent list) |
| overlay → results | `fill SEARCH_INPUT` (debounced) | `settled:dom` | 26–374 ms | `urlLike "/ws/rest/v1/patient?q="` **landed** (445–580 ms) | one `patient?q=…&limit=10&totalCount=true` |
| overlay → results page | `press Enter` | `settled:network` | 434–2 400 ms | pathname `/spa/search` **and** `limit=50` landed | `patient?q=…&limit=50`, then `visit?patient=` + `obs?…` per row |
| results page → more pages | `scroll` | `settled:network` | ~230 ms | next `patient?q=` landed | one more 50-row page per scroll (373 results ⇒ 300 read in the check) |
| results → chart | click `a[href*="<uuid>"]` | `settled:visual` (51–59 ms!) | 51–59 ms | `pathname includes /patient/<uuid>/chart` **and** `role=link[name="Patient summary"]` — **1.9 s** | `fhir2/R4/Patient`, `Condition`, `Observation` ×3, `order`, `visit`, `conceptreferencerange`, `billing/patientPaymentStatus`, **`POST user/<uuid>` (userProperties)** |
| chart → section | click `role=link[name="…"]` | `settled:network` / `still-active` | 311–1 205 ms | pathname ends `/…<slug>` **and** the section's request landed | Allergies → `AllergyIntolerance`; Visits → `visit` (history) + `encounter` + `encountertype` |
| anywhere → shell | `navigate /spa/home` | `navigated` | 1 690–1 834 ms | shell landmark **or** `#username` (session died) | full app-shell reload |

**Final settle profile** (`bun scripts/timing-report.ts openmrs`, 71 actions, run 2):

```
verdict            n   settle_ms                  wait_ms (page)             overhead_ms (daemon)
settled:network   25   p50 453  p90 733  max 2596 p50 771  p90 2896 max 12003 p50 46  p90 85  max 110
settled:dom       18   p50 152  p90 374  max 409  p50 514  p90 1221 max 8003  p50 14  p90 104 max 142
settled:visual    12   p50 98   p90 112  max 124  p50 401  p90 414  max 2378  p50 20  p90 91  max 468
still-active      11   p50 1048 p90 1310 max 4602 p50 1048 p90 1310 max 4602  p50 182 p90 760 max 768
navigated          3   p50 1690 p90 1690 max 1834 p50 1990 p90 1990 max 2134  p50 57  p90 57  max 77
until: 52 actions, matched 48; elapsed p50 310  p90 1942  max 12000     overhead share: 6%
```

The four unmatched `until`s are the four diagnoses this run produced — each one a real finding
(§3 trap 2, the non-existent pagination control, the wrong search box), not a flake.

**The click that settles in 59 ms is the headline.** Opening a chart reports `settled:visual` at 51–59 ms
— the router swapped the view instantly — while the chart itself needs **1.9 s** more before its left nav
exists. *The verdict is evidence; `until` is the gate*, and this app is the clean demonstration.

## 6. Interstitials, dialogs, and other conditional UI

| Thing | Verdict | Handling |
|---|---|---|
| **Login location picker** (`/spa/login/location`) | **absent** for `admin` on this demo (n=0/6 logins) — the user already carries a `sessionLocation` ("Outpatient Clinic") | first-class optional: `login` waits for `any[picker \| shell \| refusal]` and, if the picker came, selects the first radio and Confirms |
| **Conditional chart-open modal** (allergy warning, break-the-glass, care gaps, "what's new") | **absent** — n=0/6 chart opens, `sentinels` shows **zero** dialog firings in the whole run (38 toasts, 5 error 404s, no dialogs) | still treated as optional by construction; a modal would occlude the next click and disco's diagnosis names it |
| **Native dialogs / `beforeunload`** | **absent** — `env.dialogs` empty in **all 71 actions** of run 2 (`SELECT count(*) … json_extract(report,'$.env.dialogs')`) | session policy handles them if they ever appear |
| **Carbon "Loading…" toasts** | **present, constantly** — 38 sentinel firings, all noise | muted by rule |
| **The "vitals out of date" banner** | present for some patients (Lewis: "These vitals are out of date", last vitals 19-Jul-2026) | informational only; not a gate |
| **Billing tag in the patient banner** | varies per patient: `PAID / No outstanding bills` (Susan Lopez) vs `UNPAID / Outstanding bill(s) present` (Lewis, Kenneth Carter) | ledger row 5 |

## 7. The write that a read-only stance must declare

Opening a chart makes the app **POST the logged-in user's own preferences**:
`POST /ws/rest/v1/user/<user-uuid>?v=custom:(userProperties)` with
`patientsVisited: "<uuid>,<uuid>,…"` — the recently-viewed MRU — plus `defaultLocale`, `defaultLocation`,
`starredPatientLists` and `order_favorites_drugs` echoed back unchanged (act:38, act:43;
`write_kind=write`). **No patient data is written**, and it is unavoidable through the UI, but it is a
server-state change and it is why the search overlay shows "10 recent search results" on a *fresh*
browser profile: that list is server-side, per user, and shared by everyone using the demo's `admin`.
It is declared in `lib.ts`'s header and in `openPatient`'s docstring rather than hidden.

## 8. Keyboard recipes

Nothing in these flows needs a keyboard-only widget: there is no med-search combobox, date picker or
order-entry grid on the read paths (all of those live behind *write* forms, out of stance). The two
recipes that matter:

- **Search → full results page:** type into `SEARCH_INPUT`, then **`press Enter`**. This is the only way to
  the `limit=50` results page; there is no "see all results" button. Postcondition:
  `all: [ pathname includes "/spa/search", urlLike "limit=50" landed ]`.
- **Two-step login:** `#username` → `button[type=submit]` ("Continue") → `#password` (now *visible*) →
  the same `button[type=submit]` ("Log in"). One selector, two different buttons — the postcondition
  distinguishes them.

`fill` (replaces) is right for both search and login; `type` (appends) is only needed if you want to
watch the debounce fire per keystroke.

## 9. Recovery

`recoverToShell(s)` — `navigate /openmrs/spa/home` with the postcondition
`any[ shell landmark | #username ]`. It gets you out of a half-loaded section, a stray overlay or a dead
route; if the *session* has died it lands on `#username` and `assertShell` then throws the honest
"still on login? session expired?" instead of hanging. From the shell, every other anchor is one
transition away. (A chart is also directly addressable: `navigate /spa/patient/<uuid>/chart/patient-summary`
— `openPatient` uses that as its fallback when no search hit is on screen.)

## 10. The EHR failure-mode checklist (GUIDANCE §8) — verdict per item

| # | Item | Verdict | Evidence / note |
|---|---|---|---|
| 1 | Conditional interstitials on chart open | **absent** (n=0/6 opens) | `sentinels` has **zero** dialog firings in run 2; charts open straight to `patient-summary`. Handled as optional anyway. |
| 2 | Toasts / transient banners | **present** (noise, not signal) | 38 Carbon "Loading…" toast firings; every lazily-loaded micro-frontend raises one. Muted by rule. Async *failures* would land here too — none seen. |
| 3 | Spinners that lie | **present** | The results page renders skeleton rows + a `progressbar` while the debounce is in flight (act:6 UI delta). Never gate on the spinner; gate on the response landing. |
| 4 | Re-render races on virtual-DOM lists | **unobserved** (no `detachedRetried` in any report) | React 18 + SWR; plausible under fast retyping. `fill` + a landed-response postcondition avoided it. |
| 5 | Virtualized / incrementally-loaded lists | **present** | `q=1000` → `totalCount: 373`; the DOM held ~20 rows while the wire had already delivered 300 (act:19/act:20, heading counted 250 → 300 → 373). **The full dataset is on the wire** — `searchResults()` reads it. |
| 6 | iframes / cross-origin islands | **absent** | `disco targets`: one target, one frame, for the entire session. No `frame:` argument anywhere in `lib.ts`. |
| 7 | Shadow DOM | **absent** on the driven paths | every selector resolved with plain CSS/ARIA. |
| 8 | Canvas regions | **unobserved** on the driven paths | the "Growth chart" section is a plausible canvas/SVG island — not opened (out of the flow set). Open question 3. |
| 9 | Focus traps / keyboard-only widgets | **absent** on read paths | the only keyboard recipe needed is `press Enter` in the search box (§8). Med/order search comboboxes live behind write forms — out of stance. |
| 10 | Debounced / async-validated inputs | **present** | the patient search is debounced (~300 ms) and fires one request per settled term; the postcondition is the response **landing**, never the keystrokes. |
| 11 | Session expiry + keepalive | **partially observed** | No keepalive ping exists (the only timer is the 60 s dashboard refresh, and it stops when you leave that route). `GET /ws/rest/v1/session` on every route change *is* the liveness check; a dead session returns `authenticated:false` and the shell bounces to `/login`. **The expiry warning itself was not observed** (the demo's timeout outlives a 60-minute session) — open question 1. `recoverToShell` detects the bounce and `assertShell` throws honestly. |
| 12 | Multi-window flows | **absent so far** | A second tab opened via CDP is a normal scoped target sharing the session cookie (`disco targets` shows both, `focus` switches); no flow in this set spawns a window. Print/attachment flows untested — open question 4. |
| 13 | Reads delivered over POST | **absent** | 1258 GET vs 5 POST across all runs; `--mark-read` never needed. See `wire.md` "The read-POST pass". |
| 14 | Optimistic UI | **not reachable read-only** | every write path is out of stance. The one write the app makes on its own (`userProperties`) is fire-and-forget with no UI at all. |
| 15 | Native dialogs / `beforeunload` | **absent** | `env.dialogs` empty in **all 71 actions** of run 2 (`SELECT count(*) … json_extract(report,'$.env.dialogs')`); navigating away from a chart never prompts. |
| 16 | Bot challenges | **present — on the host the job named** | `o3.openmrs.org` served a Cloudflare interstitial to headless Chromium (run 1: title "Just a moment…", 3 `challenge-platform` POSTs). `dev3.openmrs.org` — same build — does not. |
| 17 | Cold-load hydration races | **not triggered, but real** | the login form's inputs exist before the app's handlers; the two-step form makes this visible (the password field is in the DOM but not rendered). Every step verifies the field's effect before submitting. |
| 18 | Third-party telemetry | **absent** | no analytics or crash reporter; every request is same-origin. |

## 11. Open questions (and the probe that resolves each)

1. **What is the session timeout, and how is expiry delivered — dialog, redirect, or a silent 401 storm?**
   Not observed: the session survived the whole run. *Probe:* leave a chart open, poll
   `GET /ws/rest/v1/session` from the store until `authenticated:false`, then act and read the report
   (expect either a bounce to `/login` or a burst of 401s on the next SWR revalidation). Budget: ~40 min idle.
2. **Does the location picker ever appear on this build?** `admin` has a `sessionLocation` already.
   *Probe:* log in as a user with no default location, or clear `userProperties.defaultLocation`
   (a write — out of stance). The absent path is exercised today; the present path is code-only.
3. **Is "Growth chart" (or Results trendlines) canvas-rendered?** If so, those facts are pixels, not DOM.
   *Probe:* open `…/chart/growth-chart` on a pediatric patient (John Smith, 6y) and count
   `canvas`/`svg` nodes; check whether the same numbers are on the wire as `Observation`.
4. **Do attachments / print flows open a second window?** *Probe:* open `…/chart/attachments` on a
   patient that has one and watch `env.newTargets`.
5. **Does a lower-privilege role see a different chart?** All observations are `System Developer` +
   `Provider` (i.e. everything). *Probe:* a nurse/clerk account on the demo, then diff the left-nav link
   set and the failing requests (403s) with `store.diffTrace`.
6. **Why did the `userProperties` POST fire on only 2 of 6 chart opens?** *Probe:* open five charts in a
   row from a fresh login and correlate the POSTs with `patientsVisited` membership (hypothesis: it fires
   only when the MRU list actually changes).

## 12. Screenshots (all cited above)

| File | What it shows |
|---|---|
| `screenshots/anchor-1-login.jpg` | login anchor, step 1 (username only — the password field exists but is not rendered) |
| `screenshots/anchor-2-shell-service-queues.jpg` | shell anchor: `/home/service-queues`, the 60 s-polling dashboard |
| `screenshots/anchor-3-search-overlay.jpg` | the patient-search overlay with its server-side "10 recent search results" |
| `screenshots/anchor-4-search-results-page.jpg` | `/spa/search?query=jo` — 13 results, no pagination control (act:16) |
| `screenshots/anchor-5-chart-summary-populated.jpg` | chart anchor, Michelle Lewis (dense patient, UNPAID banner tag) |
| `screenshots/anchor-6-chart-visits.jpg` | Visits section — the visit table `listVisits` shadows with the wire |
| `screenshots/empty-patient-chart.jpg` | the same anchor for a patient with nothing recorded (John Smith) |
| `screenshots/empty-patient-allergies.jpg` | Allergies section, empty state ("There are no allergy intolerances…") |
| `screenshots/diagnosis-act17-no-pagination.jpg` | the diagnosis shot for act:17 — `.cds--pagination button[aria-label*="Next"]` does not exist because the results page has no pagination at all |

## 13. Pack contents

`lib.ts` (flows) · `check.ts` (12-step live drift check, `bun scripts/run-check.ts openmrs`) ·
`wire.md` (where the facts live) · `ledger.md` (variability) · `friction.md` (tool friction) ·
`screenshots/` · `store/` (gitignored, run-tagged — every act id above is re-queryable with
`bun cli/disco.ts sql openmrs "…"`).
