# gauntlet — variability ledger

Observed vs inferred is explicit. `n` is how many times I saw it in run 1 (acts 1-63) plus the two
`run-check` runs where noted. "Resolving experiment" is what a future session should run.

## Resolved during this pass

| # | what varied | n | hypothesis | resolving experiment | outcome | evidence |
|---|---|---|---|---|---|---|
| 1 | The app was silent at rest, then produced a heartbeat + long-poll + SSE reconnect | n=2 states | **Observed:** all periodic traffic is gated by `ctl.ambient`, off at boot | `GET /ctl` at instrument time; flip `ambient:true` and `disco idle 26000` | Confirmed. 3 ambient families learned (heartbeat 5s, poll 3s hold, notify-sse). Classifier correct with no override | act:31 body `d8d884fd`; `disco idle` digest |
| 2 | `#chart-status` was `"idle"` immediately in one run and `"loading…"` in another for the same click | n=4 | **Observed:** `ctl.renderDelayMs` inserts a client-side gap between the last response and the render | click with no `until` at `renderDelayMs:0` vs `:900` | Confirmed: settled 415ms / screen "loading…" (act:35) vs postcondition matched 618ms (act:36). **Settlement is not readiness** | act:1 vs act:35/36 |
| 3 | `#save-state` said "Saved ✓" on both a successful and a failed save | n=2 | **Observed:** optimistic UI — the DOM never reflects the async result | `ctl.saveFails:true`, then compare DOM to `GET /api/save/status` | Confirmed: status 500, screen still "Saved ✓" **permanently**. Only a 2s toast + the wire disagree | act:4 (200) vs act:37 (500) |
| 4 | A click that worked once returned `diagnosis: occluded` later | n=3 | **Observed:** two overlays arrive *after* their triggering act settles | arm `ctl.modal`, open a record, click something else | Confirmed: `#record-modal` at +400ms (act:33); `#session-timeout` on the idle timer (act:48); the combobox's own section occludes its options (act:55) | act:33/48/55 |
| 5 | `#med` fired a request per keystroke; `#search` fired one for two keystrokes | n=2 each | **Observed:** section 7 debounces (250ms trailing), section 17 does not | count requests per typed char; read the `q` echo in the body | Confirmed: one `?q=ad` for "ad"; two `/api/meds` (`?q=a`, `?q=as`) for "as" | act:9 vs act:10 |
| 6 | `POST /api/graphql` tripped the write flag on one act and not the other | n=2 | **Observed:** the daemon peeks the GraphQL body — `query` is a read, `mutation` a write | `SELECT write_kind FROM requests WHERE path LIKE '%graphql%'` | Confirmed per-request: act:21 `read`, act:22 `write`. Family aggregate reads `read`; **trust the request row, not the family** | SQL, act:21/22 |
| 7 | `#rows` showed 23 rows for a 10,000-row dataset | n=3 | **Observed:** virtualization over a 240,000px spacer with recycled nodes | set `scrollTop` and re-read the same nodes | Confirmed: at scrollTop 120000 the same 23-28 `.row` nodes read "Zebra-Row-4995". Row 9999 is reachable **only** on the wire | act:6 + evaluate probe |
| 8 | `s.scroll({target:"#rows"})` left `scrollTop` at 0 | n=1 | **Inferred then confirmed:** the wheel goes where the pointer is, and the pointer was not over the container | `hover("#rows")` then scroll | Confirmed: scrollTop 0 → 122000 after hovering first. Recorded as a technique, not a tool bug | §7 of nav-and-quirks |
| 9 | `recordModalUp()` answered `false` immediately after an unacked `openRecord` | n=1 | **Observed:** a 0-budget watch asks "is it up *now*", and the overlay is 400ms away | give the watch a 1500ms budget | Confirmed — the first `run-check` failed exactly here and the second passed. The delay is the finding | run-check #1 vs #2 |
| 10 | The login form accepted credentials I invented | n=2 | **Observed:** no password check at all | probe `nobody`/`wrong`, then empty | Any non-empty pair logs in ("Welcome, nobody"); empty → `401 {"error":"user and pass required"}` | act:41 + direct fetch |

## Standing / unresolved

| # | what varies (or might) | n | hypothesis | resolving experiment |
|---|---|---|---|---|
| 11 | `settled:network` vs `settled:dom` vs `settled:visual` for the *same* class of action | 66 acts | **Inferred:** the label is best-effort — whichever signal quiesces last wins, and the WS echo re-renders the header on every click, so a DOM-only action can be retagged. Assert timing + attribution, not the label (matches DECISIONS #30) | re-run one click 20× and histogram the verdict |
| 12 | Section 9's re-render race never actually detached an element | n=1 | **Inferred:** `rerenderOnHover` rebuilds the button on hover, but disco resolves late and dispatches immediately, so the window is too small to lose | `renderDelayMs` high + repeated `#rerender`; look for `target.detachedRetried` in the report |
| 13 | Push latency: ws 1ms, sse ~1ms, poll 3ms | n=1 each | **Inferred:** poll was fast only because `ctl.ambient` was on and a long-poll was already in flight | set `ambient:false`, then `push:"poll"` — expect up to `notifyPollHoldMs` (25s) |
| 14 | The 5 SSE events split across attribution windows | n=1 | **Observed:** events 1-2 attributed to act:23, event 3 to no action, events 4-5 to act:24 (the *next* act). Results on a standing channel are attributed by *when they arrive*, not by what caused them | `SELECT action_id FROM sse_events`; re-run with a long `until` covering all 5 |
| 15 | `POST /api/save` returned `{"id":1}` then `{"id":3}` across runs | n=4 | **Inferred:** a server-side counter, not per-save state; `GET /api/save/status` takes no id | two overlapping saves — does the status endpoint answer for the right one? |
| 16 | `targets.late = 1` even in `--launch --url` mode, and `GET /` is missing from run 1's requests | n=1 | **Inferred:** the daemon attaches after the launch navigation has begun, so the top-level document is an unobserved prefix even in launch mode (the docs say launch mode avoids this) | re-launch with `--no-idle` and compare; or `s.navigate` once after attach (which *did* capture `GET /`, act:31/act:45) |
| 17 | The child window at `/child.html` | n=1 | **Unobserved:** never focused or driven | `s.focusTarget(<id>)`, census its DOM/wire, check cookie + WS sharing |
| 18 | Cold-load hydration | n≈15 fills/types | **Unobserved** — no swallowed keystroke seen, but every one of those was on a warm page | `navigate` then `fill` in the same breath, repeatedly |

## Addenda from stranger #4 (Fable, 2026-08-31 — friction-stranger4.md; same app, same prompt, 22/22)

| # | What | n | Evidence |
|---|---|---|---|
| A1 | `POST /ctl` changes apply LIVE over the WebSocket (a `{type:"ctl",state}` frame), no reload; `POST /ctl/reset` restores defaults the same way | observed throughout its run | its acts 12–46 |
| A2 | **Layout shift can swallow a click**: a `#gql-query` click reached nothing (0 requests) because the SSE log above it grew between resolve and dispatch; its `graphql()` retries once | 1/2 | its act:27 vs act:35 |
| A3 | "Stay signed in" RE-ARMS the idle timer; only `ctl {timeoutMs:0}` disarms it, and an already-open dialog survives that | n=2 | its act:58–61 |
| A4 | `push:"poll"` delivers nothing unless `notify:true` (the long-poll loop is client-gated); with it, 66 ms | n=2 | its ledger row 5 |
