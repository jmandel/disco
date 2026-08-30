# STATE.md — loop memory (cold-start readable)

## Done
- Repo scaffolded; GUIDANCE.md/BRIEF.md revised to v0.2 (DECISIONS.md #1–15); Playwright InjectedScript vendored (`bun run scripts/vendor-injected.ts`).

## In progress
- Milestone 0 (gauntlet) — subagent building `gauntlet/`.
- Slice 1 — CDP client, store, daemon, instrumentation.

## Next
- Slice 2 (act + settlement timing suite) → 3 → 4 → 5 → 6 → 7 → 8.

## How to run
- Install: `bun install`
- Gauntlet: `bun run gauntlet/server.ts --port 4800` (also `bun gauntlet`)
- Tests: `bun test` (unit + gauntlet); `bun test test/unit`; `bun test test/gauntlet`
- Typecheck: `bunx tsc --noEmit -p .`
- Re-vendor selector engine after bumping playwright-core: `bun run scripts/vendor-injected.ts`
- Chromium for manual attach: `chromium --remote-debugging-port=9222 --user-data-dir=/home/jmandel/hobby/.agent-scratch/disco/profile`
