# gauntlet

A deterministic, deliberately hostile single-page test app served by `bun gauntlet/server.ts`
(default `http://localhost:4800`, with a second **x-origin** on `:4801` for the cross-origin iframe).
Each numbered section (`#s-1`..`#s-28`) demonstrates one browser-automation hazard. This folder
characterizes it well enough for a human to understand and for `lib.ts` to drive it.

## 1. What it is

- **One server-rendered page** at `/`, all behavior wired by a single ES module `/app.js`. **No client
  routing** — the only real navigations are `/login.html`, `/secure.html`, `/child.html`, `/away.html`.
- **JSON API** under `/api/*` (one endpoint is GraphQL-over-POST). Facts live on the wire: records,
  search hits, the row list, the save outcome, gql results — read them from the store, not the DOM.
- **Three push channels** (WebSocket, SSE, long-poll) plus optional ambient traffic (heartbeat +
  reissuing long-poll + periodic WS push).
- **A server-side knob store at `/ctl`** turns each hazard on/off and tunes its timing. `GET /ctl` reads
  the effective state, `POST /ctl` merges a patch (and fires `push`), `POST /ctl/reset` restores defaults.
  There is no UI for it; drive it from the page (`lib.ts` `getCtl`/`setCtl`/`resetCtl`). **The app is
  stateful — always `resetCtl` at the start of a workflow so a leftover knob doesn't change behavior.**
- **Auth** is a cookie `gauntlet_auth=<user>` (HttpOnly), gating `/secure.html` only when `requireAuth`.

## 2. Glossary (the app's nouns, on screen ↔ on the wire)

| Noun | On screen | On the wire |
|---|---|---|
| **ctl / knobs** | header "effective ctl: {…}" | `GET/POST /ctl`, `POST /ctl/reset` |
| **record** | section 2, heading "Record N" + `id/name/dob/mrn/allergies` | `GET /api/record/N` |
| **allergy modal** | overlay "Allergy Review Required" (`div#record-modal.overlay`) | none — client-rendered when ctl `modal` |
| **save outcome** | toast `[role=status]` "Saved" / "Save failed (async)" | `POST /api/save` (202) then `GET /api/save/status?id=N` |
| **row** | section 8, `#rows-inner > .row[data-id]` (only ~two dozen mounted) | `GET /api/rows` (10000 items) |
| **med / suggestion** | section 17 combobox `#med`, `#med-list li[role=option]` | `GET /api/meds?q=` |
| **notification** | section 23, `#notif-count`, `#notif-list li` | ws frame / `/api/notify-sse` / `/api/notify-poll` |
| **heartbeat / poll** | header counts | `GET /api/heartbeat`, `GET /api/poll` (ambient only) |
| **x-origin** | header "x-origin", the yellow cross-origin iframe | served from `:4801` |

## 3. Anchors (cheap "am I here?" assertions)

| Screen | URL | Element |
|---|---|---|
| Shell (everything) | `http://localhost:4800/` (`location.pathname === '/'`) | `#statusbar` |
| Record open | `/` | `#record h3:has-text("Record N")` |
| Allergy modal up | `/` | `#record-modal` (occludes the page) |
| Login page | `location.pathname === '/login.html'` | `#login` |
| Secure area | `location.pathname === '/secure.html'` | `h1:has-text("Secure area")` |
| Child window | `page:1`, `/child.html` | `button` "Fetch in child" |
| Session-timeout warning | `/` | `[role=dialog]:has-text("Session expiring")`, `#stay` |

> **Do not** anchor auth on `{url:"/secure.html"}` — the login URL is `?next=/secure.html`, so the string
> is already present. Use `location.pathname` (see Gotchas).

## 4. Workflows

Each is a function in `lib.ts`; the act ids below are from the discovery run (evidence in `store/`).

### Load Chart — 3 concurrent fetches, one slow (`loadChart`, act:3)
```
click #load-chart  until #chart:has-text("Chart loaded")   # NOT #chart-status (stays "idle")
```
Fires `GET /api/slow?ms=<slowMs>` (slow arm), `/api/chart/a`, `/api/chart/b` concurrently. Postcondition:
`#chart` shows "Chart loaded (3 responses)". Varies: `slowMs` (default 400) changes the slow arm's duration.

### Open a record, handle the conditional modal (`openRecord` + `ackModalIfPresent`, act:5, act:37/38)
```
click #record-N   until #record h3:has-text("Record N")     # body from GET /api/record/N
# if ctl.modal: an "Allergy Review Required" overlay is up and OCCLUDES the page
click #modal-ack  until gone #record-modal
```
Read the record from the wire (`latestJson("/api/record/N")`). With `modal:false` no overlay appears; with
`modal:true` every record open adds one. Evidence that it occludes: act:38 `diagnosis occluded — #record-4 is
covered by div#record-modal.overlay`.

