# gauntlet — how it works and how to drive it

`bun gauntlet/server.ts --port 4800` (a second origin, **:4801**, comes up with it and serves only the
cross-origin iframe). Then `./disco open gauntlet http://localhost:4800`.

## 1. What it is

One **static HTML page** at `/` — no router, no framework, no SPA shell — with 27 numbered
`<section>`s, each demonstrating one loading/interaction pattern, plus a 20.5 KB ES module `/app.js`
that wires them up. Every id is literal and stable (`#load-chart`, `#record-3`, `#med-list`), so
selectors never need `nth`. Facts live in three places: **the wire** (a small JSON API under `/api/`,
plus GraphQL over `POST /api/graphql`), **the DOM**, and — for the canvas — **pixels only**. Three push
channels (WebSocket, SSE, long-poll) run alongside the request/response API.

The important structural fact: **every "sometimes" behaviour is a knob, not randomness.**
`GET /ctl` returns the effective configuration, `POST /ctl` patches it, `POST /ctl/reset` restores
defaults. Modal or no modal, save succeeds or fails, background traffic on or off, auth required or
not, how slow "slow" is — all of it is `ctl`. Drive the app deterministically by setting the knob you
want before the step that depends on it (`lib.ts:ctl()` does this from inside the page, so the POST
lands in the log with the page's cookies).

Auth is a single `HttpOnly` cookie, `gauntlet_auth`. When `ctl.requireAuth` is on it guards the shell
too, not just `/secure.html`.

## 2. Glossary

| The app's word | On screen | On the wire |
|---|---|---|
| **ctl** | `effective ctl:` in the header, `#ctl-state` | `GET/POST /ctl`, and the WS `hello` frame's `state` |
| **record** | §2, `#record` — an `<h3>Record N</h3>` and one `<li>` per field | `GET /api/record/:id` → `{id,name,dob,mrn,allergies[]}` |
| **allergy review** | the "Allergy Review Required" dialog `div#record-modal.overlay` | nothing — it is client-side, gated by `ctl.modal` |
| **chart** | §1, `#chart` = "Chart loaded (N responses)" | `/api/slow?ms=` + `/api/chart/a` + `/api/chart/b` (3 concurrent) |
| **save** | §3, `#save-state` = `unsaved` → `Saved ✓`; a toast in `[role=status]` | `POST /api/save` (202) then `GET /api/save/status?id=` (**200 or 500**) |
| **row** | §8, `#rows .row[data-id]` — only ~24 exist | `GET /api/rows` — all 10 000 |
| **notification** | §23, `#notif-list li` = "Result N via ws\|sse\|poll" | a WS `notify` frame, an SSE message, or a `/api/notify-poll` response |
| **ambient** | header "ambient: on (heartbeats N / polls N)" | `GET /api/heartbeat` + reissuing `GET /api/poll` |

## 3. Anchors

| Screen | URL | Element |
|---|---|---|
| shell | `/` | `#load-chart` |
| login | `/login.html` (`?next=…`) | `#login` (the button) |
| secure area | `/secure.html` | `#who` ("Welcome, `<user>`") |
| "navigated away" | `/away.html` | `a#back` |
| child window (popup) | `/child.html` | `#child-fetch` |
| allergy modal (interstitial) | — | `#record-modal` |
| session-expiry dialog (interstitial) | — | `[role=dialog]` with text "Session expiring" |

`lib.ts` exports these as `anchors`. **Always give the shell anchor a `#login` arm** — see §5.

## 4. Workflows

Every one of these is a function in `lib.ts`, and `check.ts` runs all of them
(`node scripts/run-check.ts gauntlet` → 33/33, ~26 s, cold or warm).

### 4.1 Load the chart — three concurrent fetches, one slow (`loadChart`, act:2, act:86)

```ts
s.click("#load-chart", { until: { selector: "#chart:has-text('Chart loaded')" }, timeout: 4000 })
```

Fans out `GET /api/slow?ms=<ctl.slowMs>`, `/api/chart/a`, `/api/chart/b` at once and renders when the
last one lands. **Postcondition: `#chart`, never `#chart-status`** — the status span says `idle` before,
during and after; it is a spinner that lies (act:86 with `ctl.slowMs=1200`: 1787 ms, still "idle").
*Varies:* `ctl.slowMs` is the whole latency. The aria diff glues both spans into one line
(`text: "status: idle Chart loaded (3 responses)"`) — anchor on the element, not the line.

### 4.2 Open a record, with an optional and possibly delayed modal (`openRecord`, act:7, act:8, act:93)

```ts
s.click(`#record-${id}`, { until: { any: [
  { selector: "#record-modal", label: "modal" },
  { selector: `#record h3:text-is("Record ${id}")`, label: "record" } ] } })
