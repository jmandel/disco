# the gauntlet — navigation and quirks

## 0. Session contract

| | |
|---|---|
| **Target** | "the gauntlet" — a single-page app at `http://localhost:4800/`, served by `bun gauntlet` from this repo. One page, 26 numbered sections; a second origin `http://localhost:4801` serves exactly one cross-origin iframe. |
| **Roles / credentials** | None issued. Section 21 has an auth flow; I chose my own credentials and characterised what it accepts (§6). No role model exists — one anonymous user, optionally "logged in". |
| **Stance** | **Writes allowed** (synthetic, local, deterministic app). Every function nevertheless declares its write footprint (`lib.ts` header) and every write was verified on the wire, not on screen. |
| **Data posture** | Synthetic, local, deterministic. Nothing here is anyone's data. |
| **Done, for this pass** | Every section of the page mapped: what each control does on screen and on the wire, its settle profile, its postcondition; a variability ledger; `wire.md`; `lib.ts` with the flows most useful to automation (incl. a wire-verified write, a fact the DOM never shows, and an interstitial handled both ways); a green `check.ts`. |
| **Budget** | ≤30 minutes wall-clock. |
| **Not done** | Per-section exhaustive matrix of every `ctl` key combination; multi-tab interaction (the child window was opened and censused, never driven); `rerenderOnHover` measured only in its default-on state. See §10. |

Evidence: `apps/gauntlet/store/`, run 1, acts 1-63. Every claim below cites an act id, a body hash, or a
`disco sql` query. Screenshots in `screenshots/`.

## 1. Architecture

**SPA, no framework, no build step.** One document (`GET /`) plus `app.js` + `style.css`; every section
is server-agnostic DOM wired by hand. There is no client-side router: the four *other* pages this app can
put you on are real navigations (`/away.html`, `/login.html`, `/secure.html`, `/child.html`).

**Frames — four in one tab** (`disco targets`, act:31):

```
http://localhost:4800/                      (main)
├── http://localhost:4800/iframe.html       (same-origin island, section 10)
│   └── http://localhost:4800/iframe2.html  (depth-2, nested inside the first)
└── http://localhost:4801/xframe.html       (CROSS-ORIGIN island — its own target)
```
All three iframes are driveable with `{ frame: "iframe.html" | "iframe2.html" | "xframe.html" }`; disco
resolves the cross-origin one in its own target and translates the click coordinates (act:18/19/20).

**Standing channels open before you touch anything** (see `wire.md`): a WebSocket `ws://localhost:4800/ws`
and an `EventSource` on `/api/notify-sse`. The socket receives a `hello` frame carrying the full scenario
state, an `echo` frame for **every button click except `#noop`**, a `ctl` frame on every scenario change,
and `push` frames for section 23.

**The control channel is the app's most important endpoint.** `GET/POST /ctl` reads and patches a
scenario object (full body in `wire.md`). *Every* hostile behaviour in this app is a key in it and is off
or zero at boot: `modal`, `renderDelayMs`, `saveFails`, `ambient`, `timeoutMs`, `requireAuth`, `notify`.
**Read `GET /ctl` first** — one request tells you which traps are armed. The app documents the channel in
its own copy (section 23: `POST /ctl {"push":"ws"|"sse"|"poll"}`), so using it is characterising the
product, not cheating around it. It is a **write**: it changes behaviour globally for every open tab.

**Auth** — cookie-based, `HttpOnly` (`document.cookie` is empty after login, act:41). Off by default;
`ctl.requireAuth` turns `GET /secure.html` into a `302 → /login.html?next=/secure.html` (act:38).

**No third-party anything.** No telemetry, no analytics, no CDN, no bot challenge. Every byte is local.

## 2. Ambient traffic and the classifier overrides

At rest the app is **silent**: `ctl.ambient` is `false` at boot, so a session that never flips it observes
zero periodic traffic. The 95s idle observation I started at instrument time therefore learned nothing —
correct, and worth stating, because it means *"the classifier is empty" is the right answer here, not a
warm-up failure.*

