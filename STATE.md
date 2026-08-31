# STATE.md — loop memory (cold-start readable)

**Plan of record: `PLATFORM.md`** (the two-layer platform + the agreed plan). This file is the cold-start
*status*. Read order for a fresh agent: `PLATFORM.md` → this → `DECISIONS.md` → `GUIDANCE.md`.
Milestone tag: **`v0.1.0-platform-base`**.

## Done
- Docs v0.2 (GUIDANCE/BRIEF revised per REVIEW.md; DECISIONS #1–23).
- Milestone 0: gauntlet complete, behaviors 1–26 (incl. push-channels, context menu, dblclick, drag) — `bun test test/gauntlet/gauntlet-server.test.ts` 15/15.
- Slice 1: attach + store + always-on instrumentation (network/WS/SSE/console/dialogs/nav/downloads/screencast/mutations), target scoping, sentinels (dialog/toast/expiry/error/new-target), notes, CLI (session/tail/sql/note/families/idle/screenshot/blob/eval/cdp). Smoke-verified.
- Slice 5: client library E2E, same-script reduction, diffTrace, helpers verbatim, CLI acceptance, store-with-daemon-down — 6/6. README + demos 01/02.
- Slice 6: storage-state save/restore across browsers, daemon resume (same anchor/clock, late targets), blob dedup — 3/3.
- Slice 7: selector engine across main/same-origin/cross-origin frames + shadow DOM + chaining — 8/8.
- Slice 3: live ambient attribution (task/window/dependency/ambient), families w/ evidence, GraphQL write-flags, SSE capture, push-channel content over WS/SSE/long-poll — 7/7.
- Slice 4: sentinels (post-settlement modal w/ shot, toast frame timing, session-expiry, new-target + instrumented child, between-action 5xx) + RPC stream — 7/7.
- Slice 2: act()/settlement/report/watch/awaitSettlement, vendored Playwright selectors, input dispatch (click/right/dbl/middle/hover/type/press/scroll/select/navigate/drag), OOPIF coordinate translation, self-feedback suppression, scroll-absorb, ambient DOM roots, unread-body demotion — `bun test test/gauntlet/slice2.test.ts` 14/14; unit tests (settle, attribute) green.

## Readiness + responsiveness pass — P1/P2 DONE, P3 docs in progress (2026-08-30; DECISIONS #35–39)
- P1 engine: `act({until})` — the postcondition contract, daemon-side (window stays open while waiting; predicate-first caps
  settle to a short tail; settle-first watches on, then a seeded tail) → `report.until`; `awaitSettlement` owns the window over
  the background settler; one `signalFromEvent`; `pointToRoot` before `t0`; no inverted diagnosis cursors; `settled:late` typed;
  streaming UTF-8 RPC framer; gauntlet scenario 27 (`renderDelayMs` = the deterministic settled≠ready gap).
- P2 Layer 1 + packs: `lib/nav.ts` = `until` / `reached` / `assertVisible` (Playwright syntax, budgeted) / `actIfPresent` /
  `waitForFrame` — one selector language, zero sleeps in `apps/` + `lib/`; predicates `visible` / `landed` / `fnArg`; missing
  frames are diagnoses (act) or waited for (watch); `fill` kind + `KINDS` table; tree-scoped report queries; tunables in
  `defaults.ts`; `run-check` reads `target` from each pack (`apps/gauntlet/check.ts` added); packs refactored (saucedemo login
  waits for inventory OR error — the glitch user's `no-effect` click is safe by construction; OpenEMR's 5 loops → `until`).
- Responsiveness: `report.timing` (page vs daemon overhead), `scripts/timing-report.ts <app>`, per-step durations in check
  loops, tests pin no-op ≈500ms + <400ms overhead, event-driven watch (~Q), until-already-true cost, tail cap vs hung request.
- Baseline before the pass (P0): suite 89/89, run-check saucedemo 5/5; **the glitch user's login click settled `no-effect` at
  500ms and the old pack passed only because the frozen main thread stalled its next evaluate** (scratch notes, DECISIONS #35).
- P3 docs DONE: using-disco "The two questions" with real digests from `demos/03-two-questions.ts` (executed by a test),
  demo 02 rewritten, README/SURFACE/GUIDANCE/STATE synced.
- P4 fresh-eyes DONE (3 non-fork agents in gutted worktrees, docs-only reading): C cold-ran the quickstart + demos (8m49s,
  12 friction items, an 18-line script from the docs worked first try — `demos/04-rows-from-docs-alone.ts`); A rebuilt
  `apps/saucedemo` (14 min, 15/15 live incl. glitch user — pack adopted); B built `apps/openmrs` for OpenMRS O3 (20 min,
  6/6 live — pack adopted; `prompts/characterize-ehr.md` distilled from it). Logs: `demos/friction-coldrun.md`,
  `apps/saucedemo/friction-rebuild.md`, `apps/openmrs/friction.md`.
- P5 fold-back DONE (DECISIONS #40–42): docs order + `--target`/`focus` + run-filtered queries (C); Session surface on one
  screen, no-pipe launch, data: URLs, sentinel dedupe, evaluate args (A); burst-collapsed cadence + long-poll-shaped
  `chained`, API-first digest ranking, named ambient/pending requests, label hit-test, toast exclusions, `run-check ready` (B).
- Decided + built (DECISIONS #43): `until: { any | all }` with `which`; per-app URL-substring rules (`disco rules`, `families
  --ambient|--not-ambient <url-part>`, `session new --ignore`, `s.ignore/attend`); sentinel mutes (`disco sentinels --mute`,
  `s.mute`; recorded muted=1, never reported); ReferenceError in a page function fails fast with the closure hint.
- OPEN: query-key-aware family identity (only if rules prove insufficient); `until` nesting deeper than one level.

## In progress — platform build-out (PLATFORM.md plan)
- Slice 1 ✅ ways-of-knowing palette named in `apps/README.md` (descriptive, not a schema).
- Slice 2a ✅ function-library pattern on the gauntlet: `lib/wire.ts` + `lib/nav.ts` (generic reusable moves), `apps/gauntlet/lib.ts` (reference per-product library), `test/gauntlet/lib.test.ts`. Suite 87/87.
- Slice 3 ✅ usage & philosophy field guide `docs/using-disco.md` (instrument→explore→discover→characterize→automate, both instances as worked examples).
- Slice 4 ✅ per-pack `check.ts` + one-command runner `scripts/run-check.ts <target>` (fresh browser+session, runs the check, exits status). `run-check.ts openemr` green.
- 3rd instance ✅ `apps/saucedemo/` — Sauce Labs (client-rendered React SPA, no data API). DOM-first pack (`lib/nav`, no `lib/wire`) proving the reusable layer generalizes; full purchase flow via `run-check.ts saucedemo`. Fixed a real keyboard-typing bug (shifted punctuation like `_` dropped — DECISIONS #32).
- Slice 2b ✅ OpenEMR function library `apps/openemr/lib.ts` (login / findPatient [finder search past page 1] / openPatient / extractSummary, anchor-oriented, wire-first, defensive) + `apps/openemr/check.ts` live drift loop. Validated vs demo.openemr.io: Belford (page 1) + Stone (page 2 via search) end-to-end, idempotent. Fixed a real daemon bug (prune stale same-target child frames on main-frame re-navigation, DECISIONS #31). Retired site.json → folded into lib.ts + nav-and-quirks.md.

## Slice 8 — PASSED (2026-08-30)
- Stage (a): a fresh Fable agent ran a full discovery session against the gauntlet-as-unknown-app (51 acts): apps/gauntlet/ holds nav-and-quirks.md, ledger.md (interstitial n=5/5 with hypothesis + experiments), friction.md, and 3 tested defensive scripts. Commit 35ad2f6.
- Stage (b): a SECOND cold agent, given only apps/ + README, executed "open a record and extract row names via the wire" FIRST TRY under both modal states with zero fixes (records 2 and 3; interstitial acknowledged then absent; 10,000 rows via the 496KB /api/rows body, task-attributed).

## Dogfood #1 — DONE (OpenEMR 8.3.0 demo, 2026-08-30)
- Full physician login → patient finder → chart-open driven by act() against demo.openemr.io; apps/openemr/dogfood-1.md + screenshots, app store apps/openemr/store/ (run-tagged). Confirmed on a real EHR: nested-iframe frame-scoped acts, wire-available clinical facts (finder JSON + summary HTML fragments), a native-alert conditional interstitial (auto-handled + ledgered), correct occlusion diagnosis on a hidden tab, and the ambient classifier catching OpenEMR's real 60s heartbeat trio as periodic (cv≈0). Tuning applied: classifierWarmupMs 20s→90s, idle 30s, digestMaxUiLinesNav 12 (DECISIONS #29).

## Next — plan slices 1–4 all done; remaining is the "later" bucket (a direction call)
- MCP / agent-tool exposure of the pack function libraries.
- Deepen OpenEMR: encounter/notes flow, the save-flow ledger item; probe the interstitial hypothesis (a patient with no due reminders — ledger #1).
- PHI/retention posture when a non-demo target is used (until then: demo/BAA-covered only).
- OPEN (revisit with more dogfood data): POST-that-reads write-flag heuristic; settle-time distributions; content-based attribution fallback (NOT needed for OpenEMR); screencast cost on a real desktop; HTML5 native DnD; diff-highlighted shot variant.

## Storage layout (2026-08-30)
- **One home per app: `apps/<product>/`** — committed pack (nav-and-quirks/lib.ts/check.ts/ledger) + gitignored `store/` (the app's WHOLE history: one `store.sqlite` with every run-scoped row tagged by `run`, shared `blobs/`, `stream.jsonl`, `daemon.sock`). No top-level `sessions/`.
- A **run** = one episode; `session new <app>` opens one, `session end` closes it, a daemon restart resumes the open run + its clock. One active run per app at a time (single SQLite writer). Ephemeral test/check runs live in `.scratch/`.
- Query one app's whole history in one shot: `disco sql <app> "SELECT run, method, path FROM requests WHERE path LIKE '%X%'"` (or `openApp("<app>")` in TS). See DECISIONS #34, PLATFORM.md.

## How to run
- `bun install`; gauntlet app: `bun gauntlet`. Explore: `disco session new <app> --attach <port> --scope <host>`; query: `disco sql <app> "…"`; drift: `bun scripts/run-check.ts <app>`.
- All tests: `bun test` — 108 tests / 13 files (~150s; launches its own headless chromium; scratch in .scratch/). Live drift: `bun scripts/run-check.ts <saucedemo|openemr|gauntlet>` (gauntlet needs `bun gauntlet` running). Timing distribution of a recorded app: `bun scripts/timing-report.ts <app>`. The worked examples, live: `bun demos/03-two-questions.ts`.
- Typecheck: `bunx tsc --noEmit -p .`
- Manual attach: `chromium --remote-debugging-port=9222 --user-data-dir=~/hobby/.agent-scratch/disco/profile` then `bun cli/disco.ts session new gauntlet --attach 9222 --scope localhost:4800`
- Re-vendor selector engine: `bun run scripts/vendor-injected.ts`

## Gotchas discovered (see DECISIONS #16–39)
- **Settled ≠ ready.** The verdict says the page went quiet, not that the state you need exists (a >Q gap — timer, debounce, unattributed second hop — closes settlement early; a frozen main thread settles `no-effect`). Automation passes `until`; the verdict is the diagnostic when the postcondition fails (DECISIONS #35). `expect` never waits.
- `until`'s `urlLike` only counts requests that STARTED after dispatch; `watch()`'s counts started-or-landed since watching (`landed` = response + body captured).
- Every report has `timing`: if `overheadMs` grows, the daemon got slower, not the page.
- Budget = time since last attributed network evidence (suspended while in flight, maxBudgetMs cap).
- Ambient DOM roots + visual ignore mask + ambient families all need idle observation — `disco idle` / session-new default; EHR heartbeats are ~60s so warm up ≥2 min.
- Unread fetch bodies never emit loadingFinished → "unread" demotion after 1.2s grace.
- scrollIntoView repaints the whole viewport → absorbed before the causality window opens.
- Small-target self-repaint (pressed/focus) suppressed from the visual channel.
- Verdict labels are best-effort: ambient content rendering in the settle tail can retag network→dom without changing timing (DECISIONS #30) — assert timing+attribution, not the label, in non-interference tests.
- Function libraries live in the pack (`apps/<target>/lib.ts`), generic moves in `lib/` (`until`, `reached`, `firstOf`, `assertVisible`, `actIfPresent`, `waitForFrame` — Playwright selector syntax everywhere, no sleeps); live checks are `check.ts` (not `*.test.ts`) so `bun test` stays offline, and each exports `target = {url, scope}` for `run-check`.
