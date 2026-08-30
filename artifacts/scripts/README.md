# Discovery subtask scripts (gauntlet @ localhost:4820)

Small defensive transitions/extractions against a **live disco session**, per GUIDANCE §7.7/§9.
Each asserts its precondition state, acts, settles, and verifies its postcondition **on the wire**;
failures exit non-zero with an observation dump (verdict + wire + diagnosis), never a bare timeout.

## Running

A disco daemon must be attached to the browser showing the app (see repo README):

```bash
cd /home/jmandel/hobby/discovery-docs-original-take/disco   # repo root — session resolution is cwd-relative
bun cli/disco.ts session new dryrun --attach <cdp-port> --scope localhost:4820   # if not already running
bun artifacts/scripts/open-record.ts 3
bun artifacts/scripts/extract-rows.ts            # summary; --json for the full 10k rows
bun artifacts/scripts/save-verified.ts           # WRITE: POSTs /api/save
```

Scripts use the *current* session (`sessions/.current`). To target another:
`DISCO_SESSION=<name> bun artifacts/scripts/…` or `DISCO_SESSIONS_DIR=… `. They import
`../../src/client.ts` relative to this directory, so keep them in place (or adjust the import).

| script | write footprint | what it defends against |
|---|---|---|
| `open-record.ts <n>` | read-only | the delayed "Allergy Review Required" interstitial: clears a stale modal, retries once on occlusion, waits out + acks the ~430ms-late modal (present OR absent); verifies the record from the attributed `GET /api/record/<n>` body, not the DOM |
| `extract-rows.ts` | read-only | virtualized DOM (23 of 10,000 rows rendered): reads the full list from the captured `GET /api/rows` body, reusing the store when possible |
| `save-verified.ts` | **write** (`POST /api/save`) | optimistic UI: reports screen-vs-wire divergence (202 `pending:true` behind "Saved ✓") and corroborates completion via `GET /api/save/status` + toast |

Tested during the discovery session on 2026-08-30 — see `../nav-and-quirks.md` (test acts cited there)
and the session store `sessions/dryrun` for the underlying evidence.