With `ambient:true`, a 26s idle observation classified three families (`disco idle 26000` →
"33 families, 3 ambient"):

| family | evidence | cadence |
|---|---|---|
| `GET /api/heartbeat` | ×5, periodic | `ctl.heartbeatMs` = 5000 |
| `GET /api/poll` | ×9, periodic | long-poll held `ctl.pollHoldMs` = 3000, re-issued |
| `GET /api/notify-sse` | ×4, periodic | EventSource reconnect loop |

The classifier got this **right** with no override needed — with ambient running, `click #load-chart`
still settled cleanly at 545ms with only its own three requests attributed (act:46). Two overrides are
nonetheless registered in `lib.ts::registerRules` (`s.ignore("/api/heartbeat" | "/api/poll" |
"/api/notify-sse")`) as *promoted conclusions*, so a fresh run confirms rather than re-learns; they cost
nothing when ambient is off. **Deliberately not ignored:** `GET /api/sse` — same shape, but it is the
*result* of clicking `#start-sse` and must stay attributed. `GET /favicon.ico` was eyed by the classifier
(gaps 20s/14s/18s, cv 1.58 — rejected) and is left alone: it only fires on navigation. No sentinel mutes
were needed; every sentinel that fired was real (§7).

## 3. Anchors

| anchor | cheap predicate | notes |
|---|---|---|
| **shell** | `#load-chart` visible | the app proper; `lib.ts::assertShell` |
| **away** | `text=You navigated away` + url `/away.html` | reached by `#nav-away`; recover with `home()` |
| **login** | `#login` visible + url `/login.html?next=…` | only when `ctl.requireAuth` |
| **secure** | body matches `/Secure area/` + url `/secure.html` | |
| **child window** | a second target at `/child.html` | separate target, never becomes primary |
| **blocked: record modal** | `#record-modal` visible | occludes everything; ack `#modal-ack` |
| **blocked: session expiry** | `#session-timeout` visible | occludes everything; dismiss `#stay` |

The two blocked "anchors" are not places you navigate to — they are states the app drops on top of
wherever you are, and until they are cleared *every* act returns `diagnosis: occluded` (act:33, act:48,
act:55). `home()` clears both on the way in.

## 4. Transitions — every interactive surface

Settle figures are `settle.ms` / `settle.reportedMs` from the cited act. "Postcondition" is what
`lib.ts` passes as `until`. The full distribution is `bun scripts/timing-report.ts gauntlet`.

