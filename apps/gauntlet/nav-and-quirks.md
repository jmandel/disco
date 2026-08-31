# Navigation & quirks — "disco gauntlet" @ http://localhost:4820 (session `dryrun`, 2026-08-30)

Discovery per GUIDANCE §7; evidence lives in `sessions/dryrun/store.sqlite` (+blobs). Citations are
action ids (`act:N`, rows in `actions` with full reports) and event cursors (`ev:a-b` in `events.seq`).
Companion docs: `ledger.md` (variability, n counts, experiments), `friction.md`, `scripts/`.

## 1. Layout

One SPA page (no framework detected — hand-rolled DOM + fetch; no React/Vue/Angular/jQuery globals):

- **Header** — a live status line: WS state + frame count, ambient counters, the **last WS frame**, and
  the app's **entire effective config as JSON** (`{"slowMs":400,"modal":true,"modalDelayMs":400,
  "toastMs":2000,"saveFails":false,"ambient":true,"heartbeatMs":5000,"pollHoldMs":3000,"wsPushMs":7000,
  "timeoutMs":0,"rerenderOnHover":true,"requireAuth":false,"notifyPollHoldMs":25000,"notify":true,...}`).
  Read it before anything else: it names the conditional branches. It also mutates on every WS frame —
  ambient DOM churn adjacent to all actions.
- **Main** — 26 numbered `SECTION#s-N` blocks, one behavior each (`act` census, ev around 1420).
  All controls carry stable ids (`#load-chart`, `#record-1..5`, `#save`, `#search`, `#load-rows`, …).
- **Frames**: same-origin `iframe#same-origin` (`/iframe.html`: name input + `POST /api/iframe-submit`)
  and cross-origin `iframe#cross-origin` (`http://localhost:4821/xframe.html`, posts to *its* origin's
  `/api/xframe-submit`). Cross-origin frame is a separate CDP target; address via `{frame:"xframe.html"}`.
- **Shadow DOM**: `#shadow-host` with open root (button + counter). **Canvas**: `#grid` 400×200, pixels
  only. **Child window**: `/child.html` via `#open-child`. **Aux pages**: `/login.html`, `/secure.html`
  (redirects), `/away.html`.

## 2. States (cheap predicates)

| state | predicate |
|---|---|
| `main` | url `/` + `#record-buttons` present |
| `main.recordOpen(n)` | `main` + `#record` text starts "Record n" (truth: attributed `GET /api/record/n` body) |
| `main.allergyModal` | `#record-modal` visible (`role=dialog`, `aria-modal`) — **blocks all input** |
| `main.editing` | `#dbl-input` present inside `#dbl-target` |
| `login` | url `/login.html` + `#user`,`#pass`,`#login` |
| `login.redirected` | url `/login.html?next=<path>` (arrived by bounce off a gated page) |
| `child` | separate target, url `/child.html`, title "gauntlet child window" |
| `away` | url `/away.html` (exit via navigate back) |

## 3. Transitions (settlement profile + wire signature)

Settlement stats overall: no-effect ≤1ms; visual ~60ms avg; network ~342ms avg, max 1528ms (drags).

