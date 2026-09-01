# gauntlet

A deterministic, single-page "hostile" web app used to exercise a browser-driving tool. One
HTML shell at `http://localhost:4800/` numbers ~25 independent sections, each demonstrating one
tricky UI/loading behaviour. This folder characterises every section so a human can understand
it and `lib.ts` + `check.ts` can drive it.

> Start it: `bun gauntlet/server.ts --port 4800` (prints the main origin and an `x-origin` on
> :4801). `--port 4810` if 4800 is busy.

## What it is

- **Architecture:** SPA. One document (`/`), one script (`/app.js`), all state fetched as JSON
  over `fetch`/`XHR`, plus a WebSocket (`/ws`), two SSE streams, and long-poll endpoints. There
  is no client router — everything is on one page; "navigation" means `/login.html`,
  `/secure.html`, `/away.html`, `/child.html`, or the two iframes.
- **Auth:** cookie `gauntlet_auth=<user>` (HttpOnly), set by `POST /api/login` which accepts
  **any** credentials. `/secure.html` (always) and `/` (only when `ctl.requireAuth`) 302→
  `/login.html?next=…` without the cookie.
- **Where facts live:** on the wire. Lists, records, search hits, save outcomes and drag results
  all travel as JSON; several are never rendered verbatim (the 10k rows are windowed; the grid is
  canvas pixels; save/drag bodies are never read by the page). Read `s.store`, not the DOM.
- **Control plane:** the app's difficulty is tuned live by `POST /ctl` (a JSON knob bag) and
  reset by `POST /ctl/reset`. These are test hooks, not app UI. See `wire.md` for the knobs.

## Glossary (the app's nouns)

| Term | On screen | On the wire |
|---|---|---|
| **ctl / knobs** | header `effective ctl:` line | `GET/POST /ctl`; `{slowMs, modal, saveFails, ambient, timeoutMs, requireAuth, notify, …}` |
| **record** | section 2, `#record` fills with `<li>k: v</li>` | `GET /api/record/{n}` → `{id,name,dob,mrn,allergies[]}` |
| **allergy modal** | "Allergy Review Required" overlay | client-only; shown after a record when `ctl.modal` |
| **toast** | bottom-right `#toast` | client-only; kind `ok`/`fail` from `/api/save/status` code |
| **row** | section 8, `.row` divs | `GET /api/rows` (10k); only a window is mounted |
| **med / option** | section 17 combobox `#med-list li[role=option]` | `GET /api/meds?q=` |
| **notification** | section 23 `#notif-list`, `#notif-count` | pushed via WS/SSE/poll on `POST /ctl {push}` |
| **ambient** | header `heartbeats N / polls N` | `GET /api/heartbeat`, `GET /api/poll` when `ctl.ambient` |
| **x-origin** | header `x-origin:` | `state.xOrigin` (`http://localhost:4801`), source of the cross iframe |

## Anchors (cheap "where am I" assertions)

| Screen | URL | Element |
|---|---|---|
| Shell (main app) | `/` | `#load-chart` exists; `#ws-status` reads `open` |
| Login | `/login.html` | `#login` button |
| Secure area | `/secure.html` | `#who` ("Welcome, …") |
| Navigated away | `/away.html` | heading "You navigated away" |
| Child window | `/child.html` (separate page) | `#child-fetch` |
| Allergy modal up | `/` | `#record-modal` (role=dialog) |
| Session-timeout up | `/` | `#session-timeout` (role=dialog) |

`gotoShell(s)` navigates to `/` and waits for `#ws-status` = `open` — **do this at the start of a
session** so the WebSocket handshake happens inside your recording window (it opens at page load).

## Workflows

Each is a function in `lib.ts` (anchor in → anchor out, an `until` per transition, wire-first
reads). Act ids below are the evidence from the discovery run (`store/store.sqlite`).

1. **Load Chart — 3 concurrent fetches, one slow** · `loadChart` · act:2
   `click #load-chart` → `until {selector:'#chart:has-text("Chart loaded")'}` (or
   `{request:'/api/slow',landed:true}`). `GET /api/slow?ms=<slowMs>` races `/api/chart/a` & `/b`
   via `Promise.all`; status span goes `loading…`→`idle`. Varies: `ctl.slowMs`, `ctl.renderDelayMs`.

2. **Records + conditional allergy modal** · `openRecord` · act:39–42
   `click #record-N` → `until {any:[#record h3:text-is("Record N"), #record-modal]}`. Read from
   `GET /api/record/N`. When `ctl.modal`, an overlay appears (after `modalDelayMs`) and **occludes
   the record buttons**; `#modal-ack` dismisses it. Handle it both ways.

3. **Save — optimistic UI, async outcome** · `save` · act:3, act:43–44
   `click #save` shows `Saved ✓` instantly; `POST /api/save` (202) then, ~500 ms later,
   `GET /api/save/status?id` returns **200** or **500** (`ctl.saveFails`). Wait
   `{request:'/api/save/status'}` and read the **status code** — the body is `missing`. A toast
   `#toast[data-kind=ok|fail]` also renders.