// if which === "record", look once more for #record-modal (grace window), then:
s.click("#record-modal button", { until: { gone: "#record-modal" } })
```

Fields come from `GET /api/record/:id` — read them from the log, not the `<li>`s.
*Varies:* `ctl.modal` decides whether the dialog appears at all; `ctl.modalDelayMs` pushes it **after**
the record renders, so the `any` resolves on `record` and the dialog arrives later and occludes the
whole page. There is no signal for "no dialog is coming", so a delayed interstitial costs a grace
window once — `openRecord(s, id, { modalGraceMs: 1200 })`. Getting this wrong is what turned one
failing step into 12 in my first `run-check`.

### 4.3 Save — optimistic UI whose failure lives only on the wire (`save`, act:3, act:49)

```ts
const r = s.click("#save", { until: { request: "/api/save/status" }, timeout: 6000 });
const status = s.store.requests({ url: "/api/save/status", action: r.action }).at(-1).status; // 200 | 500
```

`POST /api/save` → **202**, and the UI flips to `Saved ✓` immediately and **never flips back**. The
outcome arrives on `GET /api/save/status?id=N`: **200 = saved, 500 = failed**. The page never reads
that body (`body_state: pending → missing`), so **the status code is the only fact**. The sole UI
signal of failure is a `[role=status]` toast "Save failed (async)" that vanishes after `ctl.toastMs`
(2000 ms) — do not build on it. *Varies:* `ctl.saveFails`.

### 4.4 The spinner that never resolves (`spinnerStillSpinning`, act:51)

`#spinner` is perpetual. `until: { gone: "#spinner" }` costs exactly the budget you name and comes
back with a diagnosis and a shot. Assert its *presence*; never wait for it.

### 4.5 Debounced search (`search`, act:11)

`s.type("#search", "ada")` produces **one** `GET /api/search?q=ada` — a 250 ms trailing debounce.
`until: { request: "/api/search?q=ada", landed: true }`, then read `hits` from the body.

### 4.6 Keyboard-only combobox (`pickMed`, act:72‑74)

```ts
s.fill("#med", "");                                                   // s.type APPENDS — always clear
s.type("#med", "asp", { until: { request: "/api/meds?q=asp", landed: true } });
s.press("ArrowDown", { target: "#med", until: { fn: "…getAttribute('aria-activedescendant')" } });
s.press("Enter",     { target: "#med", until: { selector: "#med-selected:has-text('Selected:')" } });
```

`#med` is **not** debounced (typing `asp` issues `q=a`, `q=as`, `q=asp`), so wait on the request for
the *full* prefix. Options are `ul#med-list[role=listbox] > li#med-opt-N`; `ArrowDown` sets
`aria-activedescendant`; `Enter` commits and hides the list. See §6 for why the mouse is not an option.

### 4.7 Virtualised rows (`loadRows`, `scrollRowsTo`, act:83, act:85)

`#load-rows` fetches **all 10 000 rows once** (484.7 KB) and renders 23‑28 `.row` nodes over a
240 000 px inner div (24 px each). Row 5000 is on the wire, not in the DOM.

```ts
await s.evaluate("document.querySelector('#rows').scrollTop = 24*5000");
s.until({ fn: "document.querySelector('#rows .row')?.dataset.id !== '<previous>'" })  // wait on the EFFECT
```

### 4.8 The re-render race (`clickRerender`, act:13 → act:16)

`#rerender` is replaced on hover (`ctl.rerenderOnHover`). A real mouse click burns the full 3 s
actionability budget and is diagnosed `detached`. `{ js: true }` does it in 33 ms.

### 4.9 Iframes, three depths (`submitSameFrame` / `submitCrossFrame` / `submitDeepFrame`, act:24‑29)

