# OpenEMR 8.3.0 — navigation & quirks

Partial site map from **dogfood #1** (2026-08-30, physician role, `demo.openemr.io/a/openemr`).
Evidence lives in `sessions/openemr/store.sqlite` (act:1–6); the machine-readable version of this is
`site.json`; the narrative session report is `dogfood-1.md`. **This is a hint, not truth** — a fresh
session should confirm each claim, because the demo resets and versions move (GUIDANCE §2.4).

## States (cheap predicates — GUIDANCE §7.3)

| state | recognize by |
|---|---|
| `login` | URL `…/login.php` + `#authUser` present |
| `main-shell` | URL `…/interface/main/tabs/main.php?token_main=…` |
| `patient-finder` | child frame URL `…/finder/dynamic_finder.php` |
| `chart-dashboard` | child frame `…/summary/demographics.php?set_pid=<N>` + title "Medical Record Dashboard" |

## Transitions (with settlement profiles + wire signatures)

- **login → main-shell** — type `#authUser`,`#clearPass`; click `#login-button` → `navigated ~6.2s, 68 req` (act:3). The shell builds child frames (calendar, message-center). Fact: `POST …/main_screen.php` 302 redirect.
- **main-shell → patient-finder** — click `text=Finder` → `settled:network ~1.0s, 18 req` (act:4). Loads `finder/dynamic_finder.php` as a child frame; toast "Showing 1 to 10 of 31 entries".
- **patient-finder → chart-dashboard** — click a patient row inside `--frame dynamic_finder` → `dialog|network ~2.5s, 59 req` (act:5). **Optional interstitial**: native `alert("New Due Clinical Reminders…")`, auto-accepted. Spawns child frames `demographics.php?set_pid=N`, `history/encounters.php`.

## Selector strategy & rationale

Stable ids exist for form controls (`#authUser`, `#clearPass`, `#login-button`) and app landmarks, and
patient rows carry `DT_RowId="pid_<N>"` — so **id/role/text selectors are viable** (no generated-class
soup here). The one trap: **frame-scope everything inside a tab** — the working UI is several iframes
deep under `interface/main/tabs/main.php`.

## Wire-available facts (prefer over scraping — GUIDANCE §2.3)

- **Patient list** is JSON at `GET …/finder/dynamic_finder_ajax.php`: `aaData[]` of `{DT_RowId:"pid_N", 0:name, 3:dob, 4:external_id}`. The whole list is there; don't page the DOM.
- **Chart facts** (problems, allergies, meds, vitals, labs) are server-rendered HTML **fragments** POSTed per panel on chart-open (`stats.php`, `vitals_fragment.php`, `labdata_fragment.php`, …). Parseable from the store; `Norvasc` was found post-hoc by one FTS `MATCH` in the demographics body.

## Quirks / failure modes actually seen

- **Reads via POST.** Finder and summary panels are POSTs returning HTML/JSON that change no state; 9 "write" families were flagged, most of them reads. Pre-mark them (`site.json → known_read_post_families`, or `disco family mark-read`) or the write-flag is noise.
- **Hidden tab templates.** Top nav tabs have `tabHidden` SPANs behind the fixed navbar; a role/text click can resolve to the hidden one → `diagnosis: occluded` naming the nav (act:6). Act on the visible strip or navigate the child frame directly.
- **60-second heartbeat trio** (see `site.json → known_ambient_families`): `dated_reminders_counter.php`, `dated_reminders.php`, `apis/…/background_service/$run` — all POSTs, classified `periodic` cv≈0 after ~2 min idle. Would otherwise hold settlement open on every action.
- **`controller.php` → 403** for the physician role — a real permission boundary, fires the error sentinel (not a bug).

## Coverage & gaps (be honest — GUIDANCE §2.4)

Mapped: login, finder, one chart-open. **Not mapped:** encounters/notes, order entry, scheduling writes,
the patient portal, other roles. See `ledger.md` for the open variability questions and proposed probes.