### Save — optimistic UI, async toast (`save`, act:101 ok / act:105 fail)
```
(clear stale toast: until gone [role=status])
click #save  until any[ [role=status]:has-text("Save failed") | [role=status]:has-text("Saved") ]
```
`#save-state` flips to "Saved ✓" **immediately** (optimistic). `POST /api/save` → 202 `{id,pending}`; the
client waits ~500 ms, then `GET /api/save/status?id=N`. Outcome is the toast: "Saved" (ok) or
"Save failed (async)" when ctl `saveFails:true` (status 500, plus a console 500 error). Postcondition:
`return.outcome === "ok" | "fail"`. **Do not** wait on `{request:"/api/save/status", landed:true}` — see Gotchas.

### Debounced search (`search`, act:18)
```
type #search "<q>"  until request /api/search?q=<q> landed   # 250 ms trailing, resource_type xhr
```
Read hits from `latestJson("/api/search")`. Use `type` (keystrokes), not `fill`.

### Virtualized rows (`loadRows` + `scrollRowsTo`, act:19 + p21)
```
click #load-rows  until #rows-count:has-text("rows")        # total from GET /api/rows (10000)
# only ~23-28 .row nodes are ever mounted (#rows-inner, ROW_H=24, overflow auto)
scrollTop = 5000 ; until first #rows-inner child's data-id changes   # -> first data-id 203
```
Total count comes from the wire; the DOM only holds the visible window. Postcondition after scroll:
`firstId >= 100`.

### Keyboard-only combobox (`pickMed`, act:20-22)
```
type #med "<q>"           until request /api/meds landed     # fill() does NOT work
press ArrowDown (target #med)  until #med-list li[aria-selected='true']
press Enter (target #med)      until #med-selected:has-text("Selected")
```
Options are `#med-list li[role=option][aria-selected]`; commit sets `#med-selected` = "Selected: X".

### GraphQL over POST (`gqlQuery` / `gqlMutate`, act:26/27)
```
click #gql-query   until request /api/graphql landed   # {operation:"query", data:{patient:{name}}}
click #gql-mutate  until request /api/graphql landed   # {operation:"mutation", sawMutation:true}
```

### Re-render race (`clickRerender`, act:51)
The `#rerender` button is `replaceWith`-ed every 100 ms (and on hover when `rerenderOnHover`). A normal
`click` times out (`element was detached from the DOM`). The click handler is delegated on `#rerender-host`,
so dispatch it programmatically:
```
evaluate("document.getElementById('rerender').click()")   # then until #rerender-count increments
```

### Delete (`deleteItem`, act:11)
```
click #delete  until #delete-result:has-text("deleted")   # DELETE /api/item/1 -> {deleted:1}
```

### Push channels (`notifyVia`, s-23)
Trigger one notification and wait for `#notif-count` to advance:
```
POST /ctl {push:"ws"}    -> WebSocket frame {type:notify,via:"ws"}          (channel always up)
POST /ctl {push:"sse"}   -> /api/notify-sse event                          (channel always up)
POST /ctl {push:"poll"}  -> /api/notify-poll  — ONLY when ctl.notify:true  (else silently nothing)
```
Last item text is `#notif-list li:last-child` = "Result N via <ch>".

### Auth (`login` / `enterSecure`, act:59-66)
```
ctl requireAuth:true ; clearCookies
navigate /secure.html  -> 302 -> /login.html?next=/secure.html   (until location.pathname==='/login.html')
fill #user, fill #pass (ANY non-empty pair works)
click #login  until any[ pathname==='/secure.html' | #login-error:has-text('login failed') ]
```
Sets cookie `gauntlet_auth=<user>` (HttpOnly). Secure page greets "Welcome, <user>". Empty creds → 401.

### Other verified behaviors
- **Ambient traffic** (s-5/22): ctl `ambient:true` starts `/api/heartbeat` (every `heartbeatMs`), `/api/poll`
  (reissuing long-poll, holds `pollHoldMs`), and periodic WS push (`wsPushMs`). Header counts them.
- **SSE** (s-19, act:25): `#start-sse` opens `/api/sse`, emits 5 events, then done. Body is `streaming`
  (not captured); read events from `#sse-log`.
- **Fake stream** (s-28, act:28): `/api/fake-stream` is mime `text/event-stream` but an ordinary XML body the
  client reads with `.text()`; disco captures it (`got 97 chars`). Do not treat mime as proof of a stream.
- **Canvas** (s-16, act:80): `#grid` is pixels only. A click maps to a cell and sets `window.__gridSelected =
  {r,c}`; read it via `evaluate` (no DOM/aria for cells).
- **Shadow DOM** (s-18, act:23): `#shadow-host >> button` reaches into the shadow root; increments "clicks: N".
- **Context menu** (s-24, act:14/15): right-click `#ctx-target` opens `role=menu` `#ctx-menu`; items
  `#ctx-open/#ctx-rename/#ctx-delete` set `#ctx-result` = "ctx: <Label>".
- **Double-click to edit** (s-25, act:13): `dblclick #dbl-target` → textbox, `#dbl-state` "editing";
  Enter/blur → "committed: <value>".
- **Drag** (s-26): slider `#slider-thumb` and reorder list `#sort-a/b/c` via `s.page.mouse` (scroll into view
  first); both `POST /api/drag-report`. `#slider-value` 0..100, `#sort-order` e.g. "b,c,a".
