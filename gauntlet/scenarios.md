# Gauntlet scenarios

The gauntlet is milestone 0 of disco (BRIEF.md §3, REVIEW.md §C): a deliberately
hostile, fully deterministic single-page app + Bun server that a browser-
instrumentation daemon is tested against. Every behavior below exists to make one
claim in GUIDANCE.md testable; each section names the claim it exercises (`G§`).

Ugly is fine. Determinism and the exact DOM contracts (ids, visible text) are
mandatory: automated tests target them verbatim.

## Running

```
bun run gauntlet/server.ts [--port N] [--verbose]     # default port 4800; 0 = pick free
bun test test/gauntlet/gauntlet-server.test.ts        # server-level contract tests
```

Programmatic: `startGauntlet({port?, verbose?})` → `{port, xPort, origin, xOrigin, ctl, stop}`.
Two `Bun.serve` instances: the **main origin** (`http://localhost:<port>`) and a
**cross-origin** server (`http://localhost:<xPort>`, `port+1` when fixed, otherwise
another free port) that serves only `/xframe.html` and `POST /api/xframe-submit`.

The client (`app/main.ts` + modules) is bundled in memory at startup with
`Bun.build({target:"browser"})` and served from `/app.js`. Every response carries
`Cache-Control: no-store`. Nothing uses `Math.random`; all ids and counters are
monotonic; every latency is an explicit knob.

## Control plane

| Route | Effect |
|---|---|
| `GET /ctl` | current state as JSON (knobs below plus `xOrigin`) |
| `POST /ctl` (JSON partial) | merge (unknown keys / wrong types ignored), respond with full state, **broadcast `{type:"ctl", state}` on every open WebSocket** so live pages apply it without reload |
| `POST /ctl/reset` | back to defaults (also broadcast) |
| `GET /origins` | `{origin, xOrigin}` |

State and defaults. **All ambient traffic is OFF by default** so timing tests are deterministic.

| key | default | side | meaning |
|---|---|---|---|
| `slowMs` | 400 | client | latency the page asks for in `GET /api/slow?ms=` (Load Chart) |
| `renderDelayMs` | 0 | client | Load Chart: gap between the last response landing and the chart rendering (see 27) |
| `modal` | false | client | show the Allergy Review dialog after a record renders |
| `modalDelayMs` | 0 | client | delay from record render to dialog append |
| `toastMs` | 2000 | client | toast lifetime |
| `saveFails` | false | server | `/api/save/status` answers `500 {ok:false}` |
| `ambient` | false | both | client: heartbeat interval + long-poll loop; server: periodic WS push |
| `heartbeatMs` | 5000 | client | heartbeat interval |
| `pollHoldMs` | 3000 | server | how long `/api/poll` is held (read at request time) |
| `wsPushMs` | 7000 | server | period of spontaneous WS pushes while `ambient` |
| `timeoutMs` | 0 | client | idle time before the session-timeout dialog; 0 = off |
| `rerenderOnHover` | true | client | replace `#rerender` synchronously on mousemove/mouseover |
| `requireAuth` | false | server | `/` 302s to `/login.html?next=/` without the cookie |
| `notifyPollHoldMs` | 25000 | server | how long `/api/notify-poll` is held awaiting a `push` trigger |
| `notify` | `false` | Client-side gate for the #23 long-poll loop (SSE + WS stand regardless). Off by default so the reissuing poll cannot perturb settlement timing; enable live via `POST /ctl {notify:true}`. |
| `wsPush` | — | trigger | write-only: `true` pushes one `{type:"push"}` frame immediately; never persisted and does not emit a `ctl` frame |
| `push` | — | trigger | write-only: `"ws"`/`"sse"`/`"poll"` delivers one notification over exactly that channel (see 23); never persisted, no `ctl` frame |

Effective page state = `GET /ctl` on load → URL query overrides → live `ctl` frames
(last write wins; a later `ctl` frame replaces query overrides). Query overrides are
**client-local** and never written back to the server:

| query | knob | notes |
|---|---|---|
| `?modal=1` | `modal` | `1`/`true` = on |
| `?modalDelay=N` | `modalDelayMs` | |
| `?slow=N` | `slowMs` | |
| `?renderDelay=N` | `renderDelayMs` | |
| `?toast=N` | `toastMs` | |
| `?ambient=1` | `ambient` | client half only (heartbeat + poll). Periodic WS pushes need `/ctl` |
| `?heartbeat=N` | `heartbeatMs` | |
| `?timeout=N` | `timeoutMs` | |
| `?rerender=0` | `rerenderOnHover` | |