| transition | act | verdict, settle | wire signature | notes |
|---|---|---|---|---|
| Load Chart (`#load-chart`) | act:2 (ev:1420-1438) | settled:network 454ms | 3 concurrent GETs: `/api/slow` (≈`slowMs`=400ms), `/api/chart/a`, `/api/chart/b`, all `task` | `#chart` → "Chart loaded (3 responses)"; `#chart-status` stays "idle" (label lies) |
| Open record n (`#record-N`) | act:4 (ev:2260-2269), act:12, act:48 (ev:7479-7490) | settled:network 60-129ms | `GET /api/record/<n> → 200` (`task`) | **interstitial arrives ~418-446ms AFTER settlement** — see §5.1 |
| Ack modal (`#modal-ack`) | act:6, act:9, act:49 | settled:visual/dom 21-228ms | none | client-side only |
| Save (`#save`) | act:14 (ev:3548-3557), act:50 (ev:7507-7518) | settled:network 34-40ms | `POST /api/save → 202 {"pending":true}` ✎write (`task`); then **outside the window**: `GET /api/save/status → 200` at ~+520ms (attribution `none`) + toast "Saved" (sentinel) | optimistic UI — §5.2 |
| Search (type in `#search`) | act:15 (ev:3564-3579) | settled:dom 632ms | one trailing `GET /api/search?q=… → 200` (`window` attribution, ~250ms debounce) | wire body `{"q","hits":[…]}` |
| Load rows (`#load-rows`) | act:16 (ev:3581-3595) | settled:network 152ms | `GET /api/rows → 200, 484.7KB` — **all 10,000 rows** | DOM renders ~23 recycled rows; extract from wire (`scripts/extract-rows.ts`) |
| Delete (`#delete`) | act:19 | settled:network 57ms | `DELETE /api/item/1 → 200` — report `env.writeFlag` fires | |
| GraphQL query / mutation | act:20 / act:21 | settled:network ~50-70ms | both `POST /api/graphql → 200`; mutation is ✎write-flagged per-request (body peek); family stays `read` | |
| Start SSE (`#start-sse`) | act:27 (ev:4996-5012) | settled:network 558ms | `GET /api/sse → 200 [streaming] text/event-stream` | 5 messages over ~2s, each captured in `sse_events` |
| Combobox (`#med`) | act:29-32 | type: settled:network 33ms; keys: settled:visual | `GET /api/meds → 200` on first keystroke | **keyboard-only**: option click → `diagnosis` (act:30); working recipe: type → `ArrowDown` → `Enter` → "Selected: …" |
| Context menu | act:33-34 | settled:visual ≤54ms | none | `rightclick #ctx-target` → `#ctx-menu[role=menu]` → click `#ctx-rename` |
| Double-click edit | act:35, 38, 39 | settled:visual/dom | none | dblclick `#dbl-target` → `#dbl-input` appears → type + Enter commits |
| Drag slider / reorder | act:36 (ev:5110-5134), act:37 | settled:network 1447-1528ms | trailing `POST /api/drag-report` ✎write (`task`); ambient heartbeat/poll inside window correctly tagged `ambient` | budget drags ≥2.5s |
| Open child (`#open-child`) | act:40 (ev:5815-5829) | new-target 37ms | — | auto-attached + instrumented; `#child-fetch` in child → `GET /api/child-ping` (act:41); detach recorded |
| Login submit | act:45 (ev:5857-5863) | settled:network 1217ms | `POST /api/login → 401` ✎write; **body unread** (friction #5) | creds unknown (ledger #5) |
| Visit `/secure.html` | act:46 | navigated | — | bounces to `/login.html?next=/secure.html` even with `requireAuth:false` |
| beforeunload → away | act:24-26 | dialog 8ms → navigated | — | `#arm-unload` then `#nav-away`: beforeunload auto-accepted (dialogs table), lands `/away.html` |
| confirm / alert | act:17 / act:18 | dialog 8-12ms | none | auto-accepted per session policy; recorded (`dialogs`) |
| No-op (`#noop`) | act:1 | no-effect ≤1ms | none | also the only button that sends **no** WS action frame |
| Re-render click / hover | act:22 / act:23 (ev:4171-4176) | settled:visual 43ms / **no-effect** | none | button re-renders (`data-gen` bumps); hover verdict `no-effect` despite gen 1877→1889 — see friction #6 |
| Canvas click (`#grid`) | act:28 | settled:dom 120ms | none | pixels-only region; only DOM delta is the header's WS echo; grid *data* is wire-available (§4) |
| Shadow button | act:51 (ev:7825-7833) | settled:dom 34ms | none | bare CSS `#shadow-btn` pierces the open shadow root |

## 4. Wire-available facts (prefer these over scraping — §2.3)

- **Records**: `GET /api/record/<n>` → `{id,name,dob,mrn,allergies[]}` (5 records seen, all with allergies).
- **Rows**: `GET /api/rows` → all 10k `{id,name,group}` (G0-G9 ×1000 each). DOM shows ~23.
- **Search**: `GET /api/search?q=` → `{q,hits[]}`. **Meds**: `GET /api/meds` → full suggestion list.
- **Chart**: `/api/chart/a`, `/api/chart/b` → `{series,points[]}`; `/api/slow` → timing echo.
- **Canvas grid**: `GET /api/grid` → `{rows,cols,cells[{r,c,label}]}` — the pixels' source of truth.
- **Save**: `POST /api/save` body echoes the form; `GET /api/save/status` carries completion.
- **App config**: `GET /ctl` (and the header renders it live) — gates every conditional branch.

## 5. Failure modes actually seen (instances of the §8 catalog)

1. **Delayed conditional interstitial** — "Allergy Review Required" (`#record-modal`, `aria-modal`)
   appears ~418-446ms *after* the record fetch settles (sentinels seq 1-5 vs request t_start; delay =
   ctl `modalDelayMs:400`). It postdates the action report; only sentinels catch it. Un-dismissed it
   bites the *next* action two ways: silent click-swallow (act:5, ev:2271-2277 — verdict OK, zero wire,
   pane unchanged) or `diagnosis:occluded` naming the overlay (act:10, ev:2321-2320). Handle as
   optional in both directions — `scripts/open-record.ts`.
2. **Optimistic UI** — screen "Saved ✓" at 34ms vs wire `202 {"pending":true}`; truth arrives ~+520ms
   via `/api/save/status` + toast. The toast outlives its 2s (`toastMs`) window only as a sentinel
   screenshot. Check the wire, not the label (`scripts/save-verified.ts`).
3. **Virtualized list** — 23 DOM rows vs 10,000 wire rows (act:16).
4. **Keyboard-only widget** — combobox ignores option clicks (act:30 diagnosis); recipe recorded verbatim (§3).
5. **Native dialogs** — confirm/alert/beforeunload auto-accepted and recorded (acts 17,18,25); none blocked the session.
6. **Re-render races** — `#rerender` swaps nodes per interaction (`data-gen`); id-based re-resolution
   held (act:22 clean); hover-triggered churn produced the act:23 verdict anomaly (friction #6).
7. **Perpetual spinner** (§s-4) — animates forever; never held settlement (visual quiescence uses ignore-masks).
8. **Auth bounce** — gated page silently redirects to `login.html?next=…` (act:46): the "every later
   action is a login-page no-op" trap if a session expires mid-run.

## 6. Selector strategy (and why)

**Primary: bare CSS ids.** Every control has a stable, semantic id; ids survive re-renders (act:22)
and pierce the open shadow root (act:51). **Fallback: `role=`+name** (Playwright syntax) — accessible
names exist on buttons/comboboxes/menus; the daemon's own generated selectors are role-based.
**Frames**: `{frame:"xframe.html"}` (URL substring) for the cross-origin island; input is dispatched
via the root with translated coordinates. **Canvas**: no DOM — coordinates from `GET /api/grid`
geometry + screenshot diffs. Avoid text selectors for row-list content (10k near-identical rows,
virtualized).

## 7. Standing channels (complete inventory)

| channel | mechanics | cadence | carries | store |
|---|---|---|---|---|
| `ws://localhost:4820/ws` | WebSocket, opened on page load | `hello`(+full ctl state) on open; **out** `action` frame per button click (except `#noop`); **in** `echo` per action; `push` every ~7s (`wsPushMs`); `notify` on §23 ws-push | click telemetry, config, pushed notifications | `websockets`, `ws_frames` (+FTS). **Caveat: invisible until a reload if opened pre-attach** (friction #2) |
| `GET /api/notify-sse` | EventSource, standing from load | reconnects per page load | §23 sse-push notifications | flagged `streaming`; messages in `sse_events` |
| `GET /api/notify-poll` | long-poll, ~25s hold (`notifyPollHoldMs`), reissues | classified ambient `periodic` (cv 0.14, n=27) | §23 poll-push notifications ride the held response (`{"n":3,"via":"poll",…}` observed) | `requests` bodies; held request shows `status NULL` while pending |
| `GET /api/poll` | long-poll ~3s (`pollHoldMs`) | ambient (cv 0, n=218) | `{"n":null}` filler | `requests` |
| `GET /api/heartbeat` | timer | 5000ms exactly (cv 0, n=129) | keepalive | `requests` |
| `GET /api/sse` | on-demand SSE (act:27) | 5 events / ~2s, then done | demo stream | `sse_events` |

None of these ever held settlement open (ambient classifier evidence in `families.evidence`).

## 8. Auth / session behavior

Login form (`#user`,`#pass`,`#login`) posts `/api/login` (401 on guessed creds, act:45; body uncaptured).
`/secure.html` redirects to `/login.html?next=/secure.html` (act:46) — despite ctl `requireAuth:false`,
so that flag likely gates APIs, not pages (ledger #5). Idle timeout exists but is off (`timeoutMs:0`,
§s-12 "idle timer: off"); the session-expiry branch is unobserved (ledger #6). No keepalive beyond the
ambient channels above.
