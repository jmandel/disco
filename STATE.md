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

## Storage layout (2026-08-31)
- **One home per app: `apps/<product>/`** — committed pack (nav-and-quirks/lib.ts/check.ts/ledger) + gitignored `store/` (the app's WHOLE history: one `store.sqlite` with every run-scoped row tagged by `run`, shared `blobs/`, `stream.jsonl`, `daemon.sock`). No top-level `sessions/`.
- A **run** = one episode; `session new <app>` opens one, `session end` closes it, a daemon restart resumes the open run + its clock. One active run per app at a time (single SQLite writer). Ephemeral test/check runs live in `.scratch/`.
- Query one app's whole history in one shot: `disco sql <app> "SELECT run, method, path FROM requests WHERE path LIKE '%X%'"` (or `openApp("<app>")` in TS). See DECISIONS #34, PLATFORM.md.

## How to run
- `bun install`; gauntlet app: `bun gauntlet`. Explore: `disco session new <app> --attach <port> --scope <host>`; query: `disco sql <app> "…"`; drift: `bun scripts/run-check.ts <app>`.
- All tests: `bun test` (launches its own headless chromium; scratch in .scratch/)
- Typecheck: `bunx tsc --noEmit -p .`
- Manual attach: `chromium --remote-debugging-port=9222 --user-data-dir=~/hobby/.agent-scratch/disco/profile` then `bun cli/disco.ts session new gauntlet --attach 9222 --scope localhost:4800`
- Re-vendor selector engine: `bun run scripts/vendor-injected.ts`

## Gotchas discovered (see DECISIONS #16–30)
- Budget = time since last attributed network evidence (suspended while in flight, maxBudgetMs cap).
- Ambient DOM roots + visual ignore mask + ambient families all need idle observation — `disco idle` / session-new default; EHR heartbeats are ~60s so warm up ≥2 min.
- Unread fetch bodies never emit loadingFinished → "unread" demotion after 1.2s grace.
- scrollIntoView repaints the whole viewport → absorbed before the causality window opens.
- Small-target self-repaint (pressed/focus) suppressed from the visual channel.
- Verdict labels are best-effort: ambient content rendering in the settle tail can retag network→dom without changing timing (DECISIONS #30) — assert timing+attribution, not the label, in non-interference tests.
- Function libraries live in the pack (`apps/<target>/lib.ts`), generic moves in `lib/`; live checks are `check.ts` (not `*.test.ts`) so `bun test` stays offline.
