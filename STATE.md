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
- Slice 8: methodology dry run (fresh agent) + artifact gate.

## Slice 8 — PASSED (2026-08-30)
- Stage (a): a fresh Fable agent ran a full discovery session against the gauntlet-as-unknown-app (51 acts): artifacts/ holds nav-and-quirks.md, ledger.md (interstitial n=5/5 with hypothesis + experiments), friction.md, and 3 tested defensive scripts. Commit 35ad2f6.
- Stage (b): a SECOND cold agent, given only artifacts/ + README, executed "open a record and extract row names via the wire" FIRST TRY under both modal states with zero fixes (records 2 and 3; interstitial acknowledged then absent; 10,000 rows via the 496KB /api/rows body, task-attributed).

## Next
- Dogfood against a real EHR demo environment (BRIEF §5): measure settle-time distributions, tune defaults.ts, test the ambient classifier on real long-polls, judge digests, keep a friction log. Needs Josh to pick the environment.
- OPEN decisions to revisit with dogfood data: content-based attribution fallback, screencast cost on a real desktop, digest token budget, HTML5 native DnD, diff-highlighted shot variant. (launch mode, storage state, reconnect) → 7 (frame/shadow selector acceptance) → 8 (methodology dry run by a FRESH agent).

## How to run
- `bun install`; gauntlet: `bun gauntlet` (or `bun run gauntlet/server.ts --port 4800`)
- All tests: `bun test` (launches its own headless chromium; scratch in .scratch/)
- Typecheck: `bunx tsc --noEmit -p .`
- Manual attach: `chromium --remote-debugging-port=9222 --user-data-dir=~/hobby/.agent-scratch/disco/profile` then `bun cli/disco.ts session new s1 --attach 9222 --scope localhost:4800`
- Re-vendor selector engine: `bun run scripts/vendor-injected.ts`

## Gotchas discovered (see DECISIONS #16–23)
- Budget = time since last attributed network evidence (suspended while in flight, maxBudgetMs cap).
- Ambient DOM roots + visual ignore mask + ambient families all need idle observation — `disco idle` / session-new default.
- Unread fetch bodies never emit loadingFinished → "unread" demotion after 1.2s grace.
- scrollIntoView repaints the whole viewport → absorbed before the causality window opens.
- Small-target self-repaint (pressed/focus) suppressed from the visual channel.