Server-side knobs (`saveFails`, `pollHoldMs`, `wsPushMs`, `requireAuth`,
`notifyPollHoldMs`) have no query form — use `/ctl`.

The header of the page shows `#ws-status`, `#ws-count`, `#ambient-status`,
`#heartbeat-count`, `#poll-count`, `#x-origin`, `#ws-last` (last WS frame JSON)
and `#ctl-state` (effective state JSON).

## Behaviors (main page `/`)

Each lives in `<section id="s-<n>">` with an `<h2>`. Every button is a real
`<button>` with the visible text quoted below.

### 1. Load Chart — concurrent fetches, one slow (`#s-1`)
`button#load-chart` "Load Chart" fires three fetches concurrently:
`GET /api/slow?ms=<slowMs>`, `GET /api/chart/a`, `GET /api/chart/b`.
`#chart-status` = "loading…" until all three resolve, then `#chart` =
"Chart loaded (3 responses)" and `#chart-status` = "idle". `/api/slow` returns
`{ms, at}` after exactly `ms` ms. Knobs: `slowMs` / `?slow=`.
**G§4.2** — settlement stays open while attributed requests fly; closes ~Q after the last.

### 2. Records + conditional modal (`#s-2`)
Five `button.record[data-id="N"]` (also `id="record-N"`) "Open Record N", N=1..5.
Click → `GET /api/record/N` → `section#record` gets `<h3>Record N</h3>` and
`<ul id="record-fields">` (one `<li>key: value</li>` per JSON field).
If `modal` is true, `modalDelayMs` after render, `div#record-modal[role="dialog"][aria-modal="true"]`
(fixed full-viewport overlay) is appended with `<h3>Allergy Review Required</h3>`,
a sentence, and `button#modal-ack` "Acknowledge" (removes the dialog).
Knobs: `modal`, `modalDelayMs` / `?modal=1&modalDelay=`.
**G§5.3, §7.5, §2.4** — dialog sentinel, variability ledger, optional interstitials.

### 3. Save — optimistic UI, async failure toast (`#s-3`)
`button#save` "Save" → IMMEDIATELY sets `#save-state` = "Saved ✓" (never reverted),
then `POST /api/save` body `{form:{name:"x"}}` → `202 {id, pending:true}`,
then 500 ms later `GET /api/save/status?id=` → `200 {ok:true}` or, when `saveFails`,
`500 {ok:false, error:"write failed"}`. Then a toast `div#toast.toast[role="status"]`
(fixed bottom-right, `data-kind="ok"|"fail"`) with text "Saved" or
"Save failed (async)", removed after `toastMs`. The UI lies; the wire is the truth.
Knobs: `saveFails` (server), `toastMs` / `?toast=`.
**G§8** (toasts, optimistic UI), **G§2.6** (write flag), **G§5.3** (toast sentinel).

### 4. Perpetual spinner (`#s-4`)
`div#spinner` — CSS keyframe animation, always visible, never stops.
**G§4.2** — visual-quiescence ignore-region fingerprinting; **G§8** "spinners that lie".

### 5 / 22. Ambient traffic — heartbeat + reissuing long-poll (`#s-5`)
Only while `ambient` is true (started/stopped live on ctl change):
`setInterval(heartbeatMs)` → `GET /api/heartbeat` (`{ok, n}`), and a long-poll loop:
`GET /api/poll` is held by the server for `pollHoldMs` (read at request time) then
returns `{n, heldMs}`; the client reissues **immediately** on return, so a poll can
begin inside an action's causality window. The server also pushes a WS frame every
`wsPushMs`. `#ambient-status` = "on"/"off"; `#heartbeat-count`, `#poll-count` are
integers. Knobs: `ambient`, `heartbeatMs`, `pollHoldMs`, `wsPushMs` / `?ambient=1&heartbeat=`.
**G§4.4** — ambient classification; these must never hold settlement open. **REVIEW A3**.

