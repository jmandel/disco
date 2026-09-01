# gauntlet

`bun gauntlet/server.ts --port 4800` → `http://localhost:4800` (and a second origin on `:4801`).
Drive it with `lib.ts`; `node scripts/run-check.ts gauntlet` proves lib.ts still works (30/30).

## 1. What it is

A single-page app served from one HTML shell (`GET /`) plus one ES module (`GET /app.js`). No routing,
no framework: every one of the ~26 numbered `<section>`s on that one page is an independent hazard —
concurrent fetches, a conditional modal, optimistic UI, a perpetual spinner, three push channels, a
debounced search, a virtualised list, a re-render race, three iframes (one cross-origin), native
dialogs, a session timer, a child window, a canvas, a keyboard-only combobox, shadow DOM, SSE,
GraphQL, and an auth wall. Facts live on the wire: almost every section is *one* `/api/*` call whose
JSON is the truth, and the DOM is a lossy rendering of it (sometimes a lying one — see §3 Save).
There is a standing WebSocket and a standing EventSource from page load. Auth is off by default; when
`ctl.requireAuth` is on, **every** HTML page 302s to `/login.html?next=…` and any credentials are
accepted, setting `gauntlet_auth=<user>; HttpOnly`.

The app is **fully deterministic and remote-controlled** by a control plane, `GET/POST /ctl`
(see `wire.md`). That is the single most useful thing to know: you do not wait for a hazard to
happen by chance, you switch it on. `POST /ctl/reset` puts everything back.

## 2. Glossary

| The app's word | On screen | On the wire |
|---|---|---|
| **ctl** | `#ctl-state` in the header (what the *page* believes) | `GET /ctl`, `POST /ctl`, `POST /ctl/reset` |
| **record** | `#record` after clicking `#record-N` | `GET /api/record/N` → `{id,name,dob,mrn,allergies[]}` |
| **chart** | `#chart` "Chart loaded (3 responses)" | `GET /api/slow?ms=` + `/api/chart/a` + `/api/chart/b` |
| **row** | one `.row[data-id]` inside `#rows-inner` | one element of the 10 000-item array from `GET /api/rows` |
| **notification** | `#notif-count` / `#notif-list` "Result N via ws" | a WS frame, an SSE message, or `GET /api/notify-poll` |
| **heartbeat / poll** | `#heartbeat-count` / `#poll-count` | `GET /api/heartbeat` / `GET /api/poll` (ambient) |
| **action frame** | `#ws-count`, `#ws-last` | WS out `{"type":"action","id":"<element id>","t":…}` |
| **toast** | `[role=status]`, lives `ctl.toastMs` | — (rendered, never fetched) |
| **the x-origin** | `#x-origin` in the header | `http://localhost:4801` — the cross-origin iframe's origin |

## 3. Anchors

| Screen | URL | Anchor |
|---|---|---|
| the shell | `http://localhost:4800/` | `#load-chart` (**not** `{url:"/"}` — that predicate is always true) |
| away page | `/away.html` | `h1:text-is("You navigated away")` |
| login | `/login.html?next=…` | `#login-form` (visible controls: `#user`, `#pass`, `#login`) |
| secure area | `/secure.html` | `#who` → `Welcome, <user>` |
| child window | `/child.html` (a second page) | `#child-fetch` on that page object |
| allergy modal | — | `#record-modal[role=dialog]`, button `#modal-ack` |
| session dialog | — | `#session-timeout[role=dialog]`, button `#stay` |

`lib.ts` exports `atShell(s)` (assert, else navigate) and `SHELL`/`LOGIN`/`SECURE`.

## 4. Workflows

Each one is a function in `lib.ts`; the act ids are the evidence in `NOTES.md`.

### Load chart — three concurrent fetches, one slow (§1) · `loadChart` · act:3, act:13, act:123

