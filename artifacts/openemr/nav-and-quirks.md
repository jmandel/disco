# OpenEMR 8.3.0 — navigation & quirks

Site map for the hosted demo (`demo.openemr.io`, physician role). The **function library** (`lib.ts`) is
the executable form of this; the live regression is `check.ts`. Evidence: dogfood #1 (`dogfood-1.md`,
`sessions/openemr/`) + the slice-2b build against `sessions/openemr2/`. **Confirm, don't trust** — the demo
resets and versions move (GUIDANCE §2.4); `check.ts` is how you confirm the library still holds.

## Anchors (known states you can start a workflow from)

| anchor | recognize by | reach with |
|---|---|---|
| `login` | URL `…/login.php` + `#authUser` | (start) |
| `main-shell` | URL `…/interface/main/tabs/main.php` | `login(s)` |
| `patient-finder` | child frame URL `…/finder/dynamic_finder.php` | `openFinder(s)` |
| `chart-dashboard` | child frame `…/summary/demographics.php?set_pid=<N>`, `#medical_problem_ps_expand` present | `openPatient(s, pidOrName)` |

Functions assert their anchor on entry/exit (`assertMainShell`, `assertChart`) — they fail loudly with a
clear message rather than acting from the wrong place (GUIDANCE §9).

## Transitions (settlement profiles + wire signatures)

- **login → main-shell**: type `#authUser`/`#clearPass`, click `#login-button` → `navigated ~6–7s, ~68 req`. `login()` is idempotent and reload-free (skips the nav if already in the shell).
- **main-shell → patient-finder**: click `text=Finder` → `settled:network ~1s`. Always click it (it *focuses* the tab if already open — a background finder's rows aren't hit-testable).
- **patient-finder → chart-dashboard**: click the row `#pid_<N>` (in the finder frame) → `dialog|network ~2.5s, ~59 req`. Optional native `alert("New Due Clinical Reminders…")` on patients with due reminders — auto-accepted by dialog policy, so the transition proceeds either way.

## Wire-available facts (prefer over scraping — GUIDANCE §2.3)

- **Patient list** is JSON at `dynamic_finder_ajax.php`: `aaData[]` of `{DT_RowId:"pid_N", 0:name, 3:dob, 4:externalId}`. **Paged (10/row default)** — `findPatient` reads the current page, then falls back to the finder's **name-search** column filter (`input[placeholder="Search by Name"]`) to reach patients past page 1. Search by the first name token; the box must be cleared first (typing appends).
- **Chart facts** (problems/allergies/meds/vitals/labs) are server-rendered HTML **fragments** POSTed per panel on chart-open (`stats.php`, `vitals_fragment.php`, `labdata_fragment.php`, …). `extractSummary` reads the rendered cards (`#medical_problem_ps_expand`, `#allergy_ps_expand`, `#medication_ps_expand`) — entries render as `.list-group-item` after the fragment lands (or `<a>` in the initial pass; the reader handles both) and it **waits for the fragment to populate** before reading (empty patients show a "Nothing Recorded" placeholder, filtered out → `[]`).

## Quirks / failure modes (each cost a real fix — see the library + DECISIONS)

- **Nested iframes**: the working UI is under `interface/main/tabs/main.php`; each tab is a child frame. Frame-scope everything (`{frame: "dynamic_finder.php"}`, `{frame: "demographics.php"}`).
- **Re-navigation leaves stale frames** (DECISIONS #31): a second top-navigation (e.g. re-login) used to leave a shadow `dynamic_finder.php` frame that broke `createIsolatedWorld`. Fixed in the daemon (prune same-target child frames on main-frame nav); `login` is also reload-free to avoid the second nav entirely.
- **Reads via POST**: finder + summary panels are POSTs returning HTML/JSON that change no state → the write-flag over-fires (9 "write" families, most reads). Pre-mark them (below) or during recon.
- **60-second heartbeat trio** (ambient): `dated_reminders_counter.php`, `dated_reminders.php`, `apis/…/background_service/$run`. Warm up ≥2 min (`disco idle 120000`) so the classifier scopes them out before you act.
- **Hidden tab templates**: top nav tabs have `tabHidden` SPANs behind the fixed navbar; a role/text click can resolve the hidden one → occlusion diagnosis. Act on the visible strip or drive the child frame.
- **`controller.php` → 403** for the physician role: a real permission boundary (fires the error sentinel), not a bug.

## Known ambient / read-POST families (recon hints; fold-in of the retired site.json)

Ambient (classified `periodic`, cv≈0): `POST …/library/ajax/dated_reminders_counter.php`,
`POST …/interface/main/dated_reminders/dated_reminders.php`, `POST …/apis/default/api/background_service/$run`.
Read-shaped POSTs to mark read: the `…/patient_file/summary/*.php` + `*_fragment.php` family, and
`…/library/ajax/track_events.php`.

## Coverage & gaps

Mapped: login, finder (incl. search past page 1), chart-open + summary extraction. **Not mapped**:
encounters/notes, order entry, scheduling writes, other roles, the patient portal. See `ledger.md`.