7. **Debounced search** · `search` · act:12–13
   `fill`/`type #search` → `until {request:'/api/search',landed:true}`. 250 ms trailing XHR;
   empty query issues nothing. Hits from `GET /api/search?q=`.

8. **Virtualized rows** · `loadRows` · act:14
   `click #load-rows` → `until {request:'/api/rows',landed:true}`. 10,000 rows on the wire, only
   ~23 `.row` nodes in the DOM. **Assert against the wire list, not the DOM.**

9. **Re-render race** · `clickRerender` · act:15–16, act:75
   `#rerender` is replaced every 100 ms and on mousemove (`ctl.rerenderOnHover`). A real mouse
   click → `diagnosis: detached`. Recipe: set `ctl.rerenderOnHover:false` then normal click (or
   `js:true`); `until` on `#rerender-count` incrementing.

10. **Iframes** · `submitIframe` / `submitNestedIframe` / `submitCrossIframe` · act:30–35
    `frame:"#same-origin"`, nested `frame:"#same-origin >> #nested2"`, cross `frame:"#cross-origin"`.
    Submits → `POST /api/iframe-submit` (`{depth:2}` for nested) / `/api/xframe-submit` (:4801).

11. **Dialogs (confirm / alert / beforeunload)** · act:37–38, act:77
    `#confirm`→`confirm()`, `#alert`→`alert()`, `#arm-unload` then `#nav-away`→`beforeunload`.
    disco's default `dialogs:"accept"` auto-accepts all three; the report lists each under
    `dialogs`. With accept, beforeunload lets navigation proceed to `/away.html`.

12. **Session timeout** · act:61–62
    `ctl.timeoutMs>0` arms an idle timer → `#session-timeout` dialog after `timeoutMs`; `#stay`
    re-arms it. Any click/keydown/mousemove resets the timer.

13. **No-op & disabled** · act:4–5
    `#noop` does nothing (no wire, no WS). `#noop-disabled` → `diagnosis: disabled` in ~100 ms;
    it sits inside `.field-wrap`, its hit-test parent.

14. **Delete (write endpoint)** · `deleteItem` · act:6
    `click #delete` → `until {request:'/api/item/1',landed:true}`; `DELETE /api/item/1`→`{deleted:1}`.

15. **Child window** · act:36, act:79
    `#open-child` → `window.open('/child.html')`. Appears as `report.pages` / `s.context.pages()`.
    Drive its `#child-fetch` (→ `GET /api/child-ping`) via the Playwright `Page` directly.
    **Close it when done** (see Gotchas — a lingering child throttles the main page).

16. **Canvas grid** · `selectGridCell` · act:27
    `click #grid` → `until {fn:'window.__gridSelected !== null'}`; read `window.__gridSelected`
    `{r,c}`. No per-cell DOM — pixels only.

17. **Keyboard-only combobox** · `pickMed` · act:17–20
    `type #med` → `until {request:'/api/meds',landed:true}`; `press ArrowDown` (target `#med`,
    `until li[aria-selected="true"]`); `press Enter` (`until #med-selected:has-text("Selected")`).
    **Mouse clicks on options are ignored** (mousedown `preventDefault`) → `occluded`. See Input recipes.

18. **Shadow DOM** · `clickShadowButton` · act:21
    `#shadow-host` has an open shadow root; reach the button with `#shadow-host >> #shadow-btn`.

19. **Server-sent events** · `runSse` · act:52
    `click #start-sse` → `until {selector:'#sse-status:text-is("done")'}`. `GET /api/sse` emits 5
    events ~500 ms apart then closes; each lands in `#sse-log`. Response body is `missing`.

20. **GraphQL over POST** · `gqlQuery` / `gqlMutate` · act:7
    `#gql-query`/`#gql-mutate` → `POST /api/graphql`. Query→`{data:{patient:{name:"Ada Lovelace"}}}`;
    mutation echoes the name (`sawMutation:true`) but does **not** persist.

21. **Auth** · `login` · act:64–73
    `GET /secure.html` (and `/` when `requireAuth`) 302→`/login.html?next=`. `POST /api/login`
    accepts anything, sets `gauntlet_auth=<user>`; then `location.href=next`. Wait on the
    destination landmark (`#who` / `#load-chart`), **not** `{url:"/…"}` (substring, often already true).

23. **Push channels** · `pushNotification` · act:54–57
    `POST /ctl {push:"ws"|"sse"|"poll"}` injects one notification; `until` on `#notif-count`.
    ws & sse deliver immediately; **poll only when `ctl.notify=true`** (the client runs the
    notify-poll loop then, held up to `notifyPollHoldMs`).