| § | action | verdict | settle / reported | wire signature | postcondition | act |
|---|---|---|---|---|---|---|
| 1 | click `#load-chart` | `settled:network` | 459 / 782 | `GET /api/slow` (404ms) + `/api/chart/a` + `/api/chart/b` | `#chart-status === "idle"` | act:1, act:2 |
| 1 | …with `renderDelayMs:900` | `settled:network` | **415 / 734 — screen still says "loading…"** | same three | same; matched at 618ms *after* settlement | act:35, act:36 |
| 2 | click `#record-N` | `settled:network` | 135 / 435 | `GET /api/record/N` | wire landed **and** `#record >> text=Record N` | act:8 |
| 2 | …with `modal:true` | `settled:network` | 115 / 430 | same | same — **then** the overlay arrives 400ms later | act:32 |
| 2 | click `#modal-ack` | `settled:visual` | 98 / 402 | none | `#record-modal` gone | act:34 |
| 3 | click `#save` | `settled:network` | 136 / 450 | `POST /api/save` → 202, then `GET /api/save/status` ~1.8s later | `{urlLike:"/api/save/status", landed:true}` | act:4, act:37 |
| 4 | (perpetual spinner) | — | — | none | never settles on pixels alone; the visual ignore-mask absorbs it (repeat `#noop` still reports `no-effect` at 499ms, act:63) | act:3/63 |
| 5/22 | ambient | — | — | heartbeat + long-poll + WS push | not an action | §2 |
| 6 | (WebSocket) | — | — | one `echo` frame per button click except `#noop` | not an action | act:1.. |
| 7 | `fill #search` | `settled:network` | 347 / 668 | **one** `GET /api/search?q=ad` for two keystrokes (250ms trailing debounce) | `{urlLike:"/api/search?q=<term>", landed:true}` | act:9 |
| 8 | click `#load-rows` | `settled:network` | 157 / 476 | `GET /api/rows` — 10,000 rows | wire landed **and** `#rows-count` matches `/\d+ rows/` | act:6 |
| 9 | click `#rerender` | `settled:dom` | 35 / 335 | none | `#rerender-count` incremented | act:7 |
| 10 | click in `iframe.html` | `settled:network` | 79 / 379 | `POST /api/iframe-submit` | frame-scoped selector | act:18 |
| 10 | click in `iframe2.html` (depth 2) | `settled:network` | 62 / 362 | `POST /api/iframe-submit` | frame-scoped | act:19 |
| 10 | click in `xframe.html` (**:4801**) | `settled:network` | 27 / 327 | `POST /api/xframe-submit` on :4801 | frame-scoped | act:20 |
| 11 | click `#confirm` / `#alert` | **`dialog`** | 9 / 9, 35 / 35 | none | `#confirm-result`/`#alert-result` text | act:26, act:27 |
| 11 | click `#arm-unload` | `settled:dom` | 29 / 329 | none | `#unload-armed === "armed"` | act:28 |
| 11 | click `#nav-away` armed | **`dialog`** then navigated | 5 / 5 | `GET /away.html` | url is `/away.html` | act:30 |
| 12 | (session expiry fires) | — | — | none | `#session-timeout` visible | act:48 |
| 12 | click `#stay` | `settled:visual` | 81 / 380 | none | `#session-timeout` gone | act:52 |
| 13 | click `#noop` | **`no-effect`** | 0 / 499 | none | there is none — this is the control | act:3, act:63 |
| 14 | click `#delete` | `settled:network` | 167 / 467 | `DELETE /api/item/1` | wire landed **and** `#delete-result` says "deleted" | act:5 |
| 15 | click `#open-child` | **`new-target`** | 47 / 47 | none in the parent | a target at `/child.html` appears | act:29 |
| 16 | click `#grid` (canvas) | `settled:visual` | 48 / 348 | **none** | there is none — read `/api/grid` instead | act:17 |
| 17 | `type #med` | `settled:network` | 78 / 378 | **two** `GET /api/meds` for two keystrokes (NOT debounced) | options rendered + wire landed | act:10 |
| 17 | `press ArrowDown` | `settled:visual` | 21 / 320 | none | `#med-opt-<i>[aria-selected="true"]` | act:11 |
| 17 | `press Enter` | `settled:visual` | 32 / 332 | none | `#med-selected` matches `/^Selected: /` | act:12 |
| 18 | click shadow button | `settled:dom` | 23 / 322 | none | shadow text updates | act:16 |
| 19 | click `#start-sse` | `settled:network` | 550 / 850 | `GET /api/sse` (**streaming, body never captured**) | `#sse-log li` count ≥ n | act:23 |
| 20 | click `#gql-query` | `settled:network` | 75 / 375 | `POST /api/graphql`, `write_kind=read` | `{urlLike:"/api/graphql", landed:true}` | act:21 |
| 20 | click `#gql-mutate` | `settled:network` | 41 / 342 | `POST /api/graphql`, `write_kind=write` | same | act:22 |
| 21 | click `#go-secure` (auth on) | **`navigated`** | 70 / 370 | `GET /secure.html` → **302** → `GET /login.html` | `any[#login, /Secure area/]` | act:38 |
| 21 | click `#login` | `still-active` → navigated | 1009 / 1009 | `POST /api/login`, then `GET /secure.html` | `any[/Secure area/, #login-error]` | act:41 |
| 23 | push (ws/sse/poll) | — | — | nothing in `requests` — the result rides the standing channel | `#notif-list` grew | §7 |
| 24 | `rightclick #ctx-target` | `settled:visual` | 47 / 347 | none | `#ctx-menu` visible (positioned absolutely at the cursor) | act:13 |
| 24 | click `#ctx-rename` | `settled:visual` | 44 / 344 | none | `#ctx-result === "ctx: Rename"` | act:14 |
| 25 | `dblclick #dbl-target` | `settled:visual` | 49 / 348 | none | `#dbl-input` exists, `#dbl-state === "editing"` | act:15 |
| 26 | `drag #slider-thumb {dx:120}` | `settled:network` | **1474 / 1773** | `POST /api/drag-report` (body unread) | `#slider-value` changed | act:24 |
| 26 | `drag #sort-a → #sort-c` | `settled:network` | **1440 / 1740** | `POST /api/drag-report` | `#sort-order` changed | act:25 |