### 6. WebSocket (`#s-6`, header)
`/ws` opened on load. `#ws-status` = "open"/"closed"; `#ws-count` = frames received;
`#ws-last` = last frame JSON. Frames from the server:
`{type:"hello", id, state}` on open (counted, not applied as ctl),
`{type:"echo", ...clientFields, seq}` for every client frame,
`{type:"push", n, at}` on `wsPush` trigger and every `wsPushMs` while `ambient`,
`{type:"notify", n, via:"ws", text}` on a `push:"ws"` trigger (see 23),
`{type:"ctl", state}` on every knob change. Every button click on the page (including
dynamically created `#modal-ack`, `#stay`, `#rerender`, `#shadow-btn`) sends
`{type:"action", id:<button id>, t}` — wiring is per-button and **skips `#noop`**
(scenario 13) so the no-op stays a true no-op. The one exception is `#rerender`, whose
action is sent by the host's delegated listener (see 9). Iframe buttons have no WS.
**G§3.4** — WS capture both directions; between-action observation.

### 7. Debounced search (`#s-7`)
`input#search` (placeholder "Search…") → 250 ms trailing debounce → one
`XMLHttpRequest` `GET /api/search?q=` per settled keystroke → `ul#search-results`
with an `<li>` per hit (fixed list of 50 names, case-insensitive substring).
Empty q: no request, list cleared, pending debounce cancelled. Stale responses dropped.
**G§8** — debounced inputs; typing settlement must wait for the trailing request.

### 8. Virtualized rows (`#s-8`)
`button#load-rows` "Load Rows" → `GET /api/rows` → 10,000 rows `[{id, name, group}]`,
`name = ANIMALS[i % 7] + "-Row-" + i`, `ANIMALS = [Aardvark, Bison, Cheetah, Dingo, Zebra, Ferret, Gecko]`
(so row 9741 is exactly `Zebra-Row-9741`). `div#rows` (height 400 px, row height 24 px)
contains `div#rows-inner` (240,000 px tall) with absolutely positioned
`div.row[data-id][data-group]` for only the visible ~17 rows + 5 overscan each side;
the window is rebuilt on every scroll (node identity is not stable). `#rows-count` = "10000 rows".
**G§2.3, §8** — "the wire had it all along" extraction.

### 9. Re-render race (`#s-9`)
`div#rerender-host` (inline-block, hugging its button) contains `button#rerender`
"Re-render me" (`data-gen` = replacement generation). While `rerenderOnHover`, a
`mousemove` over the button synchronously replaces the node with a fresh identical one,
so resolve-then-dispatch finds it detached (any real pointer path moves the mouse first).
Independently the node is replaced every 100 ms. A delegated click listener on the host
increments `#rerender-count` (integer text) and sends the WS `action` frame
(`id:"rerender"`). Knob: `rerenderOnHover` / `?rerender=0`.

Two deliberate limits, both forced by Chromium's input pipeline (measured, not guessed):
- **No `mouseover` trigger.** Chromium fires boundary events (`mouseover`) on every
  hit-test change *before* dispatching `mousedown`/`mouseup`. A mouseover-driven swap
  therefore sends `mousedown` to a just-detached node, and while the pointer rests on the
  button the node churns at frame rate (~70 gen/s observed). Two detached targets have no
  common ancestor, so **no `click` event is ever generated** and Playwright-style
  actionability checks livelock. The spec's "count increments on click" would be
  unsatisfiable.
- **The 100 ms churn pauses while a mouse button is held** (host `mousedown` →
  document `mouseup`), so a press/release pair can never straddle a tick. Otherwise the
  count would be ~2% flaky; the hostility belongs to resolve→dispatch, not press→release.

**G§8** — resolve-late, dispatch-immediately, re-resolve once on `node detached`.

### 10. Iframes (`#s-10`)
`iframe#same-origin` (src `/iframe.html`): `input#if-name`, `button#if-submit` "Submit"
→ `POST /api/iframe-submit` `{name}` → `#if-result` = "Submitted: <name>".
`iframe#cross-origin`: src is injected at runtime as `<xOrigin>/xframe.html` from the
`xOrigin` field of `/ctl` (also `GET /origins`). Same shape with `#xf-name`, `#xf-submit`,
`#xf-result`, posting to the **cross** origin's `/api/xframe-submit`.
**G§3.2** — multi-target/frame instrumentation, frame-scoped selectors. **REVIEW A5**.