- **Iframes** (s-10, act:34/35): same-origin `{frame:"#same-origin"}`, nested `{frame:"#same-origin >> #nested2"}`
  (ids `#deep-name/#deep-submit`), cross-origin `#cross-origin` served from :4801 (submits to :4801).
- **Child window** (s-15, act:29/30): `#open-child` opens `/child.html` as a new page (`report.pages`); drive
  with `open({page:1})`; its button GETs `/api/child-ping`.
- **No-op / disabled** (s-13, act:9/10): `#noop` does nothing; `#noop-disabled` → `diagnosis disabled` in ~100 ms.

## 5. Interstitials and recovery

- **Allergy modal** (`#record-modal`, when ctl `modal`): appears on every record open, occludes the page.
  Handle optionally: `until: { any: [{ selector: nextScreen }, { selector: "#record-modal" }] }`, then
  `ackModalIfPresent`. `lib.ts` does this.
- **Session-timeout dialog** (`[role=dialog]` "Session expiring", `#stay`): appears once `timeoutMs > 0` and
  the idle timer expires (`#timeout-state`: off → armed → expired). Click `#stay` to dismiss.
- **Native dialogs** (s-11): `#confirm`/`#alert` and armed `beforeunload` (`#arm-unload` then `#nav-away`) are
  handled by the session `dialogs: "accept" | "dismiss"` and recorded in `report.dialogs`. With `dismiss`,
  confirm → "cancelled" and beforeunload cancels the navigation (page stays); with `accept`, confirm →
  "confirmed" and `#nav-away` proceeds to `/away.html`.
- **Auth expiry / gating:** a 302 to `/login.html?next=…`. Add `pathname==='/login.html'` as an arm of any
  secure-area anchor so a refusal costs milliseconds.
- **Recovery to the shell:** `goHome(s)` = `navigate("http://localhost:4800/")` + assert `#statusbar`.

## 6. Input recipes

- **Debounced search / combobox:** `s.type` (keystrokes), never `s.fill`. Wait on the request landing.
- **Combobox selection:** `press("ArrowDown", { target:"#med" })` until `#med-list li[aria-selected='true']`,
  then `press("Enter", { target:"#med" })` until `#med-selected:has-text("Selected")`.
- **Re-render race:** dispatch the click via `evaluate` (handler is delegated on `#rerender-host`).
- **Drag (slider/reorder):** `s.page.mouse.move/down/move/up` using `getBoundingClientRect` coords, **after**
  `element.scrollIntoView({block:'center'})`. Arm any `{request:"/api/drag-report"}` wait **before** `mouse.up()`.
- **Canvas:** click `#grid`, then read `window.__gridSelected` via `evaluate`.

## 7. Gotchas

1. **`/api/save/status` never "lands".** The client checks `Response.ok` and never reads the body, so
   `{request:"/api/save/status", landed:true}` waits forever (`body_state=pending`). Use the toast.
2. **`{url}` matches the whole href incl. query string.** On `login.html?next=/secure.html`, both
   `{url:"/secure.html"}` and `/secure\.html$/` are already true. Use `{fn:"location.pathname==='/secure.html'"}`.
3. **`:has-text('x')` is a case-sensitive substring.** "un**armed**" matches `has-text('armed')`; a lingering
   success toast matches `has-text('Saved')`. Clear stale UI (`until:{gone:...}`) and pick specific text.
4. **`#chart-status` stays "idle";** the Load Chart result goes into the `#chart` div. Aria `text:` lines also
   glue adjacent nodes ("status: idle Chart loaded (3 responses)") — don't infer which element changed from that.
5. **Poll notify is gated on `notify:true`;** ws/sse channels are standing from load, the poll one is not.
6. **The app is stateful across runs** (ctl knobs + the auth cookie persist in the browser profile). Reset
   ctl and clear cookies at the start of a workflow.
7. **Optimistic save + toast lifetime:** the toast auto-removes after `toastMs` (2000 ms); back-to-back saves
   can see the previous toast.

## 8. Open questions

- **`renderDelayMs` / `modalDelayMs`:** knobs exist; I set `modalDelayMs` implicitly at 0. Not exercised at a
  nonzero value. *Experiment:* `setCtl({modalDelayMs:800})`, open a record, time when `#record-modal` appears.
- **Idle-timer reset on activity:** does interacting reset `timeoutMs`? *Experiment:* arm `timeoutMs:2000`,
  click something at t≈1500 ms, see whether the dialog still fires at 2000 ms or slips.
- **`/api/xframe-submit` on :4801:** the cross-origin iframe posts to its own origin. I read its behavior from
  the served HTML but did not submit it. *Experiment:* fill `#xf-name` in `{frame:"#cross-origin"}` and click
  `#xf-submit`; whether disco captures a :4801 request depends on cross-origin frame recording.
- **`/api/sse` body:** captured only as `streaming`. Individual events are read from `#sse-log`, not the store.
- **WebSocket action frames as a postcondition:** each wired button sends `{type:"action",id}` and gets an
  `echo`. Could be used as a wire-first `until` via `ws_frames`, not attempted here.