**Settle profile in one line:** almost everything in this app settles in 20-170ms and *reports* at
320-500ms (quiet tail Q=300 dominates). The four exceptions are Load Chart (~450ms, gated by
`/api/slow`), SSE start (550ms), login (~1s), and **drag (~1450ms)** — the drag is slow because the
synthetic mouse-move steps *are* the page activity, not because the app is slow.

## 5. Interstitials, and how to handle each

| interstitial | trigger | selector | handling |
|---|---|---|---|
| **"Allergy Review Required"** | `ctl.modal`; appears `modalDelayMs` (400ms) **after** the opening click settles | `#record-modal` / `#modal-ack` | `actIfPresent(s, "#modal-ack", { budgetMs: 900 })` **after** the record's own postcondition. Looking for it before settlement finds nothing; assuming it will never come loses the next click to `diagnosis: occluded` (act:33). `screenshots/02-record-modal.jpg` |
| **"Session expiring"** | `ctl.timeoutMs` elapses (idle timer) | `#session-timeout` / `#stay` | `actIfPresent(s, "#stay")`. Setting `timeoutMs:0` clears the *state text* but **leaves the overlay standing** (act:51 was still occluded after the reset) — you must click it away. `screenshots/03-session-expiry.jpg` |
| **login page** | `ctl.requireAuth` + no cookie; a 302 on `GET /secure.html` | `#login` | a whole-page interstitial. `openSecureArea` waits for `any[#login, /Secure area/]` and only fills the form on the first arm (act:38, act:41) |
| **`confirm` / `alert`** | `#confirm`, `#alert` | native | auto-accepted by session policy; verdict is `dialog`, recorded in `env.dialogs` (act:26, act:27) |
| **`beforeunload`** | `#arm-unload` then any navigation | native | auto-accepted → the navigation **proceeds** to `/away.html` (act:30). If you need to *not* leave, don't arm it |
| **toasts** | save (2s, `ctl.toastMs`) | `role=status` | sentinel-caught (`toast: "Saved"` act:4; `toast: "Save failed (async)"` act:37). Never wait on one — read the wire |

## 6. Auth

`ctl.requireAuth:true` → `GET /secure.html` answers `302 → /login.html?next=/secure.html` (act:38). The
form is `#user` / `#pass` / `#login` and posts `POST /api/login`.

**What it accepts (probed, act:41 and a direct fetch):** *any non-empty user/pass pair*. `nobody`/`wrong`
logged in and the secure page rendered "Welcome, nobody". Empty either side → `401 {"ok":false,
"error":"user and pass required"}`. There is no password to guess and no lockout to characterise. The
session cookie is `HttpOnly` — `document.cookie` returns `""` after a successful login. No expiry
observed on the cookie itself; section 12's timeout is a *client-side* idle overlay, unrelated.

## 7. Keyboard recipes (verbatim)

**Section 17 combobox — genuinely keyboard-only.** A mouse click on a rendered option comes back
`diagnosis: occluded by <section id="s-17">` (act:55) — the options are painted but not hit-testable.
The working recipe, verified act:57-60:

```
fill  #med  ""                      # clear
type  #med  "as"                    # ONE /api/meds request PER KEYSTROKE (no debounce)
press ArrowDown                     # -> #med-opt-0[aria-selected="true"]
press ArrowDown                     # -> #med-opt-1[aria-selected="true"]
press Enter                         # -> #med-selected === "Selected: Aspirin"
```
Contrast section 7's `#search`, which *is* debounced (250ms trailing): two keystrokes produced exactly
one `GET /api/search?q=ad` — the response body echoes `q`, which is how you prove the coalescing.