```ts
await s.click("#load-chart", { until: { selector: "#chart:has-text('Chart loaded')" }, timeout: 8000 });
```
One click fans out to `GET /api/slow?ms=<ctl.slowMs>`, `/api/chart/a`, `/api/chart/b`; the render waits
for all three. **The status span is a trap**: `#chart-status` goes `loading…` → back to `idle`, so any
predicate on it is already-true before *and* after. Varies with `ctl.slowMs` (400 default; at 1500 the
until took 1799 ms) and with `ctl.renderDelayMs`, which delays *only this* render past the wire by that
much (act:139: `#chart` still empty when `/api/slow` landed, filled 1285 ms later).

### Open a record, with the interstitial modal (§2) · `openRecord` · act:4, act:56, act:76

```ts
const rep = await s.click(`#record-${id}`, { until: { any: [
  { selector: "[role=dialog]", label: "dialog" },
  { selector: `#record h3:text-is("Record ${id}")`, label: "record" } ] } });
await dismissRecordModal(s);                       // idempotent; also catches a *late* modal
```
Postcondition: `#record h3:text-is("Record N")` and no `#record-modal`. The record itself is read from
`store.latestJson("/api/record/N")`, never scraped. **What varies:** the modal appears for *every*
record when `ctl.modal` is true and for none when it is false — it is not a property of the record
(all five have allergies). With `ctl.modalDelayMs`, `until.which === "record"` and the overlay lands
*afterwards*; the next click then fails `occluded — over div#record-modal.overlay` (act:80).

### Save — optimistic UI whose screen never corrects itself (§3) · `save` · act:11, act:74

```ts
await s.until({ gone: "[role=status]" });          // the previous toast makes the next one already-true
await s.click("#save", { until: { any: [
  { selector: "[role=status]:has-text('Save failed')", label: "failed" },
  { selector: "[role=status]:has-text('Saved')",       label: "saved"  } ] } });
const status = s.store.requests({ url: "/api/save/status" }).pop().status;   // 200 | 500
```
`POST /api/save` → **202**, then `GET /api/save/status?id=N`. `#save-state` flips to `Saved ✓`
immediately and **stays `Saved ✓` even when the save fails** — I waited 4 s for it to correct itself and
it never did (act:75). The only durable truth is the status code; the page never reads that body, so the
row is `body_state: pending/missing` and the status code is all disco can offer — which is enough.
The toast is the transient signal and disappears after `ctl.toastMs` (measured 788 ms at `toastMs:600`).

### Perpetual spinner (§4) · `spinnerNeverResolves` · act:126

`#spinner` is a CSS `animation: spin` with **no request behind it** (`SELECT … WHERE path LIKE '%spin%'`
→ 0 rows). `until: { gone: "#spinner" }` always burns the whole budget. Never wait on it.

### Ambient traffic (§5/22) · `runAmbient` · act:… (see NOTES)

`POST /ctl {"ambient":true,"heartbeatMs":700,"pollHoldMs":400,"wsPushMs":900}` **then reload** — the
client reads these at load. `GET /api/heartbeat` every `heartbeatMs`, a reissuing long-poll
`GET /api/poll` held `pollHoldMs`, and a WS push every `wsPushMs`. Counters: `#heartbeat-count`,
`#poll-count`, `#ambient-status`. These rows carry `action_id IS NULL` between acts and land inside
whatever act window they overlap — recognise them because they are in *every* report.

### WebSocket action frames (§6) · `wsActionFrame` · act:114–116

Every button click **except `#noop`** sends `{"type":"action","id":"<element id>","t":<epoch>}`.
Verified by counting `ws_frames WHERE dir='out'` around a `#noop` click (unchanged) and an `#alert`
click (+1). The header's `#ws-count` counts *incoming* frames.

### Debounced search (§7) · `search` · act:14

```ts
await s.fill("#search", "");                                            // clear first
await s.type("#search", "ada", { until: { request: "/api/search", landed: true } });
const hits = s.store.latestJson("/api/search").hits;
```
250 ms trailing debounce. `type` (keystrokes), not `fill`. Results render synchronously with the response.