`{ frame: "#same-origin" }` → `#if-name`/`#if-submit`/`#if-result` → `POST /api/iframe-submit`.
`{ frame: "#cross-origin" }` (served from **:4801**) → `#xf-name`/`#xf-submit` → `POST /api/xframe-submit`
**to :4801**, in the same log with `host=localhost:4801`.
`{ frame: "#same-origin >> #nested2" }` → `#deep-name`/`#deep-submit` in `/iframe2.html`.
Iframe contents never appear in the aria diff — a `not-found` inside a frame lists that *frame's*
controls, which is how the ids above were discovered in the first place.

### 4.10 Native dialogs (`nativeDialog`, `armUnloadAndNavigateAway`, act:37‑40)

`#alert` → alert "Hello from gauntlet"; `#confirm` → confirm "Proceed?"; `#arm-unload` then the
`#nav-away` link → a `beforeunload`. All are handled by the session policy
(`open(app, { dialogs: "accept" | "dismiss" })`, default accept) and land in the `dialogs` table with
type/message/handling. With `accept`, the navigation goes through and you land on `/away.html`;
come back via `a#back`.

### 4.11 Child window (`openChildWindow`, act:31/48)

`s.click("#open-child", { until: { page: "child.html" } })` → ~145 ms. Drive it as an ordinary
Playwright page from `s.context.pages()`. **Always `s.closeOtherPages()` afterwards** — the report
header says `(+1 other page open)` and a backgrounded page is throttled to one frame per second.

### 4.12 Canvas: pixels are the only evidence (`pickCanvasCell`, act:30/36)

400×200, 4 rows × 8 cols, 50 px cells. `s.click("#grid", { position: { x: col*50+25, y: row*50+25 } })`
paints that cell `#ffd54f` (`255,213,79,255`). **No DOM change, no request, no WS frame.** Assert by
reading the pixel back:

```ts
until: { fn: "…#grid.getContext('2d').getImageData(275,125,1,1).data … !== <before>" }
```

The cell *labels* (`"2,5"`) come from `GET /api/grid`, fetched once on load.

### 4.13 Context menu and double-click-to-edit (`contextMenuPick`, `doubleClickToEdit`, act:18‑20)

`s.rightclick("#ctx-target", { until: { selector: "#ctx-menu li", visible: true } })` — the `visible`
matters, the `<li>`s exist in the DOM while the `<ul hidden>` is closed. Then `#ctx-open|rename|delete`
sets `#ctx-result` to `ctx: Rename`. `s.dblclick("#dbl-target")` swaps the div for an `<input>` and
`#dbl-state` goes `idle` → `editing`.

### 4.14 Drag: slider and reorder (`setSlider`, `moveItemDownOneSlot`, act:69, act:70, act:80)

Slider: `s.drag("#slider-thumb", { dx: 120, dy: 0 })` → `value: 43` (302 px track, 22 px thumb,
value = percent of travel). Reorder: **`s.drag("#sort-a", "#sort-b")` does nothing** — one straight
move to the *adjacent* item's centre never crosses its midpoint — while `s.drag("#sort-a", "#sort-c")`
moves it one slot (`a,b,c` → `b,a,c`). Both releases `POST /api/drag-report`, *including the one that
changed nothing*, so the request is not evidence. A hand-rolled `s.page.mouse` path with
`{ steps: 25 }` and an overshoot past the last item moves it to the end (`b,c,a`).

### 4.15 Shadow DOM (`clickShadowButton`, act:95)

The root is **open**, so an ordinary CSS descendant selector pierces it: `#shadow-host #shadow-btn`.
The counter inside it is invisible to the aria diff — assert through `.shadowRoot` in an `until: { fn }`.

### 4.16 GraphQL over POST (`graphql`, act:21/22)

One endpoint, `POST /api/graphql`, body `{query}`. The response echoes `operation` and `sawMutation`,
so the server really parses it. **Both are 200** — a GraphQL-level failure would not show as a 4xx;
check the body.

### 4.17 The fake stream (`loadFakeStream`, act:23)

`GET /api/fake-stream` is served as `text/event-stream` but is a finite 97-byte XML document. It is
captured normally (`body_state: ok`). Only the genuinely endless `/api/notify-sse` shows
`body_state: streaming`. **Mime is not evidence of streaming — `body_state` is.**

