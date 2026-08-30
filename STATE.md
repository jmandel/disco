# STATE.md — loop memory (cold-start readable)

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

## In progress
- Nothing open — v1 done, Slice 8 passed, dogfood #1 complete.

## Slice 8 — PASSED (2026-08-30)
- Stage (a): a fresh Fable agent ran a full discovery session against the gauntlet-as-unknown-app (51 acts): artifacts/gauntlet/ holds nav-and-quirks.md, ledger.md (interstitial n=5/5 with hypothesis + experiments), friction.md, and 3 tested defensive scripts. Commit 35ad2f6.
- Stage (b): a SECOND cold agent, given only artifacts/ + README, executed "open a record and extract row names via the wire" FIRST TRY under both modal states with zero fixes (records 2 and 3; interstitial acknowledged then absent; 10,000 rows via the 496KB /api/rows body, task-attributed).

## Dogfood #1 — DONE (OpenEMR 8.3.0 demo, 2026-08-30)
- Full physician login → patient finder → chart-open driven by act() against demo.openemr.io; artifacts/openemr/dogfood-1.md + screenshots, session store sessions/openemr/. Confirmed on a real EHR: nested-iframe frame-scoped acts, wire-available clinical facts (finder JSON + summary HTML fragments), a native-alert conditional interstitial (auto-handled + ledgered), correct occlusion diagnosis on a hidden tab, and the ambient classifier catching OpenEMR's real 60s heartbeat trio as periodic (cv≈0). Tuning applied: classifierWarmupMs 20s→90s, idle 30s, digestMaxUiLinesNav 12 (DECISIONS #29).

## Next
- Dogfood #2: full OpenEMR nav-and-quirks doc + tested subtask scripts (open-patient, extract-problem-list-from-wire); probe the interstitial hypothesis (a patient with no due reminders).
- OPEN (revisit with more dogfood data): POST-that-reads write-flag heuristic (OpenEMR renders read panels via POST); settle-time distributions across more patients; content-based attribution fallback (NOT needed for OpenEMR); screencast cost on a real desktop; HTML5 native DnD; diff-highlighted shot variant.

## How to run
- `bun install`; gauntlet: `bun gauntlet` (or `bun run gauntlet/server.ts --port 4800`)
- All tests: `bun test` (launches its own headless chromium; scratch in .scratch/)
- Typecheck: `bunx tsc --noEmit -p .`
- Manual attach: `chromium --remote-debugging-port=9222 --user-data-dir=~/hobby/.agent-scratch/disco/profile` then `bun cli/disco.ts session new s1 --attach 9222 --scope localhost:4800`
- Re-vendor selector engine: `bun run scripts/vendor-injected.ts`

## Gotchas discovered (see DECISIONS #16–29)
- Budget = time since last attributed network evidence (suspended while in flight, maxBudgetMs cap).
- Ambient DOM roots + visual ignore mask + ambient families all need idle observation — `disco idle` / session-new default.
- Unread fetch bodies never emit loadingFinished → "unread" demotion after 1.2s grace.
- scrollIntoView repaints the whole viewport → absorbed before the causality window opens.
- Small-target self-repaint (pressed/focus) suppressed from the visual channel.