### Virtualised rows (§8) · `loadRows`, `scrollRowsTo` · act:88

```ts
await s.click("#load-rows", { until: { selector: "#rows-count:has-text('rows')" }, timeout: 8000 });
const rows = s.store.latestJson("/api/rows");        // all 10 000, 484.7 KB, fully captured
await s.evaluate("document.getElementById('rows').scrollTop = 5000*24");
await s.until({ fn: `document.querySelector('#rows .row[data-id="5000"]') !== null` });
```
`#rows-count` **exists but is empty** before the click, so `{ selector: "#rows-count" }` is already-true.
~23 of 10 000 rows are in the DOM at any time inside `#rows-inner` (height 240000px, 24px each).
Scrolling is a *cause*: wait on the effect (the row you want being present), never read straight after.

### Re-render race (§9) · `clickRerender` · act:16 (fail), act:19 (pass)

A real mouse click times out after 3 s with `diagnosis: detached` (the button is rebuilt on every
mousemove — `ctl.rerenderOnHover`, and its `data-gen` counter climbs). `{ js: true }` lands in 108 ms.

### Frames — same-origin, depth-2, cross-origin (§10) · `iframeSubmit`, `deepIframeSubmit`, `xframeSubmit` · act:48, act:144, act:50

```ts
await s.fill("#if-name", "Grace",  { frame: "#same-origin" });
await s.click("#if-submit",        { frame: "#same-origin", until: { request: "/api/iframe-submit", landed: true } });
await s.click("#deep-submit",      { frame: "#same-origin >> #nested2", until: { request: "/api/iframe-submit", landed: true } });
await s.click("#xf-submit",        { frame: "#cross-origin",  until: { request: "/api/xframe-submit",  landed: true } });
```
The cross-origin frame is `http://localhost:4801/xframe.html` and posts to **its own** origin; those
requests are in the log under the `:4801` URL and the response says `"origin":"x"`. Note the report's
`ui` diff is the main frame only — an iframe shows up as a node, its contents never do, so a frame
transition must be asserted through `frame:`, `s.frame(...)` or the wire.

### Native dialogs (§11) · `nativeAlert`, `nativeConfirm`, `armAndNavigateAway` · act:42–45, act:157

`#alert` → `alert "Hello from gauntlet"` → `#alert-result` "alerted".
`#confirm` → `confirm "Proceed?"` → `#confirm-result` "confirmed" (session `dialogs:"accept"`, the
default) or "cancelled" (`dialogs:"dismiss"`).
`#arm-unload` → `#unload-armed:text-is('armed')`, then `#nav-away` raises a **beforeunload** dialog:
accepted → `/away.html`; dismissed → the page stays. Every dialog is recorded on the report
(`dialog confirm "Proceed?" → accept`) whichever way it is handled.

### Session timeout (§12) · `sessionTimeoutAndStay` · act:118, act:132

`POST /ctl {"timeoutMs":1200}` **then reload** → `#timeout-state` "armed (1200 ms)". After that much
idle: "expired" plus `#session-timeout[role=dialog]` "Session expiring". `#stay` closes it and
**re-arms** the timer (it fired again 1284 ms later). This overlay covers the whole page — it is the
usual cause of a surprise `occluded` several steps later.

### No-op and the disabled control (§13) · act:7, act:8

`#noop` does nothing at all — no request, no WS frame, no DOM change; it is the 700 ms bare-act
baseline. `#noop-disabled` is `disabled` *and* `pointer-events: none` inside `div.field-wrap`, so
`document.elementFromPoint` over it returns the parent — disco reports the more useful
`diagnosis: disabled` in ~100 ms rather than `occluded`.

### Delete (§14) · `deleteItem` · act:35

`#delete` → `DELETE /api/item/1` → `{"deleted":1}` → `#delete-result` "deleted 1".

### Child window (§15) · `openChildAndPing` · act:51, act:145