### 11. beforeunload / confirm / alert (`#s-11`)
`button#arm-unload` "Arm beforeunload" registers a `beforeunload` handler that sets
`returnValue` (`#unload-armed` = "armed"). `a#nav-away` "Navigate away" → `/away.html`
(`<h1>You navigated away</h1>`). `button#confirm` "Confirm me" → `confirm("Proceed?")`
→ `#confirm-result` = "confirmed"/"cancelled". `button#alert` "Alert me" →
`alert("Hello from gauntlet")` → `#alert-result` = "alerted".
**G§3.4, §8** — dialogs auto-handled per session policy, always recorded.

### 12. Session timeout (`#s-12`)
When `timeoutMs` > 0 (applied live), after `timeoutMs` with no user input
(`click`/`keydown`/`mousemove` reset the timer), `div#session-timeout[role="dialog"]`
(overlay) appears with `<h3>Session expiring</h3>`, "Your session will expire due to
inactivity", and `button#stay` "Stay signed in" (removes it, resets the timer).
`#timeout-state` = "off" / "armed (N ms)" / "expired". Knob: `timeoutMs` / `?timeout=`.
**G§5.3, §8** — session-expiry sentinel.

### 13. No-op (`#s-13`)
`button#noop` "Do nothing" — no handler, no visual change, and deliberately excluded from
the WS action wiring (see 6). `button#noop-disabled` "Disabled" is `disabled` and, via the
stylesheet's `button:disabled { pointer-events: none }`, hit-tests to its parent — the disabled-control
trap: `elementFromPoint` returns an ancestor, not the button.
**G§4.2, §2.1, §8** — fast `no-effect` verdict; the disabled control is a `not-interactable` diagnosis, not `occluded`.

### 14. Delete — write endpoint (`#s-14`)
`button#delete` "Delete item" → `DELETE /api/item/1` → `{deleted:1}` → `#delete-result`
= "deleted 1". Together with 3's `POST /api/save` these are the write endpoints.
**G§2.6** — write-flag surfacing.

### 15. Child window (`#s-15`)
`button#open-child` "Open child window" → `window.open("/child.html", "_blank")`.
`/child.html`: `<h1>Child window</h1>`, `button#child-fetch` "Fetch in child" →
`GET /api/child-ping` → `#child-result` = "pong".
**G§3.2** — target auto-attach.

### 16. Canvas grid — pixels only (`#s-16`)
`canvas#grid` 400×200 draws an 8×4 grid from `GET /api/grid` (`{rows, cols, cells:[{r,c,label}]}`,
fetched on load; cells 50×50 px). Clicking a cell redraws with it highlighted (yellow) and
paints "selected r,c" inside that cell. No DOM mutation and no network on click.
`window.__gridSelected` (`{r,c}` or null) exists only for tests.
**G§7.2, §8** — canvas regions; **REVIEW A2 / C16** — coordinate clicks, pixel-only settlement.

### 17. Keyboard-only combobox (`#s-17`)
`input#med[role="combobox"][aria-autocomplete="list"][aria-expanded]` placeholder
"Medication…". Each `input` event → `GET /api/meds?q=` (30 drug names, substring filter)
→ `ul#med-list[role="listbox"]` of `li[role="option"][aria-selected]` (`id="med-opt-<i>"`).
Options ignore the mouse: `pointer-events:none` on the list plus `mousedown`/`click`
`preventDefault()`. ArrowDown/ArrowUp move `aria-selected` (and `aria-activedescendant`),
Enter → `#med-selected` = "Selected: <name>" and the input value is set (no re-fetch),
Escape closes the list. Empty input closes it.
**G§8** — focus traps / keyboard-only widgets: find and record the working input recipe.

### 18. Shadow DOM (`#s-18`)
`div#shadow-host` with an OPEN shadow root containing
`<button id="shadow-btn">Shadow button</button>` and `<span id="shadow-count">0</span>`;
clicking increments the count inside the shadow root.
**G§8, §7.2** — shadow DOM selection technique.

### 19. Server-sent events (`#s-19`)
`button#start-sse` "Start SSE" → `new EventSource("/api/sse")`; the server sends 5 `data:`
events (`{stream, i, msg}`) at 500 ms intervals then closes. Each is appended to `ul#sse-log`
as `<li>`; `#sse-status` = "connecting" → "open" → "done" (client closes after the 5th
event so EventSource does not auto-reconnect).
**G§3.4** — streaming response bodies; **REVIEW A4 / C19**.