24. **Context menu** · `contextMenuAction` · act:22–23
    `rightclick #ctx-target` → `until {selector:'#ctx-menu',visible:true}`; click a menuitem with
    **`js:true`** (the menu is `position:fixed` at the pointer Y and its handler is delegated).

25. **Double-click to edit** · `editInline` · act:24–26
    `dblclick #dbl-target` → `#dbl-input` ("editing"); `fill`; `press Enter` → "committed: …".
    A single click (after 250 ms) instead sets "selected".

26. **Drags (slider + reorder)** · `dragSlider` / `reorder` · act:28–29
    `drag #slider-thumb → #slider-track` lands ~mid (value 50), `POST /api/drag-report`.
    `drag #sort-a → #sort-c` reorders `#sort-list`, `POST /api/drag-report`.

28. **Fake stream** · act:8
    `#load-fake-stream` → `GET /api/fake-stream`: mime `text/event-stream` but a **finite ordinary
    body** (XML). Captured fine (`.text()`), unlike the real SSE. A "spinner that lies" in reverse.

5/22. **Ambient traffic** · act:58–60
    `ctl.ambient:true` starts a heartbeat (`/api/heartbeat` every `heartbeatMs`) and a reissuing
    long-poll (`/api/poll`, held `pollHoldMs`); header counters advance. These fire on their own —
    you'll see them in reports with `action_id IS NULL`.

## Interstitials and recovery

- **Allergy modal** (`#record-modal`): appears after opening a record only when `ctl.modal`. It
  occludes the record buttons. `openRecord` handles + dismisses it either way.
- **Session-timeout modal** (`#session-timeout`): appears after `ctl.timeoutMs` idle; `#stay`
  dismisses. Any input resets the timer, so acting on the page can prevent it.
- **Login redirect**: any anchor may 302 to `/login.html` when `requireAuth`. Add `#login` as an
  `any` arm to your shell anchor if you exercise auth, so a refusal costs milliseconds.
- **Recovery from anywhere:** `gotoShell(s)` = `navigate("/")` + wait `#ws-status`=`open`. Every
  workflow starts with `assertShell(s)` (a 1.5 s `until #load-chart`).

## Input recipes

- **Keyboard combobox (#med):** `type` (keystrokes, *not* `fill` — it needs `input` per key and
  the debounce/seq guard). Then `ArrowDown` per step until `#med-opt-i[aria-selected="true"]`,
  then `Enter` until `#med-selected:has-text("Selected")`. Never mouse-click an option.
- **Re-render button (#rerender):** `js:true`, or turn off `ctl.rerenderOnHover` first. Predicate
  on `#rerender-count` reaching `before+1` (not a bare "a number").
- **Context menuitem:** `js:true` (fixed-position menu + delegated handler).
- **Slider / reorder:** `s.drag(target, to)`; wait on `POST /api/drag-report` landing.
- **Iframe fields:** pass `frame:` on both the `fill` and the `click`; chain with `>>` for depth.

## Gotchas

- **Bodies the page never reads are `missing`:** `/api/save/status`, `/api/drag-report`, and the
  real `/api/sse` have no captured body. Use the **status code** (save) or the rendered effect.
- **`{url:"/…"}` is a substring test** — `/`, or `/secure.html` while still on `login.html?next=/secure.html`,
  are already true. Wait on a **destination element**, not the URL, for these transitions.
- **Virtualized DOM lies about counts** — the list has 10k rows; the DOM has ~23. Trust `/api/rows`.
- **Canvas has no accessible tree** — assert on `window.__gridSelected`, not `ui`.
- **The perpetual spinner (`#spinner`) never goes `gone`** and has no request. Never wait on it.
- **rAF throttling:** a backgrounded/covered child window (or the main page losing foreground)
  throttles `requestAnimationFrame` to ~1 s, so clicks take ~3 s (act:45–51). Close the child
  window / `s.page.bringToFront()` to restore ~100 ms clicks.
- **WS opens at load:** to capture `/ws` frames, `navigate` to `/` inside your own session first.
- **Selector substrings:** `:has-text("X")` is a case-sensitive substring; use `:text-is("X")`
  for exact status text (e.g. `#ws-status:text-is("open")`, `#ambient-status:text-is("on")`).

## Open questions

- **`ctl.wsPushMs` / periodic WS push:** documented as a standing 7 s WS push but not isolated
  here; the discovery run only saw hello/echo/ctl/notify frames. Experiment: idle on `/` with a
  `record` session for >7 s and inspect `ws_frames` for an unsolicited push.
- **`renderDelayMs`:** only inferred from `app.js` (a post-fetch delay before the chart text
  renders); not exercised. Set it high and confirm `#chart` lags the wire.
- **Long-poll hold semantics** (`pollHoldMs`, `notifyPollHoldMs`): confirmed they hold, not the
  exact release conditions (timeout vs. server event). Would need paired `push` + timing.
- **GraphQL persistence:** `rename` does not persist across requests here; unclear if any knob
  makes it stateful.