`#open-child` opens `/child.html` as a real second page. There is **no `until` predicate for "a page
appeared"** — act bare with a `window`, then read `report.pages` / `s.context.pages()`, drive the child
with plain Playwright, and `s.closeOtherPages()` afterwards (a background page is throttled to ~1 fps
and makes the driven page mysteriously slow; the report header says `(+1 other page open)`).
The child's own traffic (`GET /api/child-ping` → `{"pong":true}`) is in the same log.

### Canvas grid (§16) · `selectGridCell` · act:55

Pixels only: nothing in the DOM changes, and the aria diff is empty. The grid is seeded by
`GET /api/grid` (4 rows × 8 cols → 50 px cells on a 400×200 canvas). `act` has no *position* option, so
address a cell with raw coordinates: `s.page.mouse.click(box.x+1+x, box.y+1+y)` (the `+1` is the canvas
border). Readback: `window.__gridSelected === {r,c}` and the cell pixel becoming `255,213,79`.

### Keyboard-only combobox (§17) · `pickMedication` · act:24, act:28, act:29–31

```ts
await s.type("#med", "as", { until: { request: "/api/meds", landed: true } });
const idx = s.store.latestJson("/api/meds").hits.indexOf("Aspirin");    // the order is the wire's
for (let i = 0; i <= idx; i++)
  await s.press("ArrowDown", { target: "#med", until: { selector: `#med-opt-${i}[aria-selected="true"]` } });
await s.press("Enter", { target: "#med", until: { selector: `#med-selected:has-text("Aspirin")` } });
```
Clicking an option gives `diagnosis: unclickable — pointer-events: none on li#med-opt-1`. `/api/meds`
matches a **subsequence**, not a prefix ("as" → Atorvastatin, Aspirin, Montelukast, Simvastatin), so
compute the arrow count from the response rather than assuming.

### Shadow DOM (§18) · `clickShadowButton` · act:32

Open shadow root; Playwright pierces it: `s.click("#shadow-host >> #shadow-btn")`. The counter is only
reachable through `shadowRoot`, so the postcondition is an `until: { fn }`.

### Server-sent events (§19) · `runSse` · act:148

`#start-sse` → `GET /api/sse`; `#sse-status` idle → **open** → **done**; 5 events ~500 ms apart, ~2.7 s
total. The request row is `body_state: streaming` while open and **`missing`** once it closes: SSE
messages are not captured, so `#sse-log` `<li>`s are the only record.

### GraphQL over POST (§20) · `graphql` · act:36, act:37

Both operations use the *same* `POST /api/graphql` and both return 200 — a `{ request }` predicate
cannot tell them apart. The operation is in `requests.req_body`; the response echoes
`"operation"` and `"sawMutation"`.

### Auth (§21) · `reachSecureArea`, `login`, `logout` · act:92, act:97, act:98, act:99

```ts
await ctl(s, { requireAuth: true });
const rep = await s.navigate("/secure.html", { until: { any: [
  { selector: "#who", label: "secure" }, { selector: "#login-form", label: "login" } ] } });
if (rep.until.which === "login") await login(s, "demo", "s3cret");
```
With `requireAuth`, **every** HTML page (including `/`) 302s to `/login.html?next=<path>`. Any
user/pass is accepted (`POST /api/login` → 200, `set-cookie: gauntlet_auth=<user>; Path=/; HttpOnly`),
and the login page then does `location.href = next` — so do **not** wait on `{url:"/secure.html"}`
after logging in from `/`: you land wherever `next` said (act:97 cost 5 s learning that). Logout is
`s.context.clearCookies()`. The login page checks only `r.ok`, so `/api/login`'s body is `missing` in
the log unless you fetch it yourself.

### Push channels (§23) · `push`, `enablePollChannel` · act:107–112

`POST /ctl {"push":"ws"|"sse"|"poll"}` delivers one notification down the named channel;
`#notif-count` increments and `#notif-list` gains `Result N via <channel>`. ws and sse arrive in
under 5 ms on channels that are standing from page load. **The poll channel does not exist unless
`ctl.notify` is true** (client-side knob → reload); with it off, `{"push":"poll"}` is silently
dropped — I burned 30 s of budget on that before checking `SELECT … WHERE path LIKE '%notify%'`.

