# OpenEMR — variability ledger (dogfood #1)

Observed vs inferred, with n-counts and the experiment that would resolve each (GUIDANCE §7.5).
Extracted from `sessions/openemr/store.sqlite` notes (act ids cited); refine across future sessions.

| # | flow step | observed | n | suspected variation | resolving experiment |
|---|---|---|---|---|---|
| 1 | chart-open | native alert "New Due Clinical Reminders" (act:5) | 1/1 | conditional on the patient having **due** clinical reminders; a patient with none opens without it | open a patient known to have no due reminders; compare `dialog` vs `settled:*` verdict |
| 2 | save flow | not yet exercised | 0 | optimistic-UI + async failure like the gauntlet's? unknown for OpenEMR | drive an edit + save; watch screen vs the attributed response status |
| 3 | roles | physician only; `controller.php`→403 (act:5 window) | 1 | panels/actions differ by role (clinician < physician < admin) | repeat the finder→chart flow as clinician and admin; `diffTrace` |
| 4 | finder | 31 patients, list fully wire-available (act:4) | 1 | empty result / very large practice paging behavior unknown | search a no-match term; observe `dynamic_finder_ajax` shape |
| 5 | ambient | 60s heartbeat trio classified periodic | 1 session | token-refresh / session-timeout modal exists but unseen (idle timeout not hit) | idle past the server session timeout; capture the warning modal |

## Update (slice 2b, 2026-08-30)

Ledger #1 (conditional interstitial) — partial support: `Stone, Alex` (pid 30) opened with **no** due-reminders
alert and an empty chart ("Nothing Recorded" everywhere), while `Belford, Phil` (pid 1, has problems/meds)
fired the alert. Consistent with "interstitial conditional on due-reminder state," now n=2 (1 fired / 1 not).
`openPatient` handles both branches. Still not proven which specific state gates it.

## Correction (a way-of-knowing note)

An early ledger note claimed OpenEMR fired *no* periodic traffic — wrong; it was written before the idle
window was long enough (20s) to see a 60s-period heartbeat. The corrected note stands (finding #5 above).
Both are still in the store: `disco sql` opens the store **read-only**, so notes can't be deleted from the
CLI — the append-only record keeps the mistake *and* its correction, which is the point (retroactive,
honest history). This also fed a framework fix: warm-up 20s → 90s (DECISIONS #29).