**Section 8's virtualized list.** `s.scroll({ target: "#rows", deltaY })` scrolls the *page* unless the
pointer is already over the container — the first attempt left `#rows.scrollTop === 0` while
`window.scrollY` went to 2554. `hover("#rows")` first, then scroll, and the wheel lands inside
(scrollTop 122000). Better still: don't scroll at all, read `/api/rows`.

## 8. Recovery

- `home(s)` — clears both overlays, then navigates to `/` if `#load-chart` is absent. Idempotent.
- Stuck on `/away.html`, `/secure.html`, `/login.html`, or behind either overlay → `home(s)` fixes all five.
- A scenario left armed is the one thing `home()` cannot fix: `setScenario(s, BOOT)` (the boot object is
  in `check.ts`) restores it. **A check or probe that arms `modal`/`saveFails`/`timeoutMs` and dies leaves
  the app hostile for the next session** — `check.ts` restores it in a `finally`.
- The child window (`/child.html`) is a separate target and never steals `primary`; nothing needs to
  close it, but `disco targets` will keep listing it.

## 9. The failure-mode checklist (GUIDANCE §8)

| item | verdict | evidence |
|---|---|---|
| Conditional interstitials | **PRESENT** — two, both delayed and both fully occluding | act:32/33 (record modal), act:48 (expiry) |
| Toasts / transient banners | **PRESENT** — 2s (`ctl.toastMs`); the *only* on-screen sign of an async save failure | act:4, act:37, `screenshots/04,05` |
| Spinners that lie | **PRESENT** — section 4's perpetual spinner (absorbed by the visual ignore mask: `#noop` still reports `no-effect` at 499ms, act:63) **and** the inverse: `renderDelayMs` makes the screen say "loading…" 900ms after the network went quiet (act:35) | act:35, act:63 |
| Re-render races | **PRESENT** — section 9, `ctl.rerenderOnHover:true` rebuilds the button on hover; disco resolves late and dispatches immediately, so the click still counted (act:7, `settled:dom`, count 0→1). No `detachedRetried` was needed in 1 trial | act:7 |
| Virtualized lists | **PRESENT** — 10,000 rows on the wire, 23-28 recycled `.row` nodes over a 240,000px spacer; row 4995 appears in the same nodes at scrollTop 120000 | act:6 + evaluate probe |
| Iframes / cross-origin islands | **PRESENT** — 3 iframes, one nested to depth 2, one cross-origin on :4801, all driveable frame-scoped | act:18/19/20 |
| Shadow DOM | **PRESENT** — `#shadow-host` with an open root; the shadow-piercing selector `#shadow-host >> css=button` works | act:16 |
| Canvas | **PRESENT** — section 16 is pixels only; a click leaves no DOM trace and fires no request. Contents are wire-available at `/api/grid` | act:17 |
| Focus traps / keyboard-only widgets | **PRESENT** — section 17; recipe in §7 | act:55 (click refused), act:57-60 (keys work) |
| Debounced / async-validated inputs | **PRESENT** — `#search` debounced 250ms trailing; `#med` deliberately *not* debounced (one XHR per keystroke). Both in one app, as the contrast | act:9 vs act:10 |
| Session expiry + keepalive | **PRESENT** — `ctl.timeoutMs` idle timer → `#session-timeout` overlay + a `session_expiry` sentinel. `ctl.heartbeatMs` is the keepalive | act:48 |
| Multi-window flows | **PRESENT (censused, not driven)** — `#open-child` yields verdict `new-target` and a second target at `/child.html` | act:29 |
| Reads over POST | **PRESENT** — `POST /api/graphql` with a `query` operation is `write_kind=read`; the same URL with a `mutation` is `write`. The daemon's body peek got both right with no manual marking | act:21 / act:22 |
| Optimistic UI | **PRESENT, and the sharpest trap here** — `#save-state` reads "Saved ✓" *permanently* even when `GET /api/save/status` returns 500. Only the wire and a 2s toast disagree | act:37 |
| Native dialogs / `beforeunload` | **PRESENT** — `confirm`, `alert`, and a real `beforeunload`; all auto-accepted by policy, all recorded, verdict `dialog` | act:26, act:27, act:30 |
| Standing channels (WS/SSE/long-poll) | **PRESENT — all three, and they deliver results, not just heartbeats.** Section 23 pushes the answer down whichever channel you ask for | §7 of `wire.md`, act:23 |
| Third-party telemetry | **ABSENT** — no external host is contacted at all | `SELECT DISTINCT host FROM requests` → only :4800 and :4801 |
| Bot challenges | **ABSENT** — headless Chromium is served the app directly | act:1 onward |
| Cold-load hydration races | **UNOBSERVED** — handlers are attached synchronously in `app.js`; no swallowed first keystroke seen in ~15 fills/types | — |