### 20. GraphQL over POST (`#s-20`)
`button#gql-query` "GraphQL query" → `POST /api/graphql` `{query:"query { patient { name } }"}`;
`button#gql-mutate` "GraphQL mutation" → `{query:"mutation { rename(name: \"Renamed\") { name } }"}`.
Server answers `{data, sawMutation, operation}` (fake data either way; `sawMutation` is
whether the query text starts with `mutation`). `#gql-result` shows the JSON text.
**G§2.6, §7.2** — write-flag false-positive rate for RPC-over-POST reads; **REVIEW C20 / D2**.

### 21. Auth (`#s-21`)
`POST /api/login` JSON `{user, pass}` (any non-empty pair) → 200 and cookie
`gauntlet_auth=<user>; Path=/; HttpOnly` (else 401). `/login.html`: `input#user`,
`input#pass`, `button#login` "Log in" → on success navigates to the `next` query param
(must start with `/`) or `/secure.html`. `/secure.html` requires the cookie, else
`302 /login.html?next=/secure.html`; with it renders `<h1>Secure area</h1><p id="who">Welcome, <user></p>`.
When `requireAuth` is true, `/` also 302s to `/login.html?next=/` without the cookie.
Knob: `requireAuth` (server).
**G§3.2, §8** — launch-mode auth flows, silent auth redirects; **REVIEW C21**.

### 22. Long-poll reissue mid-action
Part of 5: `/api/poll` holds for `pollHoldMs` (server reads ctl at request time) and the
client reissues immediately on return, so with `ambient` on a poll will begin inside the
causality window of any action longer than a few ms. **G§4.4**; **REVIEW A3 / C22**.

### 23. Push-channel content delivery (`#s-23`)
Backend→frontend delivery of a content object over each standing channel, so the daemon can
prove it observes *content* arriving between actions on every channel type. Trigger:
`POST /ctl {"push":"ws"|"sse"|"poll"}` — write-only like `wsPush` (never persisted, no `ctl`
frame). The server builds `{n, via, text:"Result <n> via <via>"}` with one monotonic `n`
shared across all three channels and delivers it over **exactly** the chosen channel:
- `"ws"` → frame `{type:"notify", n, via:"ws", text}` on every open `/ws` socket;
- `"sse"` → one event on `/api/notify-sse`, a **persistent** EventSource the page opens at
  load (server holds it open indefinitely, sending `: connected` first; separate from 19's
  on-demand `/api/sse`);
- `"poll"` → resolves every pending `GET /api/notify-poll`; the page runs a dedicated
  long-poll loop from load — the server holds the request until a trigger or
  `notifyPollHoldMs` (default 25000, read at request time; timeout answers `{n:null}`), and
  the client reissues immediately either way.
The client renders each notification as an `<li>` in `ul#notif-list` with the text exactly as
delivered and sets `#notif-count` to the count received. Knob: `notifyPollHoldMs` (server).
**G§3.4, G§10** — results delivered over the standing channel; between-action observation.

### 24. Context menu (`#s-24`)
`div#ctx-target` "Right-click me". `contextmenu` → `preventDefault()` → `ul#ctx-menu[role="menu"]`
appears `position:fixed` at the pointer with `li[role="menuitem"]` items `#ctx-open` "Open",
`#ctx-rename` "Rename", `#ctx-delete` "Delete". Left-clicking an item → `#ctx-result` =
"ctx: <item text>" and the menu hides. A `mousedown` anywhere outside the open menu hides it
(a fresh right-click on the target therefore hides-then-reopens). A plain left click on the
target must NOT open the menu; it sets `#ctx-result` = "ctx: leftclick".
**B§1.9, G§2.1** — right-button sequence (move → down(right) → up → `contextmenu`) through the
action choke point; menu-like UI reachable only via a non-left click.

### 25. Double-click to edit (`#s-25`)
`div#dbl-target` shows "Editable value"; `#dbl-state` starts "idle". A single click arms a
**250 ms confirmation timer** before setting "selected" — deliberately, because a dblclick
necessarily emits `click, click, dblclick`, so an undelayed handler would flash "selected"
on the way to editing; the timer is how real apps disambiguate, and settlement must ride
through it. `dblclick` cancels the pending timer, sets `#dbl-state` = "editing" and swaps in
`input#dbl-input` holding the current value; Enter commits → `#dbl-state` =
"committed: <value>", the input is removed and the div shows the value. Clicks while editing
are ignored.
**B§1.9, G§8** — two full press/release pairs with correct `clickCount`; meaning depends on
click-count sequencing.

