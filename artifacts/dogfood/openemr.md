# Dogfood #1 — OpenEMR 8.3.0 demo (BRIEF §5)

**Target:** https://demo.openemr.io/a/openemr (real hosted OpenEMR, not the gauntlet).
**Session:** `openemr` (attach mode, headless Chromium :9333, scope `demo.openemr.io`), physician/physician.
**Date:** 2026-08-30. Evidence: `sessions/openemr/store.sqlite` (act:1–6, ~470 events, 162 requests). Screens in this dir.

This is the first time the daemon met an app it wasn't built against. It worked — a physician login, patient finder, and full chart-open were driven by `act()` with correct verdicts, and the wire carried the clinical facts. Findings below feed `defaults.ts` tuning and the roadmap.

## What the daemon got right on a real EHR

- **Login flow** (act:1–3): `type`/`type`/`click` → the login POST redirected and the app shell (nav + calendar + message-center iframes) built out; verdict `navigated`, settled at **6.2s** across **68 requests** — no tuning, the network detector just held the window open until the shell finished and closed ~Q after. This is the "7s round trip reports at ~7.3s" claim (GUIDANCE §4.2) confirmed on a real app.
- **Multi-frame reality**: OpenEMR is exactly the nested-iframe app the guidance predicted — the working UI lives in `interface/main/tabs/main.php` with child frames per open tab (`calendar/index.php`, `messages.php`, `finder/dynamic_finder.php`, `patient_file/summary/demographics.php?set_pid=1`, `history/encounters.php`). Frame-scoped selectors (`--frame dynamic_finder`) resolved and clicked correctly inside them.
- **The wire had it all along** (GUIDANCE §2.3): the patient list is JSON at `dynamic_finder_ajax.php` (`aaData` with `DT_RowId: pid_N` + name/DOB/id) — no DOM scraping needed. The chart dashboard's problems/allergies/meds/vitals/labs are server-rendered HTML **fragments** (`stats.php`, `vitals_fragment.php`, `labdata_fragment.php`, …) POSTed per panel — all captured, all parseable. `Norvasc` (a med never asked for at capture time) was later found by one FTS `MATCH` in the demographics body — retroactive query, working.
- **Ambient classifier vs a real heartbeat** (the headline result): OpenEMR fires a **60-second trio** — `dated_reminders_counter.php`, `dated_reminders.php`, and `apis/default/api/background_service/$run` — all POSTs. After ~2 min of idle observation all three were classified `periodic` (cv≈0, 4–5 occurrences outside any window). Without this they'd hold settlement open on every action; scoping them out is the whole point (GUIDANCE §4.4), and it worked on real traffic.
- **Native alert as a conditional interstitial** (act:5, record open): opening Phil Belford's chart fired a native `alert("New Due Clinical Reminders: Colon Cancer Screening…")` — auto-accepted per dialog policy, recorded, verdict `dialog`. Sentinel + ledger caught it as variability (n=1, suspected conditional on due-reminder state) exactly as the methodology wants — a real EHR interstitial, handled without a hang.
- **Occlusion diagnosis, correctly** (act:6): clicking the top-tab "Visit History" resolved to a `tabHidden` SPAN behind the fixed navbar → `diagnosis: occluded` naming the nav, in one turn, with a screenshot — not a blind click-through, not a 30s timeout. "Smarter, not poorer" on a real layout.
- **Sentinels**: 6 toast firings ("Loading…", "Showing 1 to 10 of 31 entries"), 1 error sentinel on a `GET /controller.php → 403` (a real permission boundary — physician role can't hit that controller). All timestamped with screenshots.
- **Blob dedup**: 145 body-bearing requests → 74 distinct blobs (the 314KB `style_light.css` alone was requested 5× on disk once).

## Friction / tuning inputs (feeds defaults.ts + roadmap)

1. **Chart-class digests still run hot.** After the review's diet, simple acts are ~275 tokens (on budget) but the 59-request chart-open report is **~1440 tokens** and the 68-request login **~1540**. The aria-diff of a whole EHR dashboard is the bulk. Levers: cap the UI-delta section harder on huge navigations, or summarize aria added/removed as counts + top-N by role when it exceeds a threshold. `digestMaxRequests=8` held; `digestMaxUiLines` should probably drop to ~12 for navigations.
2. **Write-flag noise on a POST-heavy app.** OpenEMR renders read-only panels via POST (`stats.php`, the `*_fragment.php` family) — 9 "write" families, most of them actually reads. The per-family `disco family mark-read` fixed the obvious ones by hand, but a real session wants a recon pass that bulk-marks the `*_fragment`/`summary` families, or a heuristic that treats POSTs returning HTML with no state-change semantics as reads. Open question for the classifier.
3. **Idle warm-up needs to be ~90–120s, not 20s**, to catch a 60s-period heartbeat (needs ≥3 cycles). `defaults.idleObserveMs=20000` is too short for minute-scale EHR heartbeats — bump the session-start default or document "run `disco idle 120000` once at the start of an EHR session." The classifier stayed `immature` correctly until it had the evidence.
4. **Settle budgets:** login 6.2s and chart-open 2.5s both landed inside `maxBudgetMs` comfortably; the default `budgetMs=3000` for the still-active tripwire is fine, but chart-open occasionally rides close — worth measuring across more patients.

## Roadmap items this session confirms

- The `OPEN` "content-based attribution fallback" is **not** needed for OpenEMR (results come back on the triggering POST, cleanly window/task-attributed) — but the 60s background-service `$run` is the kind of standing channel where a future EHR *could* deliver async results; keep it open.
- The state/transition map (finder → chart is `dialog|network ~2.5s, 59 req`; login is `navigated ~6s, 68 req`) is real and reusable; a full nav-and-quirks doc for OpenEMR would be a natural second session.
