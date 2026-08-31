# Discovery subtask scripts (gauntlet)

Small defensive transitions/extractions against a **live disco session**, per GUIDANCE §7.7/§9.
Each asserts its precondition state, acts **with its postcondition on the click** (`until`), and verifies
the result **on the wire**; failures exit non-zero with an observation dump (verdict + wire + diagnosis),
never a bare timeout.

## Running

A disco daemon must be attached to the browser showing the app (see repo README):

```bash
cd /home/jmandel/hobby/discovery-docs-original-take/disco                       # repo root
bun gauntlet &                                                                   # the app on :4800
bun cli/disco.ts session new gauntlet --attach <cdp-port> --scope localhost:4800  # if not already running
bun apps/gauntlet/scripts/open-record.ts 3
bun apps/gauntlet/scripts/extract-rows.ts            # summary; --json for the full 10k rows
bun apps/gauntlet/scripts/save-verified.ts           # WRITE: POSTs /api/save
```

Scripts use the *current* app (`apps/.current`). To target another: `DISCO_APP=<app> bun apps/gauntlet/scripts/…`.
They import `../../src/client.ts` relative to this directory, so keep them in place (or adjust the import).

| script | write footprint | what it defends against |
|---|---|---|
| `open-record.ts <n>` | read-only | the delayed "Allergy Review Required" interstitial: clears a stale modal, retries once on occlusion, waits out + acks the ~430ms-late modal (present OR absent); the click's postcondition is the attributed `GET /api/record/<n>` LANDING, and the record is read from that body, not the DOM |
| `extract-rows.ts` | read-only | virtualized DOM (23 of 10,000 rows rendered): reads the full list from the captured `GET /api/rows` body, reusing the store when possible |
| `save-verified.ts` | **write** (`POST /api/save`) | optimistic UI: `until` the async `GET /api/save/status` lands keeps it attributed to the click (not `trailing`), so the report itself carries the 202-then-200/500 story behind "Saved ✓"; the toast is corroboration |

Tested during the discovery session on 2026-08-30 — see `../nav-and-quirks.md` (test acts cited there)
and the app's store (`apps/gauntlet/store/`) for the underlying evidence. The composable form of these
scripts is `../lib.ts` (`openRecord`, `extractRowNames`, `search`), exercised by `test/gauntlet/lib.test.ts`.