### 26. Mouse drag (`#s-26`)
Plain mouse events (mousedown → document mousemove → mouseup), NOT HTML5 draggable.
- **Slider:** `div#slider-track` (300×20) contains `div#slider-thumb` (20×20, starts at 0 —
  no randomness). Drag the thumb: value = pointer X projected onto the track (thumb center
  follows the pointer), clamped and rounded to 0–100; `#slider-value` updates live during
  the drag.
- **Reorder list:** `ul#sort-list` with `li#sort-a` "Item A", `li#sort-b` "Item B",
  `li#sort-c` "Item C". mousedown on an item arms the drag (`.dragging` class while held);
  the dragged item is re-inserted when the **pointer's Y crosses a sibling's midpoint**
  (deviation from "dragged item's center": the item is reordered in place rather than freely
  positioned, so its own center is quantized to slots — pointer Y is the deterministic
  proxy). `#sort-order` shows the ids joined as e.g. "a,b,c" after every change.

On drag END (mouseup) each widget sends exactly one `POST /api/drag-report` —
`{widget:"slider", value}` or `{widget:"sort", order:"b,a,c"}` — so the wire carries the
drag's result. A mousedown with no movement still reports on release (deterministic).
**B§1.9, G§2.1** — held-button move sequences that `Input.dispatchMouseEvent` must express;
drag outcome visible on screen and wire.