## 10. Open questions

1. **`rerenderOnHover`** is on by default but I never observed a *failed* dispatch from it (n=1, act:7).
   Probe: set `renderDelayMs` high and click `#rerender` repeatedly, looking for `target.detachedRetried`.
2. **The child window is unexplored.** Probe: `s.focusTarget(<child id>)`, census its DOM and wire, and
   check whether it shares the session cookie and the WS.
3. **`toastMs` vs. sentinel capture.** At the default 2000ms the toast sentinel always fired (n=2).
   Probe: `toastMs:150` — does the screencast still catch it?
4. **Long-poll push latency.** `push:"poll"` answered in 3ms because a poll was already in flight.
   Probe: with `ambient:false`, is there a poll to answer at all, or does it wait `notifyPollHoldMs`?
5. **Whether `/api/save/status` is per-save.** `POST /api/save` returns `{"id":1,…}` both times; the
   status endpoint takes no id. Probe: two saves in flight at once.
6. **`slowMs` extremes.** Everything here was measured at `slowMs:400`. Probe: `slowMs:20000` against
   `maxBudgetMs` (20s) — does Load Chart report `still-active` and then `settled:late`?

## 11. Measured settle profile (`bun scripts/timing-report.ts gauntlet`, 66 actions, run 1)

```
verdict               n  settle_ms                    wait_ms (page)               overhead_ms (daemon)
settled:network      26  p50 136  p90 550  max 1474   p50 467  p90 1740  max 2122  p50 24  p90 45  max 99
settled:visual       17  p50 46   p90 57   max 98     p50 346  p90 357   max 402   p50 19  p90 23  max 24
diagnosis             7  p50 0    p90 0    max 0      p50 0    p90 0     max 0     p50 0   p90 0   max 0
settled:dom           5  p50 30   p90 35   max 41     p50 329  p90 335   max 350   p50 21  p90 21  max 24
no-effect             3  p50 0    p90 0    max 0      p50 500  p90 500   max 500   p50 23  p90 23  max 23
dialog                3  p50 9    p90 9    max 35     p50 21   p90 21    max 39    p50 31  p90 31  max 117
navigated             3  p50 135  p90 135  max 152    p50 452  p90 452   max 455   p50 16  p90 16  max 42
new-target            1  p50 47   p90 47   max 47     p50 50   p90 50    max 50    p50 30  p90 30  max 30
still-active          1  p50 1009 p90 1009 max 1009   p50 1009 p90 1009  max 1009  p50 35  p90 35  max 35

until: 17 actions, matched 17; elapsed p50 86  p90 1094  max 1809
overhead share: 4% of total act() time is daemon work
```

Reads as documented in §4: the median action settles in ~136ms (network) or ~46ms (visual) and reports
one quiet tail later. The `until` p90 of 1094ms and max of 1809ms are the two traps this app is built
around — the render that lags the wire (`renderDelayMs`) and the save confirmation that arrives 1.8s
after the click. **Both are invisible to the verdict and only `until` catches them**; the 7 `diagnosis`
rows are the occlusion probes (acts 33, 44, 48, 51, 53, 54, 55), all deliberate.

`run-check` result (second run, after the two fixes the first run found): **25/25 PASS, `gauntlet: OK`**.
