# OpenMRS O3 — variability ledger

What varied, how often, what I think is going on, and the experiment that would settle it.
**Observed** = seen in a report or a captured body. **Inferred** = reasoned, not seen — said so.
Act ids are run 2 of `apps/openmrs/store/`; `run-check` rows are from the check runs (separate,
throwaway sessions, cited by step name).

Patients opened: **4** — deliberately different shapes.

| # | Patient | uuid | Shape |
|---|---|---|---|
| P1 | John Smith, 6 M | `ea429874-…d62c` | **empty**: 0 conditions, 0 allergies, 0 meds, 0 vitals, 1 visit |
| P2 | Michelle Lewis, 86 F | `ceed1f65-…b90b` | **dense**: 33 conditions, 2 drug orders, 120 obs, 10 visits, UNPAID |
| P3 | Susan Lopez, 54 F | `e0167f26-…9d4e` | mid: 6 vitals, 9 visits, in the queue, **PAID** |
| P4 | Kenneth Carter, 31 M | `d6c212ad-…2501` | sparse: 1 condition ("Diabetes mellitus"), no meds, no vitals, 2 visits, UNPAID |

| # | What varied | n | Hypothesis | Resolving experiment | Evidence |
|---|---|---|---|---|---|
| 1 | **Interstitial on chart open** — none ever appeared | 0/6 opens | O3 ships no conditional chart-open modal; allergy/break-the-glass style gates are implementation add-ons, not core | Open a patient flagged deceased, or one on a restricted program, and watch `env.dialogs` / the sentinel stream | act:23, act:30, act:38, act:43 + `run-check` ×2; `sentinels` has zero dialog rows (38 toasts, 0 dialogs, run 2) |
| 2 | **Login location picker** — never shown | 0/6 logins | `admin` already has `userProperties.defaultLocation` (`44c3efb0-…`, "Outpatient Clinic") + a single login-tagged location, so O3 auto-selects | Log in as a user with no `defaultLocation`, or with 2+ login locations | `session` body `358deeb0`; act:4 landed straight on `/home/service-queues` |
| 3 | **Empty vs populated sections** | P1 all-empty vs P2 all-populated | Demo data is seeded per patient; the widgets render "There are no X to display" rather than failing | — (resolved) | `run-check` step "empty patient yields empty arrays"; screenshots `empty-patient-*.jpg` |
| 4 | **Allergies are NOT on the summary dashboard** | 4/4 patients | O3's `patient-summary` slot carries vitals/biometrics/conditions/medications only; `AllergyIntolerance` is fetched exclusively by the Allergies section | Check `config-core_demo.json` for the summary slot's widget list | act:25 (first `AllergyIntolerance` request in the run is on `/chart/allergies`); `extractSummary` therefore visits that section |
| 5 | **Patient-banner billing tag** — `PAID / No outstanding bills` vs `UNPAID / Outstanding bill(s) present` | 3/4 patients tagged (P3 PAID, P2+P4 UNPAID; P1 untagged) | The billing micro-frontend adds a banner tag from `GET /ws/rest/v1/billing/patientPaymentStatus/<uuid>`; absent when the module returns nothing for that patient | Read `patientPaymentStatus` for P1 and compare | banners quoted in r20 output; `billing/patientPaymentStatus` in the chart wire signature |
| 6 | **Two different `visit?patient=` projections** | every chart | The banner asks for the *active* visit only (n=1); the Visits section asks for the history with encounters + diagnoses (n=10). Same family, different truth | — (resolved; `listVisits` takes the richest body) | bodies for P2: n=1 vs n=10 (`78a118afb9a96931`) |
| 7 | **`POST user/<uuid>` (userProperties / `patientsVisited`) fired on only some chart opens** | 2/6 opens | It fires only when the MRU list actually *changes* (re-opening a patient already at the head is a no-op) — **inferred**, not proven | Open five distinct charts from a fresh login, then re-open the first; count POSTs | act:38, act:43; `write_kind=write`; body key `patientsVisited` |
| 8 | **Search result count vs rendered rows** | q=1000: 373 total, 10 → 50 → 300–350 on the wire, ~20 in the DOM | The results list renders a window and pages in on scroll; the wire always leads the DOM | — (resolved; read the wire) | act:19/act:20 (heading counted 250 → 300 → 373); `run-check` "past page 1" reported `paged: 300` and `350` on two runs — **the number itself varies with scroll timing**, which is why the assertion is `> 10`, not `== N` |
| 9 | **Minimum search length** | `q=a` → 0; `q=jo`/`q=ma` → 12–13; `q=John` → 8 | 1 character returns nothing (server-side or config `minSearchLength`); ≥2 works. A 2-char query returning *more* than a 4-char one is just prefix breadth | Read `config-core_demo.json` for `patientSearch` settings | act:8 (0 results), r9 probe totals |
| 10 | **Chart open cost: first vs later** | first ~5.6 s, later 1.5–4.2 s | The first chart open downloads the whole `patient-chart` micro-frontend bundle; later opens are warm | — (resolved) | act:23 vs act:43 (`ms.open` 3375 / 1567 in r20) |
| 11 | **`still-active` verdicts cluster on the shell, not the chart** | 11/45 actions | Login and search fan out to dozens of JS chunks; the chart's own data settles quickly | — | `timing-report`: `still-active` p50 1048 ms, all on shell/search transitions |
| 12 | **A stale refusal banner survives on the login page** | 1/1 | Carbon inline notifications are not cleared on re-submit; the next login sees the previous failure | — (resolved; `login` dismisses it first, then re-verified twice in a row) | r22 (`login refused: (no text)` — the bug), r24 (two clean refusals + recovery) |
| 13 | **Same URL is both ambient poll and action traffic** (`obs?…concept=736e8771…`) | dashboard 60 s poll **and** once per search-result row | The queue widget and the search-result row share a hook; the URLs are byte-identical, so no URL rule can separate them | Content-based attribution (the deferred core extension) would; nothing at the URL layer will | act:16 (13 rows tagged `attribution=ambient` inside an action window) |