### 27. Delayed render — a >Q gap between wire and screen (`#s-1` knob)
With `renderDelayMs` > 0, Load Chart (1) waits that long **after all three responses have landed**
before writing `#chart` / `#chart-status` = "idle" — a plain timer: no request, no DOM mutation, no
paint during the gap. Attributed-network, DOM and pixel channels are therefore all quiet for longer
than Q, so settlement closes with `settled:network` while the screen still says "loading…"; the
expected state appears only afterwards. This is the deterministic form of the "settled ≠ ready"
trap (debounces, `requestIdleCallback`, second-hop fetches that aren't attributed).
Knob: `renderDelayMs` / `?renderDelay=`.
**G§4.2, §9** — the postcondition (`until`) is the readiness contract; the verdict is the evidence.

### 28. Fake stream — ordinary data mislabeled as an event-stream (`#s-28`)
`button#load-fake-stream` "Load fake stream" → `fetch GET /api/fake-stream`, which answers **one complete
payload** with `Content-Type: text/event-stream` and closes; the page `await res.text()`s it whole and sets
`#fake-stream-out` = "got N chars". No `EventSource` is involved, so `sse_events` stays empty — a
mime-type-only "stream" hiding ordinary data. The capture layer must store the body when the response
FINISHES (a true stream never does).
**G§3.4, §8** — streaming capture limits; DECISIONS #51.

## Server API summary

| Method | Path | Response |
|---|---|---|
| GET | `/api/slow?ms=N` | `{ms, at}` after N ms (default `slowMs`) |
| GET | `/api/chart/a`, `/api/chart/b` | `{series, points}` |
| GET | `/api/record/:n` | record JSON (1..5) or 404 |
| POST | `/api/save` | `202 {id, pending:true, received}` |
| GET | `/api/save/status?id=` | `200 {id, ok:true}` or `500 {id, ok:false, error}` when `saveFails` |
| GET | `/api/heartbeat` | `{ok:true, n}` |
| GET | `/api/poll` | `{n, heldMs}` after `pollHoldMs` |
| GET | `/api/search?q=` | `{q, hits:[name]}` (empty q → no hits) |
| GET | `/api/rows` | 10,000 `{id, name, group}` |
| POST | `/api/iframe-submit` | `{ok:true, name}` |
| POST | `/api/xframe-submit` | `{ok:true, name, origin:"x"}` — **cross-origin server only** |
| DELETE | `/api/item/:id` | `{deleted:id}` |
| GET | `/api/child-ping` | `{pong:true}` |
| GET | `/api/grid` | `{rows:4, cols:8, cells:[{r,c,label}]}` |
| GET | `/api/meds?q=` | `{q, hits}` (no q → all 30) |
| GET | `/api/sse` | `text/event-stream`, 5 events at 500 ms, then close |
| GET | `/api/notify-sse` | persistent `text/event-stream`; `: connected`, then one event per `push:"sse"` trigger |
| GET | `/api/notify-poll` | held until `push:"poll"` (→ notification) or `notifyPollHoldMs` (→ `{n:null}`) |
| POST | `/api/drag-report` | echoes body + `ok:true` |
| POST | `/api/graphql` | `{data, sawMutation, operation}` |
| POST | `/api/login` | `{ok:true, user}` + `Set-Cookie`, or 401 |
| WS | `/ws` | hello / echo / push / ctl frames |
| GET/POST | `/ctl`, POST `/ctl/reset`, GET `/origins` | control plane |

Pages: `/` (`index.html`), `/app.js`, `/style.css`, `/iframe.html`, `/child.html`,
`/away.html`, `/login.html`, `/secure.html` (cookie-gated), and `<xOrigin>/xframe.html`.
Anything else: 404. `--verbose` logs one line per request (`METHOD path -> status ms`)
plus WS open/close.

### 29. Skeleton table (`#s-29`)

`#load-people` immediately paints a **complete-looking** table: `#people` with 4 headers and 6 rows × 4 empty
`td.skel` cells, and `h3#people-title` showing `--`. `GET /api/people?hold=800` answers 800 ms later; then the
cells fill (names, roles…) and the title becomes `People (6)`. Structural predicates (`table`, `tr`, `td`) are
satisfied by the skeleton; a real value (`#people-title:has-text("People (")`, a cell text) is the only honest
anchor. Fields: `{people:[{name,role,dept,since}]}`.

### 30. Cached revisit (`#s-30`)

`button[role=tab]#tab-a` / `#tab-b` flip `aria-selected` synchronously. The **first** visit to a tab fetches
`GET /api/tab/a` (or `/b`) → `{tab, items[3]}` and renders `#tab-panel` (`h3` "Tab A", `ul#tab-items`). Every
later visit renders from an in-memory cache with **no request**: a wait on the request expires. The tab's
own `aria-selected="true"` and the panel heading are the postconditions that hold both ways.

### 31. Stacked panels (`#s-31`)

`#open-panel` mounts `div#panel-1.panel` (fixed, right) with `#panel-next` and `#panel-close`. `#panel-next`
mounts `div#panel-2.panel` **on top**; panel 1 stays in the DOM (visible, partly covered). `#panel-back`
removes panel 2 only. After Back, a wait on `#panel-next` is already true — it never left; the element to
wait for is panel 2 being gone.

### 32. Styled radios (`#s-32`)

Three `label.styled` each wrap an `input[type=radio][name=sev]` (`#sev-mild` / `#sev-moderate` / `#sev-severe`,
`opacity:0`, 16×16, absolutely positioned) under a `span.fake-radio`. The pointer at the input's centre hits the
span, so a real click on the input is intercepted; clicking the **label** (or `check({ force: true })`)
works. `change` sets `#sev-value` to the value. No wire.

### 33. Blocking submit (`#s-33`)

`#slow-submit`'s click handler busy-waits **3.5 s on the main thread**, then sets `#slow-result` to
`Submitted` and `POST /api/slow-submit` (200 `{ok, at}`). A click with a 3 s budget times out **after the
click landed**; the result still arrives.

### /big.html

A separate document with 10,000 real `<tr>` rows (not virtualised), `#big-btn` and `#big-out`. Exists for the
report-overhead ceiling: the aria snapshot and diff must stay bounded on a large DOM.

### WebSocket keepalive

A bare `ping` text frame on `/ws` is answered with a bare `pong`, with no counter — the shape of a real keepalive. Every
other message is echoed back with a rising `seq`. For disco: a frame identical to the previous one in its direction on
its socket is a heartbeat and must not keep an act from going quiet; an echo with a new `seq` is activity and must.

### 34. Other wire formats (`#s-34`)

`#load-xml` fetches `GET /api/patient.xml` (`application/fhir+xml`: a Patient with id, identifier `MRN-0042`, name text
"Ada Lovelace", birthDate, address) and writes `Ada Lovelace (MRN-0042)` into `#xml-out`. `form#form-demo` posts
`application/x-www-form-urlencoded` (`fullName`, `consent=yes`) to `POST /api/form` → `{ok, received, consent}`, shown in
`#form-out`. `#load-fragment` fetches `GET /api/fragment` (`text/html`: a `<table id="fragment-people">` of the six people
with `/people/<n>` links) and swaps it into `#fragment-out`. For disco: bodies in three non-JSON formats, and names that reach
the screen only through them.
