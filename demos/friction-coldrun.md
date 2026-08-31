# Friction log — cold run of the user-facing docs (2026-08-30, worktree `p4-c`)

A fresh engineer following README "Quickstart", `demos/01-hand-drive.md`, `demos/02-agent-drive.md`,
`bun demos/03-two-questions.ts`, `bun scripts/timing-report.ts gauntlet`, then writing one ≤25-line script
from the docs alone. Numbered, blunt, with evidence; praise at the bottom. Environment: Bun 1.3.14,
Chromium 150 (`/usr/bin/chromium`), headless (`--headless=new --user-data-dir=/tmp/disco-coldrun`), the
shell resets cwd on every command, so every command was run as `cd <worktree> && …`. "Open the URL in the
browser" steps were done through the DevTools HTTP endpoint (`curl -X PUT localhost:9222/json/new?<url>`),
never with `--launch`.

## Part 1 — README Quickstart, verbatim

| step | command | worked? | what actually happened vs. the README |
|---|---|---|---|
| 1 | `bun install` | yes | "Checked 7 installs across 8 packages (no changes)" |
| 2 | `bun gauntlet &` | yes | prints main origin :4800, x-origin :4801, ctl URLs — README's comment ":4800" is right |
| 3 | `chromium --remote-debugging-port=9222 --headless=new --user-data-dir=/tmp/disco-coldrun &` | yes | "DevTools listening on ws://127.0.0.1:9222/…" (the README line has no `--headless`/`--user-data-dir`; I added them per the experiment brief) |
| 4 | `bun cli/disco.ts session new gauntlet --attach 9222 --scope localhost:4800` | yes, but see #1 | blocked **30.2s** ("idle-observing 30000ms"), not "~20s"; reported `0 scoped target(s)` and `families: 0, ambient: 0 (classifier still immature)` — it idle-observed an empty browser because the README tells you to open the URL *after* this command returns |
| 5 | "open http://localhost:4800 in that browser" | yes (DevTools `PUT /json/new`) | daemon auto-attached the new target (`disco targets` shows it + 3 frames). Initial `GET /` and `/app.js` are **not** in `requests` (attach happened after the navigation started) |
| 6 | `bun cli/disco.ts act click 'role=button[name="Load Chart"]' --until-fn "…"` | yes | verdict **`settled:visual` (settled 1113ms, reported 1414ms; 3 req, 2 mut, 7 px)**, README shows `settled:network (settled 112ms, reported 424ms; 3 req, 1 mut, 1 px)`; `until` matched in 449ms (README: 130ms); `/api/slow` took 405ms (README: 104ms — its sample was taken with `slowMs:100`, the default is 400); report ends with `(ambient classifier immature — consider \`disco idle\`)`; all 3 wire lines printed (README shows one) |
| 7 | `bun cli/disco.ts sql gauntlet "SELECT run, method, path, status FROM requests ORDER BY run, t_start"` | yes | 10 rows, table output — `/iframe.html … /api/chart/b`; README shows no expected output |
| 8 | `bun cli/disco.ts session end gauntlet` | yes | "run ended: …/apps/gauntlet/store" in 0.14s; `disco sql` still works afterwards (README's "works with the daemon stopped" holds) |

Actual step-6 output:

```
act:1  click role=button[name="Load Chart"]  →  settled:visual  (settled 1113ms, reported 1414ms; 3 req, 2 mut, 7 px)
  timing: page 1415ms (settled 1113, reported 1414, until 449) + overhead 111ms (resolve 67, pre 32, post 9, build 3) = 1525ms
  ✓ until: matched in 449ms  true
  + - text: "ws: open · frames: 2 · ambient: off (heartbeats 0 / polls 0) · x-origin: http://localhost:4801 last ws frame: {"type":"echo","id":"load-chart…
  + - text: "status: idle Chart loaded (3 responses)"
  - - text: "ws: open · frames: 1 · ambient: off …"
  - - text: "status: idle"
  ⇄ GET /api/slow → 200, 29B, 405ms, application/json (task)  body:8ef2afbfdd0f
  ⇄ GET /api/chart/a → 200, 35B, 6ms, application/json (task)  body:e565556a7a19
  ⇄ GET /api/chart/b → 200, 35B, 6ms, application/json (task)  body:89cf1590e155
  ⇄ 2 WS frame(s) in window
  (ambient classifier immature — consider `disco idle`)
  cursor ev:133-158  shots pre:810443d6a1 post:220a137196
```

## Part 2a — demos/01-hand-drive.md, verbatim ("by hand" steps done with `disco act`)

| step | worked? | what actually happened vs. the doc |
|---|---|---|
| 1 | yes | gauntlet already running from Part 1 |
| 2 | reused | kept the Part-1 headless Chromium on :9222 (different `--user-data-dir`); closed the Part-1 tab via `curl localhost:9222/json/close/<id>` so the browser was empty like the doc assumes |
| 3 | yes, see #1 | `curl -X POST localhost:4800/ctl -d '{"ambient":true}'` → full state JSON echoed. `session new` → **run 2**, again `0 scoped target(s)`, again 30s of idle-observing nothing, `families: 0, ambient: 0`. The "livelier profile" the doc promises cannot happen: the page is not open yet |
| 4 | yes (via `disco act`) | opened the page with `PUT /json/new`, then `disco idle 4000` (to stand in for a human's page-load pause), `act click 'role=button[name="Load Chart"]'` (act:2, `settled:visual` 1181ms, **`GET /api/heartbeat` listed as attributed** with no tag — see #2), `act click '#record-1'` (act:3, `settled:network` 60ms, record fields in the UI delta), `act click '#save'` (act:4, `POST /api/save → 202 ✎write`), `disco idle 3000` for the toast, `act type '#search' --text zeb` (act:5, `settled:network` 293ms, **the "Saved" toast sentinel lands in this report, not in act:4's**), `act click 'role=button[name="Load Rows"]'` (act:6, `GET /api/rows → 200, 484.7KB`), `act scroll '#rows'` (act:7, `settled:dom`; report line reads `act:7  scroll  →` — the selector is not echoed, see #12), `act click '#grid'` (act:8, `settled:visual`), `act click '#open-child'` (act:9, `new-target … http://localhost:4800/child.html`) |
| 5 | yes | "run ended: …/apps/gauntlet/store" |
| 6 | ran, output misleading | 46 rows — but it is **run 1 and run 2 interleaved** (see #3): `/iframe.html`, `/ctl`, `/api/grid`… appear twice, and run 1's `/api/slow`,`/api/chart/a`,`/api/chart/b` appear *between* run 2's `/api/record/1` and `/api/save`. Attributions seen: `task`, `window`, `ambient`, `trailing` (`GET /api/save/status`), `none` |
| 7 | yes | `size 496354, length(b.text) 496354` — the full 10k-row body is in `bodies.text` |
| 8 | yes | `/api/rows` (1 row) — FTS finds a name that was never on screen |
| 9 | yes, with a stumble | `sentinels` row found, but the table view **truncates the 64-char `shot` hash to 60 chars** with no ellipsis (see #4). `disco blob <60-char> --out toast.jpg --app gauntlet` still worked (prefix match), as did the 12-char `shot:cc6ad210d277` handle from the act:5 report. Wrote 780×493 JPEG showing "Saved" toast bottom-right. (`--out` pointed at my scratch dir, not the cwd) |
| 10 | ran, output misleading | 18 frames — again runs 1+2 interleaved by run-relative `t`: two `hello` frames, and run 1's `action load-chart` (t=46859) sits between run 2's `record-1` and `push n:7` |

## Part 2b — demos/02-agent-drive.md, verbatim

Prereq: `session new gauntlet --attach 9222 --scope localhost:4800` with the page (and demo 1's child
window) already open → **run 3, 2 scoped targets**, and this time the 30s idle actually learned something
(`ambient GET /api/poll ×10 periodic`, `GET /api/heartbeat ×6 periodic`) — but still "classifier still immature".

| step | worked? | what actually happened vs. the doc |
|---|---|---|
| 1–3 (first try) | **no** | all three → `diagnosis ✗ not-found … near matches: <button id="child-fetch">Fetch in child</button>`. The daemon had made demo 1's child window (`child.html`) the **primary** target. See #2. Closed it with `curl localhost:9222/json/close/<id>`; the remaining page then shows `primary: false` but `act` works |
| 1 (retry) | yes | act:13 `settled:network (settled 434ms, reported 733ms; 3 req, 2 mut, 3 px)`, timing line present, three attributed requests; also an unexplained `? other activity: GET /api/rows (task)` |
| 2 | yes | act:14 `no-effect (settled 0ms, reported 499ms)`, 0.8s wall — "well under a second" holds |
| 3 | yes | act:15 `diagnosis ✗ not-found`, 6 near matches, `pending: GET …/api/poll`, `shot: 9c2059060b5c` in 52ms. No "dialog census" line — none were open |
| 4 | yes, number differs | 4a: `settled:network` + `eval: "loading…"` — exactly as promised. 4b: `✓ until: matched in 583ms`, not "~1000ms" (see #5); re-run with a `disco watch --fn …idle` between the clicks: **1363ms**. Both UI deltas read "status: idle Chart loaded" at the end |
| 5 | yes | act:18: `✓ until: matched in 1778ms  req 300571.109`, `POST /api/save → 202 … ✎write`, `GET /api/save/status → 200 [unread]`, `⚑ sentinel toast: "Saved"`, `✎ writes:` — matches the doc line for line |
| 6 | yes | act:19 record-1 `✓ until: matched in 76ms`; ("wait a beat" = `disco idle 1000`); act:20 → `diagnosis ✗ occluded — occluded by <p>This patient has documented allergies…</p> from <div role="dialog" class="overlay" id="record-modal" aria-modal="true"…> subtree`, `open dialogs: Allergy Review Required`, plus the dialog sentinel; act:21 `#modal-ack` → `settled:visual`, dialog removed from the UI delta |
| 7 | yes | `type` appended to demo 1's leftover text: `textbox "Search…": zebzeb` (act:22, one `GET /api/search`); `fill` → `ada` + `listitem: Ada Lovelace` (act:23). The immature-classifier nag disappeared here, ~3.5 min into the run |
| 8 | **second command fails** | `rightclick` → menu with Open/Rename/Delete (act:24). `dblclick '#dbl-target'` → `diagnosis ✗ occluded — occluded by <ul role="menu" id="ctx-menu">` (act:25) — the menu from the previous command. `drag '#slider-thumb' --to-dx 150 --to-dy 0` → `settled:network` 1472ms, `POST /api/drag-report → 200 [unread] ✎write`, "value: 54" (act:26; the drag also closed the menu). `dblclick` retried afterwards: `settled:dom`, `textbox: Editable value`, "state: editing" (act:27). See #6 |
| 9 | yes | act:28 `✓ until: matched in 65ms`, `GET /api/rows → 200, 484.7KB`, `eval: 23` (doc: "~25"). The `disco sql` returned **2 rows** of `496354` (run 2 + run 3) where the doc implies one |
| 10 | yes | `disco tail` in the background while acting: JSONL with `dispatch` / `request` / `response` / `ws_frame` / `settle` lines carrying `action: act:N`, `until: matched, untilMs`. `bun scripts/timing-report.ts gauntlet`: 30 actions across 3 runs, per-verdict p50/p90/max, "overhead share: 4%" |

## Part 2c — `bun demos/03-two-questions.ts`

Exit 0, **11.5s**, `demo 3: OK`. Self-contained (own gauntlet on a free port, own headless Chromium, own
daemon under `.scratch/demo3/<ts>/`). The five sections printed real reports matching the excerpts in
`docs/using-disco.md` within noise: 1a `settled:network (settled 185ms …)` + `eval: "loading…"`;
1b `✓ until: matched in 1043ms`, `eval: "idle"`; 2 `POST → 202 {"id":1,"pending":true,…}`, `GET status → 200 (window)`;
3 `diagnosis: occluded by <div role="dialog" … id="record-modal"…>`; 4 `no-effect` + `✗ until: NOT matched in 799ms — budget-expired`;
5 `{"resolveMs":4,"absorbMs":307,"preMs":6,"settleMs":0,"reportedMs":500,"untilMs":799,"waitMs":803,"postMs":7,"buildMs":1,"overheadMs":18,"totalMs":1128}`.
Leaves an empty `.scratch/demo3/` behind (gitignored). Every report still says "(ambient classifier immature)".

## Part 2d — `bun scripts/timing-report.ts gauntlet` (final, daemon stopped)

```
gauntlet: 33 action(s) across 3 run(s)

verdict               n  settle_ms                    wait_ms (page)               overhead_ms (daemon)
settled:network      17  p50 302  p90 434  max 1472   p50 612  p90 1662  max 2078  p50 24  p90 39  max 51
diagnosis             6  p50 0  p90 0  max 0          p50 0  p90 0  max 0          p50 0  p90 0  max 0
settled:visual        5  p50 56  p90 1113  max 1181   p50 356  p90 1415  max 1481  p50 25  p90 111  max 113
settled:dom           2  p50 52  p90 52  max 72       p50 352  p90 352  max 372    p50 16  p90 16  max 23
no-effect             2  p50 0  p90 0  max 0          p50 499  p90 499  max 500    p50 19  p90 19  max 24
new-target            1  p50 37  p90 37  max 37       p50 40  p90 40  max 40       p50 63  p90 63  max 63

until: 8 action(s), matched 8; elapsed p50 411  p90 1363  max 1778

overhead share: 4% of total act() time is daemon work (resolve + snapshots + report build)
```

## Part 3 — "did the docs teach me": `demos/coldrun-rows.ts` (18 lines, docs only)

Written from README "The library" + "Report & watch shapes" + using-disco "Discover" only (no `src/`,
`cli/`, `test/` opened). Ran against run 3 while it was live, first try, 0.67s:

```
1. verdict: settled:network
2. until: matched=true after 71ms
3. rows off the wire: 10000 (GET /api/rows → 200, 4ms); row 9741 = {"id":9741,"name":"Zebra-Row-9741","group":"G1"}
4. timing: page 359ms (settled 58, reported 359, until 71) + overhead 30ms (resolve 10, pre 10, post 9, build 1) + scroll-absorb 241ms = 629ms
```

(`connect("gauntlet")`, `s.click(sel, { until: { urlLike, landed: true } })`, `r.wire.attributed[i].{m,p,s,ms,body}`,
`s.store.json(hash)`, `r.timing.*` — every field the README names existed with the documented meaning.)

## Friction items, in rough priority order

1. **`session new` runs its mandatory idle observation before the page exists, so it learns nothing.**
   README and demo 1 both say "session new … then open http://localhost:4800". `session new` blocks for
   **30s** ("idle-observing 30000ms"; README says "~20s") against `0 scoped target(s)` and returns
   `families: 0, ambient: 0`. Consequences: every report in runs 1–2 ends with `(ambient classifier
   immature — consider \`disco idle\`)`, the quickstart click verdict is `settled:visual` at 1113ms instead
   of the README's `settled:network` at 112ms, and in demo 1 the heartbeat showed up **inside act:2's
   attributed list untagged** (`⇄ GET /api/heartbeat → 200 …` with no `(ambient)`), the exact leak the idle
   phase exists to prevent. Demo 1's "enable ambient first for a livelier profile" cannot work in this
   order. Fix: swap the two steps in the docs (or use `--url`), and/or have `session new` print "0 scoped
   targets — nothing to learn from; open the page and run `disco idle`" instead of silently burning 30s.
2. **`act` went to the wrong page and there is no documented way to choose.** Demo 1 ends with "open the
   child window"; demo 2 then starts a session on the same browser and its first three commands all
   returned `✗ not-found … near matches: <button id="child-fetch">` — the daemon made `child.html` the
   `primary` target. `disco targets` shows `primary: true/false` but `act` has `--frame`, not `--target`, and
   no doc explains how primary is picked or changed. I had to close the window via the DevTools HTTP
   endpoint (outside disco). After that the survivor shows `primary: false` yet `act` works — so the flag
   means something other than "where act goes". Fix: document the rule; add `--target` / `session focus`;
   have `not-found` diagnoses name the target they resolved in when more than one is scoped.
3. **Demo 1's SQL steps interleave runs and never say so.** The store is one run-tagged history per app and
   every `t` is *run-relative*; demo 1 steps 6 and 10 (`ORDER BY t_start`, `ORDER BY t`) and demo 2 step 9
   select neither `run` nor filter on it. Step 6 shows `/iframe.html`, `/ctl`, `/api/grid` twice and run 1's
   `/api/slow, /api/chart/a, /api/chart/b` sandwiched between run 2's `/api/record/1` and `POST /api/save`;
   step 10 shows two `hello` frames and run 1's `action load-chart` between run 2's `record-1` and `push n:7`;
   demo 2 step 9 returns 2 rows for "the" body. The README quickstart query does include `run`. Fix: add
   `WHERE run=(SELECT max(run) FROM runs)` (or `run,` in the SELECT) to every demo query and state once that
   `t` restarts per run.
4. **Table output truncates cells at 60 chars with no marker.** The `shot` sha256 in demo 1 step 9 prints as
   60 hex chars; the doc says "then `disco blob <shot-hash>`". It only worked because `blob` prefix-matches
   (undocumented — so does the 12-char `shot:` handle in reports). `--json` gives the full value; nothing
   says so. Fix: an ellipsis or `--wide`; document that every hash argument accepts a prefix.
5. **Demo 2 step 4's "~1000ms" does not reproduce as written.** Run back-to-back, the `--until-fn` click
   fires inside the previous click's 900ms render gap: `✓ until: matched in 583ms`. With a
   `disco watch --fn "…=== 'idle'"` between them (which `demos/03` does with `until(s, …)`), it is **1363ms**
   — and the "~1000ms" figure itself assumes `slowMs:100` (demo 3's ctl), not the default 400. Fix: add the
   wait and say "≈ slowMs + renderDelayMs".
6. **Demo 2 step 8's second command fails as written.** `rightclick '#ctx-target'` leaves `#ctx-menu` open;
   the next line, `dblclick '#dbl-target'`, returns `diagnosis ✗ occluded — occluded by <ul role="menu"
   id="ctx-menu">`. Good diagnosis, wrong doc: it presents three independent examples. Fix: "press Escape
   or pick a menu item first", or reorder to dblclick / drag / rightclick.
7. **README's sample output is from a different configuration than the quickstart produces.** Default
   `slowMs` is 400, so `/api/slow` takes ~405ms (README: 104ms) and, with #1, the verdict is `settled:visual`
   at 1113ms/7 px (README: `settled:network` 112ms/1 px) plus a nag line the sample doesn't show. A newcomer
   can't tell whether `settled:visual` means something is broken. Fix: paste output from a default run, or
   state the knobs the sample used.
8. **"Classifier immature" never says what would satisfy it.** After 30s idle with 10 polls and 6 heartbeats
   observed and already labeled `periodic`, the nag stayed on for ~3.5 more minutes (through act:21) and
   then vanished at act:22. Neither README nor using-disco.md gives the criterion or an expected duration;
   `disco idle` prints `"immature": true` and nothing actionable. Fix: print the missing condition
   ("need N more cycles of X" / "needs 120s of observation, 41s so far").
9. **`disco help` omits a flag the demos rely on.** It lists `--until sel|--until-fn|--until-url` but not
   `--until-landed`, which demo 2 uses in steps 5, 6 and 9 (it works); and `watch` spells its budget
   `--budget` while `act` spells the postcondition's `--until-budget`. Fix: list every flag in `help`.
10. **Three spellings of "which app" for `disco sql`.** README: `disco sql gauntlet "…"`; demo 1:
    `disco sql "…" --app gauntlet`; demo 2 step 9: neither (current app). All work; a reader can't tell which
    is canonical or that they're equivalent until they try. Fix: pick one for the docs and mention the alias once.
11. **A freshly opened tab's first document requests are not recorded in attach mode.** `GET /` and
    `/app.js` never appear in `requests` for the tab opened after `session new` (the daemon attaches after
    navigation has begun); the run-2 tab shows `/style.css` and `/app.js` but not `/`. README's "records
    every request" reads as if the document would be there. Fix: one sentence in the capture-limits
    section ("the navigation that creates a tab is an unobserved prefix; use `--url` or reload").
12. **Small things.** `act scroll '#rows'` prints `act:7  scroll  →` (selector dropped from the header line).
    `demos/03` leaves an empty `.scratch/demo3/` (gitignored). `docs/using-disco.md` and `apps/README.md`
    name `apps/openemr/lib.ts` and `apps/saucedemo/lib.ts` as worked examples; neither exists in this
    worktree. Demo 1 step 9's `--out toast.jpg` drops the file in the cwd (the repo root) without saying so.
    `report.until.elapsedMs` origin ("from dispatch") is documented only implicitly via the timing line.

## What worked notably well (keep)

- **Nothing ever hung.** 33 actions; every `act` returned in ≤2.5s wall; every diagnosis in ~40–50ms with a
  reason, near-matches, pending requests and a screenshot handle. The occlusion diagnosis named the
  blocker both times it happened (the allergy modal *and* my accidental context menu).
- **The library docs are sufficient to write a working script cold.** Part 3 worked first try from the
  README's ten-line snippet plus "Report & watch shapes": `until: { urlLike, landed: true }` matched in 71ms,
  `wire.attributed[i].{m,p,s,ms,body}` were structured as promised, `store.json()` handed back all 10,000
  rows and `Zebra-Row-9741` in the same process, `timing.*` had every documented field.
- **`demos/03-two-questions.ts` is a superb executable doc** — 11.5s, self-contained, five real reports that
  match the field guide's excerpts, and it is what taught me the fix for friction #5.
- **The store answers everything after the daemon is gone**: FTS found `Zebra-Row-9741` in a body that was
  never on screen; the toast screenshot came out of a sentinel row; `timing-report` runs in 34ms with the
  daemon down; `session end` is instant.
- **Handles are prefix-matched** (`blob cc6ad210d277 …` worked from the report's 12-char `shot:` handle).
- **`type` vs `fill` semantics are visible in the UI delta** (`zeb` → `zebzeb` → `ada`), and the optimistic-UI
  report (step 5) matched the doc line for line: `202 ✎write`, the late `GET /api/save/status` attributed,
  the toast sentinel with a shot.
- **`disco tail`** is readable JSONL that correlates `act:N` with its requests, WS frames and `until` outcome.

## Outside the allowed docs

Nothing. `src/`, `cli/`, `test/`, `DECISIONS.md`, `STATE.md`, `REVIEW.md`, `BRIEF.md` and the git history were
not opened. The one non-listed file consulted was `gauntlet/scenarios.md` §27 (allowed) to understand
`renderDelayMs` for friction #5. The CLI was only run (`disco help` for the flag list).