### 4.18 Push channels (`pushNotification`, act:59‑63)

Arm first, trigger second (the trigger is outside the page's own event flow):

```ts
const p = s.until({ all: [ {ws:"notify"}, {fn:"…#notif-list li.length > N"} ] }, { timeout: 8000 });
await ctl(s, { push: "ws" });                  // POST /ctl {"push":…}
reached(await p);
```

| Channel | Where the evidence is | Latency |
|---|---|---|
| `ws` | a `ws_frames` row `{"type":"notify","n":4,"via":"ws",…}` **and** the DOM | ~13 ms |
| `sse` | **the DOM only** — `/api/notify-sse` is `body_state: streaming`, messages are never captured | ~8 ms |
| `poll` | the `GET /api/notify-poll` response (`landed: true`) **and** the DOM | ~126 ms |

The long-poll channel only exists when `ctl.notify` is on: the page then holds a `GET /api/notify-poll`
(pending up to `ctl.notifyPollHoldMs` = 25 s) and reissues it the instant it lands — so the wire line
in your report shows the *new* pending poll, not the one that answered you.

### 4.19 Ambient traffic (`observeAmbient`, act:65)

`ctl.ambient` turns on `GET /api/heartbeat` every `ctl.heartbeatMs` (5 s) and a `GET /api/poll` that
holds `ctl.pollHoldMs` (3 s) and reissues, plus a server WS push every `ctl.wsPushMs` (7 s). They land
inside whatever act happens to be open — this is the "poll that is in every report". Header counters
`#heartbeat-count` / `#poll-count` are the cheap assertion.

### 4.20 Session timeout (`sessionTimeoutAndRecover`, act:67/68)

`ctl.timeoutMs` of idleness raises a `[role=dialog]` "Session expiring / Your session will expire due
to inactivity / Stay signed in" and sets `#timeout-state` to `expired`. Clicking **Stay signed in**
(`until: { gone: "[role=dialog]" }`) resets the state to `off`.

### 4.21 Auth (`gotoSecure`, `login`, `logout`, act:52/53)

With `ctl.requireAuth`, `GET /secure.html` **and `GET /`** become `302 → /login.html?next=<path>`.
The form is `#user` / `#pass` / `#login`, errors in `#login-error`. `POST /api/login` accepts **any
non-empty user and pass** (`admin`/`admin` is not a credential, just the first pair I tried) and sets
`gauntlet_auth=<user>; HttpOnly`; only an empty field is a 401. After login you go wherever `?next=`
said. Read the cookie from `resp_headers` or `s.context.cookies()` — `document.cookie` is empty.
`s.context.clearCookies()` is the logout.

## 5. Interstitials and recovery

| Interstitial | When | Handling |
|---|---|---|
| `#record-modal` "Allergy Review Required" | opening any record while `ctl.modal`; possibly `ctl.modalDelayMs` late | `any` arm + a grace window, then `#record-modal button` with `until: { gone }` |
| `[role=dialog]` "Session expiring" | `ctl.timeoutMs` of idle | click "Stay signed in", `until: { gone: "[role=dialog]" }` |
| `/login.html?next=…` | `ctl.requireAuth` and no cookie — on **any** page including `/` | make `#login` an arm of the home anchor; log in and continue |
| native `alert` / `confirm` / `beforeunload` | §11 buttons and the away link | session policy (`dialogs: "accept"`), recorded in `dialogs` |
| a leftover popup | after §15 | `s.closeOtherPages()` |

**Recovery from anywhere:** `goHome(s)` — `s.navigate("http://localhost:4800/")` with
`until: { any: [ {selector:"#load-chart"}, {selector:"#login"} ] }`. It always navigates, on purpose:
a reload is ~150 ms and it is the only way to make the page's WebSocket visible to your session (§7).
`ctlReset(s)` puts the knobs back.

## 6. Input recipes

- **`s.type` appends.** Typing `asp` into a `#med` that already held `Aspirin` produced
  `GET /api/meds?q=Aspirinasp` and a 5 s timeout. `s.fill(target, "")` first, every time.
- **Combobox:** clear → `type` with `until: { request: <full prefix>, landed: true }` → `press("ArrowDown")`
  → `press("Enter")`. The mouse is never needed and is unreliable: the list is re-rendered on every
  keystroke and removed on selection, so a click on `#med-opt-0` usually lands on nothing.
- **Re-render race:** `{ js: true }`.
- **Reorder drag:** target the item **two** slots away, not the adjacent one.
- **Slider:** offset drag `{ dx, dy: 0 }` from the thumb; assert with
  `until: { all: [ <value changed>, { request: "/api/drag-report" } ] }` — the DOM value updates on
  mousemove, *before* the POST is issued on mouseup, so a value-only `until` returns too early for an
  act-scoped store read.
- **Hidden menus:** `until: { selector: "#ctx-menu li", visible: true }` — the nodes exist while hidden.
- **Canvas:** `position: { x, y }` + a `getImageData` `until: { fn }`.
- **Login twice:** reload the form between attempts, or the stale `#login-error` makes your error arm
  `alreadyTrue`.

## 7. Gotchas

1. **`#chart-status` never changes.** The spinner lies; anchor on `#chart`.
2. **`Saved ✓` is a lie too**, and permanent. The truth is `GET /api/save/status`'s **status code**;
   its body is never read (`body_state: missing`).
3. **WebSocket frames are only captured for sockets opened while your session was attached.** The
   socket opens on page load, so a script that *joins* an already-loaded page sees **zero** frames and
   `until: { ws }` silently burns its whole budget. Navigate (reload) inside your session first. This
   cost me a confused ten minutes and is the single most surprising thing in the pack.
4. **`text/event-stream` ≠ streaming.** `/api/fake-stream` is captured; `/api/notify-sse` is not.
   Check `body_state`.
5. **`POST /api/drag-report` fires even when the drag did nothing.** A 200 on the wire is not proof of
   a reorder; assert `#sort-order`.
6. **The header statusbar changes on nearly every act** (ws/frames/heartbeats/last frame/ctl). Set
   `s.uiIgnore = [/ws: open/, /last ws frame/, /effective ctl/, /heartbeats/]` or every report is noise.
7. **The aria diff glues adjacent elements** into one line (`"status: idle Chart loaded (3 responses)"`,
   `"Right-click me result: ctx: Rename"`). Anchor on ids.
8. **`ctl.requireAuth` guards `/` too**, not just `/secure.html`.
9. **`#noop-disabled` is diagnosed `disabled` in ~100 ms**, before any hit test — so the
   `pointer-events: none` trap on its `.field-wrap` parent never actually fires through disco.
10. **`#noop` is a true no-op**: it costs exactly the 700 ms window and produces nothing — not even a
    WS frame (it is the one button excluded from the `action` frame).
11. **Two different "Back to the gauntlet" links**: `a#back` on `/away.html`, `a#home` on
    `/secure.html`. Anchor on the id.
12. **State leaks between scripts.** A second script joins the browser where the last one left it —
    mid-modal, on `/away.html`, with knobs flipped. Start with `goHome` + `ctlReset`.

## 8. Open questions

- **Does the modal depend on the record, or only on `ctl.modal`?** All five records carry allergies,
  so I could not separate them (act:88‑92 — with `modal:true` all five raise it, with `modal:false`
  none do). The experiment: add a record with `allergies: []` server-side, or find one — I did not.
- **`ctl.renderDelayMs`** — I set it to 600 together with `modalDelayMs` (act:93) and never isolated
  what it delays on its own. Experiment: set only `renderDelayMs` and time `#record h3` against
  `GET /api/record/:id`'s `t_end`.
- **`dialogs: "dismiss"`** — I only ever ran the default `accept`. With `dismiss`, `#nav-away` should
  leave you on `/`. Experiment: `open(app, { dialogs: "dismiss" })`, then `armUnloadAndNavigateAway`.
- **The child window's `#child-fetch`** — I read `/child.html` and its `GET /api/child-ping` handler
  but never clicked it, so I have not confirmed a popup's requests are attributed to the driving act.
- **`ctl.wsPushMs`** (server-initiated WS push under `ambient`) — I confirmed heartbeat and poll but
  did not wait out the 7 s push. Experiment: `observeAmbient` with an `until: { ws: "notify" }` arm and
  a 9 s budget.
- **`#ws-count` vs `ws_frames`** — the header counts frames the *page* saw; whether it ever disagrees
  with the log (dropped frames, reconnects) is untested.