### Context menu (§24) · `contextMenuPick` · act:20, act:21

`s.rightclick("#ctx-target", { until: { selector: "#ctx-menu[role=menu]" } })` then click
`#ctx-open|#ctx-rename|#ctx-delete` with `until: { gone: "#ctx-menu" }` → `#ctx-result` "ctx: Rename".

### Double-click to edit (§25) · `editValue` · act:22, act:151–153

`dblclick #dbl-target` → `until { selector: "#dbl-input" }` (the div is *replaced* by an input) →
`fill` → `press Enter` → `#dbl-state` becomes **`committed: <value>`** (not "saved" — I guessed "saved"
and paid 5 s) and `#dbl-target` shows the new text.

### Slider and list reorder (§26) · `setSlider`, `moveItemToEnd` · act:33, act:34

`s.drag(target, to)` only accepts a **selector** as the destination — passing `{x,y}` fails with
`error — locator.dragTo: target: expected string, got undefined`, so a slider needs raw
`s.page.mouse.move/down/move({steps})/up`. 75 % of the track → `#slider-value` 77.
For `#sort-list`, `s.drag("#sort-a","#sort-c")` moves the item exactly **one** slot (`a,b,c` → `b,a,c`);
a stepped path past the bottom edge of `#sort-c` gives `b,c,a`. Every drop POSTs
`/api/drag-report {"widget":"sort","order":"b,c,a"}`.

### Fake stream (§28) · `loadFakeStream` · act:38

`GET /api/fake-stream` is served as `text/event-stream` but is an ordinary finite 97-byte body
(`<envelope>…</envelope>`) which the page reads with `.text()`. It is captured normally
(`body_state: ok`) — an event-stream mime is not evidence of a stream.

## 5. Interstitials and recovery

| Interstitial | When | Handling |
|---|---|---|
| `#record-modal` "Allergy Review Required" | any record while `ctl.modal`; possibly `ctl.modalDelayMs` **after** the record renders | `any`-of `[dialog, record]`, then `dismissRecordModal(s)` (click `#modal-ack`, `until: { gone: "#record-modal" }`) |
| `#session-timeout` "Session expiring" | `ctl.timeoutMs` ms of idle | `#stay` with `until: { gone: "#session-timeout" }`; it re-arms, so expect it again |
| native `alert` / `confirm` | `#alert` / `#confirm` | handled by the session's `dialogs` mode; they appear in `report.dialogs` |
| native `beforeunload` | any navigation once `#arm-unload` is armed | accept → you leave; dismiss → you stay |
| `/login.html?next=…` | any page while `ctl.requireAuth` | add `{ selector: "#login-form", label: "login" }` as an arm of your anchors; `login()` costs ~200 ms |
| a leftover child window | after `#open-child` | `s.closeOtherPages()` — otherwise the driven page is throttled |

**Recovery, in order:** `POST /ctl/reset` (kills every knob-driven hazard) → `s.context.clearCookies()`
→ `s.navigate("http://localhost:4800/", { until: { selector: "#load-chart" } })`. A reload clears any
open overlay, the WS reconnects and every counter resets. That is exactly `atShell(s, {reload:true})`.

## 6. Input recipes

- **Combobox `#med`** — `type`, wait for `/api/meds`, `press("ArrowDown")` once per option down the
  wire's ordering, `press("Enter")`. Never click an option (`pointer-events: none`).
- **Search `#search`** — `fill("")` to clear, then `type` (a `fill` does not produce the keystrokes the
  250 ms debounce listens for reliably), wait on `{ request: "/api/search", landed: true }`.
- **`#rerender`** — `{ js: true }` always; a real click is `detached`.
- **Slider `#slider-thumb`** — raw `page.mouse` with `steps: 12`; then `until: { fn }` on
  `#slider-value`, because the drop is applied on the next event.
