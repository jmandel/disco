# gauntlet — where the facts live

Every row cites an act id from `apps/gauntlet/store/` (run 1) or a `disco sql` query you can re-run.
`R/W` is the daemon's per-request `write_kind` as observed, not a guess.

## Origins

| origin | what it serves |
|---|---|
| `http://localhost:4800` | the app, its assets, every `/api/*` below, the control channel, the WS and both SSE streams |
| `http://localhost:4801` | **one file** — `xframe.html`, the cross-origin iframe island in section 10, plus its own `POST /api/xframe-submit` |

`--scope localhost:4800` is enough: scope selects *tabs*, not hosts, so the :4801 sub-frame's traffic is
recorded as part of the scoped page (act:20).

## Endpoint families

| family | R/W | what it carries | cite |
|---|---|---|---|
| `GET /` , `/app.js`, `/style.css`, `/iframe.html`, `/iframe2.html`, `4801/xframe.html` | read | the shell + its three iframe documents; re-fetched on every navigation | act:31 |
| `GET /ctl` | read | **the whole scenario state** as JSON — the single most useful body in the app (below) | act:31 body `d8d884fd` |
| `POST /ctl` | **write** | patch the scenario state; returns the full new state. Global — it changes behaviour for every viewer | act:32 |
| `GET /api/slow` | read | `{"ms":400,"at":…}` — the deliberately slow leg of Load Chart; `ms` echoes `ctl.slowMs` | act:1 body `5e259c81` |
| `GET /api/chart/a`, `/api/chart/b` | read | `{"series":"a","points":[1,3,2,5,4]}` — the chart data. Both bodies are byte-identical run to run (same hashes `e565556a` / `89cf1590` across acts 1,2,35,36,46,47) | act:1 |
| `GET /api/record/<id>` | read | `{"id","name","dob","mrn","allergies":[…]}` — one patient-shaped record. ids 1-5 | act:8 body `f0056a3f` |
| `GET /api/rows` | read | **all 10,000 rows** `[{"id","name","group"},…]` in one 200. The DOM shows ~23 | act:6 body `70f7def9` |
| `GET /api/search?…` | read | the debounced search hits (250ms trailing) | act:9 body `9cf0e368` |
| `GET /api/meds?…` | read | combobox options; fired **per keystroke**, not debounced | act:10 |
| `GET /api/grid` | read | the canvas contents — `{"rows":4,"cols":8,"cells":[{r,c,label}×32]}`. Fetched at page load, so it is available before you ever touch section 16 | act:45 body `8d63deae` |
| `POST /api/save` | **write** | `202 {"id":1,"pending":true,"received":{…}}` — accepted, *not* saved | act:4 body `acfec170` |
| `GET /api/save/status` | read | **the truth about the save** — `200` or `500`. Body is `[unread]` (the page never reads it), so the *status code* is the fact | act:4 (200), act:37 (500) |
| `DELETE /api/item/<id>` | **write** | `{"deleted":1}` | act:5 body `78000dac` |
| `POST /api/graphql` | **both** | one URL, two footprints. `{"query":"query { patient { name } }"}` → `write_kind=read`, `{"data":…,"sawMutation":false,"operation":"query"}`. `{"query":"mutation { rename(…) }"}` → `write_kind=write`, `"sawMutation":true`. The daemon's GraphQL body peek gets this right per request | act:21 / act:22 |
| `POST /api/iframe-submit` | **write** | fired from *both* same-origin iframes (`iframe.html` and the depth-2 `iframe2.html`) — identical response body `bd68db39` | act:18, act:19 |
| `POST /api/xframe-submit` (on **:4801**) | **write** | the cross-origin island's submit | act:20 |
| `POST /api/drag-report` | **write** | fired at the end of every mouse drag (slider and reorder). Body `[unread]` | act:24, act:25 |
| `POST /api/login` | **write** | `{"user","pass"}`. **Accepts any non-empty pair**; empty either side → `401 {"ok":false,"error":"user and pass required"}`. Sets an HttpOnly cookie (`document.cookie` stays empty) | act:41 |
| `GET /secure.html` | read | `302 → /login.html?next=/secure.html` when `ctl.requireAuth` and no cookie; `200` otherwise | act:38 |
| `GET /api/sse` | read | **streaming — body never captured** (`body_state=streaming`). The five events are rows in `sse_events` | act:23 |
| `GET /api/heartbeat` | read | ambient when `ctl.ambient` — 5s cadence | families |
| `GET /api/poll` | read | ambient — a long-poll held `ctl.pollHoldMs` (3s) and re-issued | families |
| `GET /api/notify-sse` | read | ambient — the notification EventSource, opened at page load, re-connects | families |

## The one body worth memorising: `GET /ctl`

```json
{"slowMs":400,"renderDelayMs":0,"modal":false,"modalDelayMs":400,"toastMs":2000,"saveFails":false,
 "ambient":false,"heartbeatMs":5000,"pollHoldMs":3000,"wsPushMs":7000,"timeoutMs":0,
 "rerenderOnHover":true,"requireAuth":false,"notifyPollHoldMs":25000,"notify":false,
 "xOrigin":"http://localhost:4801"}
```
Boot state, read from `GET /ctl` on run 1 (act:31, body `d8d884fd`). **Every hostile behaviour in this
app is a key here and is OFF or 0 by default.** Read it first: it tells you, in one request, which of
the traps are armed for the session you are about to characterise. It is also broadcast to every open
tab as a `{"type":"ctl","state":{…}}` WebSocket frame whenever it changes.

## Reads delivered over POST

- `POST /api/graphql` with a `query` operation — classified `read`, does not trip the write flag (act:21).
- `POST /ctl` is *not* a read despite looking like config: it changes global app behaviour and is
  correctly flagged `write`.
- Everything else non-GET in this app genuinely writes. The write flag needed no manual correction here.

## Standing channels

| channel | opened | carries | store table |
|---|---|---|---|
| `ws://localhost:4800/ws` | at page load, before first paint | `{"type":"hello","id":N,"state":{…}}` on connect; `{"type":"echo","id":"<button id>",…}` for **every button click except `#noop`**; `{"type":"ctl","state":{…}}` on every scenario change; `{"type":"push","n":N,…}` for section 23 notifications and the `ctl.wsPushMs` (7s) ambient push | `websockets`, `ws_frames` |
| `GET /api/notify-sse` (EventSource) | at page load | section 23 notification results when `push:"sse"` | `sse_events` |
| `GET /api/sse` (EventSource) | on `#start-sse` | 5 messages `{"stream":N,"i":1..5,"msg":"event i of 5"}` | `sse_events` |
| `GET /api/poll` (long-poll) | continuously when `ctl.ambient` | held `pollHoldMs`, re-issued; also the `push:"poll"` carrier (held up to `notifyPollHoldMs`=25s) | `requests` |

**Results are delivered over these channels, not just heartbeats.** Section 23 answers `POST /ctl
{"notify":true,"push":"ws"|"sse"|"poll"}` by pushing `Result N via <carrier>` down the chosen standing
channel — the action's *result* never appears as a response body. Measured latency after the trigger:
ws 1ms, sse ~1ms, poll 3ms. `lib.ts::waitForPush` is the flow for it.

The WS echo per click is worth knowing when reading reports: it re-renders the header status bar, so
**every** act's aria delta contains a `ws: open · frames: N …` line. That is signal about the socket,
noise about your click.