- **`#sort-list`** — a stepped mouse path past the target's far edge; `s.drag()` moves one slot only.
- **Canvas `#grid`** — `s.scroll("#grid")` first, then `page.mouse.click(box.x+1+cx, box.y+1+cy)`.
- **Edit `#dbl-target`** — `dblclick` → `#dbl-input` → `fill` → `Enter`.
- **Child window** — bare click + `window: 1200`, then plain Playwright on the page object.

## 7. Gotchas

1. **`#chart-status` returns to `idle`.** Never a postcondition. Same shape: `#rows-count` exists but
   is empty before loading; `[role=status]` still holds the *previous* toast; `#load-chart` is already
   true for "we stayed on the shell". Pick something that is false beforehand or the report says
   `⚠ already true — proves nothing` (it did, four times, and it was right every time).
2. **`#save-state` lies permanently.** A failed save still reads `Saved ✓`. Use
   `requests.status` on `/api/save/status`.
3. **Optimistic body-less responses.** `/api/save/status`, `/api/login` and `/api/drag-report` are
   never read by the page → `body_state: missing/pending`. The status code is the signal.
4. **`text/event-stream` ≠ streaming** (`/api/fake-stream`), and a real stream's messages are *not*
   in the log (`/api/sse`, `/api/notify-sse`) — read the DOM for those.
5. **Client-side ctl knobs need a reload**: `ambient`, `heartbeatMs`, `pollHoldMs`, `wsPushMs`,
   `timeoutMs`, `notify`, `notifyPollHoldMs`, `renderDelayMs`. `#ctl-state` shows what the page believes.
6. **`ctl.renderDelayMs` decouples the DOM from the wire** — for the chart only. A `{ request, landed }`
   postcondition can be true while the screen is still empty.
7. **Ambient rows appear in unrelated reports.** They carry `action_id IS NULL` between acts;
   attribution is a time window, not a classifier.
8. **The aria diff is main-frame only.** iframe contents never appear in `report.ui`.
9. **State leaks between scripts.** An overlay, a logged-in cookie, a flipped knob and an open child
   window all survive. Every `lib.ts` entry point starts with `atShell(s)`.
10. **`{ url: "/" }` is always true**, and after a login from `/` you land on `next`, not `/secure.html`.
11. **Read the wire by act id, not by "latest".** `apps/gauntlet/store/` outlives browsers, and `t` /
    `t_start` restart with every run — so `latestJson(...)` and `ORDER BY t DESC` can hand you a row
    from a previous session. `lib.ts` uses `jsonFrom(s, rep, url)` / `statusFrom(s, rep, url)`, which
    scope to `rep.action`; for `ws_frames` use `seq` (a global AUTOINCREMENT), never `t`. This is what
    turned a warm-green check red the first time I ran it against a fresh browser.

## 8. Open questions

- `ctl.renderDelayMs` only visibly delayed the chart. Does it gate anything else? Experiment: set it
  to 2000, reload, and walk every section with `{ request, landed: true }` postconditions, timing the
  gap to each section's DOM anchor.
- `ctl.rerenderOnHover: false` — is `#rerender` then clickable with a real mouse? Experiment: set it,
  reload, `s.click("#rerender")` without `js:true` and expect no `detached`.
- Does user activity (not just `#stay`) reset the idle timer? Experiment: `timeoutMs: 3000`, reload,
  click `#noop` every second and assert `#session-timeout` never appears within 8 s.
- Is `#alert`'s dialog ever `dismiss`-able into a different `#alert-result`? (An alert has no cancel;
  I expect "alerted" either way, untested.)
- Section 27 is missing from the page (sections run 1–26 then 28). Something is either unimplemented
  or hidden behind a knob I did not find; `GET /ctl` has no obviously matching key.
- `/api/grid`'s `cells[].label` never appears on screen. Is it drawn at a zoom level, or dead payload?
