# disco

Drive a web app you have never seen, keep every wait short and named, and leave behind a folder that
explains the app. disco is three small things:

- **Playwright, unwrapped** — its selectors, its input, its actionability checks, reached through
  `connectOverCDP`, so it works on a browser disco launched *or a browser that is already running*.
- **A log** — every request, response body, WebSocket frame, console line, dialog, navigation and
  action goes into one SQLite file per app. You read it with SQL or a few helpers; there is no API in
  front of it.
- **A folder convention** — `apps/<app>/` holds what you learned: a README a human can read, notes,
  the endpoint map, the code that drives the app, and the check that proves the code still works.

One wrapper, `act`, ties the first two together: *do the thing, optionally wait for the state you asked
for, and return what happened*. There is no "settled" verdict to interpret. You name what you are
waiting for, or you get the next 700 ms.

---

## The promise

| Situation | What you get | How long it takes |
|---|---|---|
| The element is not there | `diagnosis: not-found` + the visible controls on the page + a screenshot | ≤ 1 s |
| It is there but disabled, hidden, or covered | `diagnosis: disabled / hidden / occluded` naming what covers it and which dialogs are open | ~100 ms |
| You act without naming a postcondition | the aria diff, the requests, the console and dialogs of the next 700 ms | 700 ms |
| You act with `until` | the same report, returned the moment the state arrives | as long as the app takes |
| The state never arrives | `until.ok: false` after *your* budget (default 5 s), with a diagnosis and a screenshot | your budget |
| Your predicate was already true before you acted | `until.alreadyTrue: true` — flagged, so you notice | 0 |
| The page never read a response body | the row says `missing — body not read by the page`; the status is still there | 1.5 s after the headers |
| The app did something you did not ask about | it is in the log with a timestamp; the report shows the parts inside the window | — |

No wait is longer than the number you wrote. Nothing in disco sleeps for you. Nothing in disco guesses
whether the page is "done".

---

## Install and run

Requirements: **Node ≥ 24** (TypeScript runs natively) and a Chromium/Chrome binary (`/usr/bin/chromium`
is found automatically; otherwise `DISCO_CHROMIUM=/path/to/chrome`). Bun is needed only for the gauntlet
test app.

```sh
npm install                 # (or bun install) — playwright-core is the only runtime dependency
./disco open gauntlet http://localhost:4800     # launch Chromium (headless), navigate, start a run
./disco click "#load-chart" --until-request /api/slow --landed
./disco sql "SELECT method, path, status FROM requests WHERE action_id='act:2'"
./disco close
```

`./disco` is `node cli/disco.ts`. Scripts are plain TypeScript run with `node file.ts`.

---

## Quickstart

### From the CLI

```sh
./disco open shop https://example.shop/            # or: ./disco open shop --attach 9222  (a browser you started with --remote-debugging-port=9222)
./disco click "text=Sign in"                        # bare act: read the report, learn what happens
./disco fill "#email" me@example.com
./disco fill "#password" secret
./disco click "role=button[name='Sign in']" --until-url /account   # the postcondition you learned
./disco screenshot --out account.jpg
./disco sql "SELECT path, status, body_hash FROM requests WHERE action_id='act:5'"
./disco body 7a3f2c1e                               # a captured body by hash prefix
./disco note "login lands on /account; the session cookie is 'sid'"
```

Every command reconnects to the browser `open` started (or attached to), does one thing, prints the
report, and disconnects. The browser keeps running. `./disco` alone prints the reference.

### From a script

```ts
import { open, reached } from "./src/index.ts";        // path relative to your file

const s = await open("shop", { url: "https://example.shop/" });
reached(await s.click("text=Sign in", { until: { selector: "#email", visible: true } }));
reached(await s.fill("#email", "me@example.com"));
reached(await s.fill("#password", "secret"));
reached(await s.click("role=button[name='Sign in']", { until: { url: "/account" } }));

const me = s.store.latestJson("/api/me");            // the body the app just fetched
console.log(me.name);
await s.close();                                     // disconnect; the browser stays up
```

`reached(report)` throws with the diagnosis unless the action was performed *and* its `until` held.
Everything else is the report, returned as data; `formatReport(report)` renders it as the text the CLI prints —
log it while exploring.

---

## The two questions

Every `act` answers one question: **what happened?** — the URL, the aria-tree diff, the requests (with
bodies in the log), console errors, dialogs, new pages, in the window after the action. It never claims
the app is "done".

`until` answers the other: **am I in the state I need?** You state the condition; disco returns the
moment it holds, or after your budget with a diagnosis. The two compose: `s.click(x, { until })` arms
the condition *before* the click so a response that lands during the click still counts.

The habit that makes this work on an unfamiliar app:

1. **Act bare, read the report.** The diff and the wire tell you what the app does in response.
2. **Name the postcondition** you just saw — the element that appeared, the URL, the request that
   landed — and use it from now on. Prefer the wire (`{ request, landed: true }`) when the fact you need
   travels on it; prefer a *specific* element (`#chart-status:has-text("idle")`) over a generic one.
3. **On failure, read the diagnosis before retrying.** `not-found` lists the visible controls;
   `occluded` names the overlay; `timeout` on an `until` comes with the screenshot. Retrying the same
   call is the one thing that never helps.

---

## API

### `open(app, options) → Session`

```ts
const s = await open("shop", {
  url: "https://…",            // navigate after connecting (launch) — or select the page containing it (attach)
  attach: 9222,                // a running browser: port, host:port, http://…, or ws://… ; omit to launch
  headed: false,               // launch with a window
  dialogs: "accept",           // native dialogs: "accept" | "dismiss" (recorded either way)
  page: 0,                     // which open page to drive
  fresh: false,                // launch: wipe the profile first
  timeouts: { action: 3000, until: 5000, window: 700, navigate: 15000 },
  appsDir: "/abs/path/apps",   // where apps/<app>/ lives (default: apps/ next to this checkout, or $DISCO_APPS_DIR)
});
```

`open` reuses the browser recorded in `apps/<app>/store/browser.json` when it is alive, so a second
script (or the CLI) joins the same browser and the same run. A new browser starts a new run.

**Session fields.** `s.page` — the Playwright `Page`; use it directly whenever the wrapper is in your
way (`s.page.getByRole(…)`, `s.page.route(…)`). `s.context`, `s.browser`. `s.store` — the log reader
(below). `s.log` — the writable store. `s.dir` — `apps/<app>/`. `s.timeouts`.

### `s.act(spec) → Report`, and the sugar

| Sugar | Same as |
|---|---|
| `s.click(target, o)` | `act({ kind: "click", target, ...o })` |
| `s.dblclick(target, o)` · `s.rightclick(target, o)` | `kind: "dblclick"` · `kind: "click", button: "right"` |
| `s.fill(target, text, o)` | sets the value (one input event) |
| `s.type(target, text, o)` | keystrokes — for debounced/keyboard widgets |
| `s.press(key, { target?, ...o })` | `Enter`, `ArrowDown`, `Control+a` … on the target or the focused element |
| `s.select(target, value, o)` | `<select>` by value/label |
| `s.hover(target, o)` | |
| `s.drag(target, to, o)` | mouse down on the target, move to `to`, release (Playwright `dragTo`). For sliders and reorderable lists; use `s.page.mouse` for custom paths |
| `s.scroll(target \| deltaY, o)` | scroll an element into view, or wheel the page |
| `s.navigate(url, o)` | `goto`, waits for commit only |
| `s.until(pred, { timeout })` | wait without acting (`kind: "noop"`) |

`target` is a Playwright selector string (`#id`, `css`, `text=Save`, `role=button[name="Save"]`,
`xpath=…`, chained with `>>`) or a `Locator`. When several match, the first is used and
`report.matches` says how many.

**Options on every act** (`ActSpec`):

| Field | Meaning |
|---|---|
| `until` | the postcondition (below); armed before the action |
| `timeout` | budget for `until` (default `timeouts.until`, 5000) |
| `window` | observation window when there is no `until` (default 700) |
| `frame` | resolve the target inside an iframe: `"#frame"`, nested with `"#outer >> #inner"` |
| `shot` | take a screenshot at the end (hash in `report.shot`) |
| `js: true` | click: dispatch a DOM `click` event instead of moving the mouse. For widgets the app replaces faster than a real click can land, for fixed-position items outside the viewport, for anything whose handler is delegated to a parent. No actionability checks, no scrolling, no hover |
| `button`, `deltaY`, `to`, `text`, `key`, `value`, `url` | per kind |

Before performing a click, disco checks the element exists (waiting up to 1 s for it to attach), is
visible, is enabled, and is the element under its own centre — and returns a diagnosis instead of
acting when any of those fails. Playwright's own actionability wait (`timeouts.action`, 3 s) covers the
rest and its message becomes the diagnosis on timeout.

### The report

```
act:6 click #record-2  ok  299ms (act 78 · until 200 · report 10)  http://localhost:4800/
  until: ✓ visible #record-modal 278ms
  wire (1):
    GET /api/record/2 200 13ms json 311c996db00785ef 100B
  ui:
    + - heading "Record 2" [level=3]
    + - listitem: "name: Alan Turing"
    + - dialog "Allergy Review Required":
    + - button "Acknowledge"
    - - text: "ws: open · frames: 3"
```

| Field | What it is |
|---|---|
| `action` | `act:<n>` — the id every log row inside the window carries (`requests.action_id`, …) |
| `ok` | the action was *performed*. A failed `until` leaves `ok: true`; read `until.ok` |
| `diagnosis` | when not `ok`: `reason`, `message`, `over`, `candidates`, `dialogs`, `shot` (see below) |
| `until` | `{ ok, elapsedMs, which?, error?, diagnosis?, alreadyTrue? }` |
| `url` | the page URL after the window |
| `ui` | `{ added, removed }` lines of the aria snapshot (the page's accessibility tree) that changed. The main frame only — iframes appear as nodes, their contents do not |
| `requests` | every request started in the window: `method path status ms mime body(hash prefix) size [state]`. `[pending]` = still in flight at report time; the log row is completed later |
| `console` | errors, exceptions and warnings inside the window |
| `dialogs` | native dialogs inside the window and how they were handled |
| `pages` | URLs of pages opened inside the window (popups, `window.open`) |
| `openPages` | pages open in the browser afterwards; printed as `(+N other pages open)` — leftover popups throttle the driven page |
| `window` | `{ t0, t1 }` in the run's clock — `SELECT … WHERE t BETWEEN t0 AND t1` |
| `timing` | `actMs` (checks + the Playwright action) · `untilMs` · `windowMs` · `reportMs` · `totalMs` |

Attribution is a **time window**: what the report lists is what started between `t0` and `t1`. A poll
that fires during your window is in your report; you will recognise it because it is in every report.

### Diagnoses

| `reason` | Meaning | What to do |
|---|---|---|
| `not-found` | nothing matched, even after 1 s | read `candidates` (visible controls: `tag#id "name"`); fix the selector; if the element appears later, act with an `until` on the *previous* step |
| `hidden` | matched, not visible | it is rendered but collapsed/off-screen/`display:none`; open the thing that reveals it |
| `disabled` | matched, disabled | the form is not ready; wait for what enables it (`until: { fn }` on `!el.disabled` is fine) |
| `occluded` | another element is under the pointer (`over`) | usually a dialog — `dialogs` lists open ones; dismiss it, then retry |
| `offscreen` | the element is outside the viewport and cannot be scrolled to (`position: fixed` menus opened near the bottom) | scroll the page so it is visible, or `{ js: true }` when its handler is delegated |
| `unclickable` | the element or an ancestor has `pointer-events: none` | it is a keyboard widget: `type` / `press("ArrowDown")` / `press("Enter")`; or `{ js: true }` |
| `detached` | the element was replaced while Playwright was clicking it | the app re-renders it continuously (on hover, on a timer): `s.click(target, { js: true })` |
| `timeout` | Playwright's actionability wait or your `until` expired | read `message` and the `shot` |
| `error` | anything else (navigation mid-click, detached frame…) | `message` is Playwright's |

Every diagnosis carries `url`, the open `dialogs` (`[role=dialog]`, `aria-modal`, `<dialog open>`) and a
`shot` (JPEG blob hash; `./disco body <hash>` prints its path).

### `until` predicates

| Predicate | Holds when | Use it for |
|---|---|---|
| `{ selector, visible?, frame? }` | an element matches (and is visible) | the landmark of the next screen: a heading, a specific row, a status text — `#status:has-text("idle")` |
| `{ gone: selector, frame? }` | no visible match | a spinner, a modal, a "loading" row |
| `{ text }` | visible text anywhere | when you only know the words |
| `{ url }` | a string: the URL *without its query string* contains it (a string containing `?` matches the whole href); a RegExp: tests the whole href | navigations, logins, route changes. The query-string rule exists because `login?next=/account` contains `/account`. `{ url: "/" }` is always true — for "back to the shell", wait on the shell's element |
| `{ request, landed? }` | a response arrives whose URL contains / matches — i.e. the status is known. `landed`: its body finished too, so `latestJson` is safe; waits at most 1 s past the headers | the fact you need travels on the wire; API-first apps; anything a spinner lies about |
| `{ fn, arg? }` | `page.waitForFunction` returns truthy | everything else: `"document.querySelector('#x')?.dataset.state === 'ready'"` |
| `{ any: [...] }` | the first arm that holds; `until.which` names it (`label` or its description) | success **or** the app's own failure: `any: [ok, errorBanner]` |
| `{ all: [...] }` | every arm holds | the screen *and* the request |

Give arms a `label` and `until.which` reads well. The budget is `timeout` (default 5 s) for the whole
predicate. A predicate that is already true when you act is flagged `alreadyTrue` — choose one that is
false beforehand (the *new* record's heading, not "a heading"; `request` predicates only see responses
that arrive after arming, so they are never already true).

**A body the page never reads has no body.** When an app does `const r = await fetch(url); if (r.ok) …`
without reading the body, Chromium never finishes the response and cannot hand the body over — not to
Playwright, not to raw CDP. disco marks such rows `body_state: missing` ("body not read by the page") after
1.5 s, and `landed` resolves after its 1 s bound. What you *do* get is the status code: the report's wire line
and `requests.status`. For an optimistic "Saved ✓", wait on `{ request: "/api/save/status" }` and read the
status, or on the element the outcome renders (`any` of the success and failure toasts).

### `reached(report, what?) → report`

Throws unless `report.ok` and (`report.until` absent or `until.ok`). The message carries the diagnosis:
`act:7: occluded — #record-3 is covered by div#record-modal.overlay (open: div#record-modal "Allergy Review Required") [shot afc670dce369]`.
Wrap every step of a workflow in it and failures explain themselves.

### The rest of the Session

| | |
|---|---|
| `s.evaluate(fnOrSource, arg)` | run in the page's main world, return JSON-able values |
| `s.screenshot(reason?)` | `{ hash, path }` — JPEG in the blob store, row in `shots` |
| `s.note(text)` | append a timestamped line to `apps/<app>/NOTES.md` (and the `notes` table) |
| `s.frame("#a >> #b")` | a `FrameLocator` for nested iframes |
| `s.closeOtherPages()` | close every page but the driven one (popups left by earlier scripts) |
| `s.close({ browser? })` | disconnect; `browser: true` also kills a browser disco launched (an attached one is only forgotten) |
| `formatReport(report)` | the report as the CLI prints it |

### The log

`apps/<app>/store/store.sqlite` + `blobs/`. Open it without a browser:

```ts
import { openApp } from "./src/index.ts";
const st = openApp("shop");                       // read-only; same object as s.store
st.requests({ url: "/api/orders", method: "GET", action: "act:9", status: 200, run: 2 });   // RequestRow[] — fields are the requests columns: id, t_start, method, url, path, status, mime, body_hash, body_size, body_state, req_body, resp_headers, action_id…
st.latestJson("/api/me");                          // parsed body of the newest matching response
st.json(hash) · st.body(hash) · st.bytes(hash)     // a body by hash or 16-char prefix
st.action("act:9")                                 // the stored row, report parsed
st.sql("SELECT …")                                 // anything
```

Tables (`./disco schema` prints the DDL): `runs` · `actions` · `requests` (headers as JSON, `req_body`,
`body_hash`, `body_state` = `ok | truncated | missing | streaming | error | pending`, `action_id`) ·
`bodies` (text under 512 KB, FTS5 as `bodies_fts`) · `ws_frames` · `console` · `dialogs` · `nav` ·
`shots` · `notes`. Every row has `run`; time is `t` (ms since the run started) — except `requests`, which has
`t_start`, `t_response`, `t_end`. The report's wire line prints `body_size` as "size". Useful one-liners:

```sql
-- where does a string on the screen come from?
SELECT r.method, r.path, r.status FROM bodies_fts f JOIN bodies b ON b.rowid=f.rowid JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH '"Alan Turing"';
-- what did the app do while I was not acting?
SELECT t_start, method, path, status FROM requests WHERE action_id IS NULL AND run=2 ORDER BY t_start;
-- the endpoint map so far
SELECT method, path, count(*) n, min(status), max(status) FROM requests WHERE resource_type IN ('xhr','fetch') GROUP BY 1,2 ORDER BY n DESC;
-- cookies set during login
SELECT path, json_extract(resp_headers,'$."set-cookie"') FROM requests WHERE resp_headers LIKE '%set-cookie%';
```

`body_state: missing` means Chromium no longer had the body when asked (large bodies the page never read,
some redirects); `streaming` is an event-stream that never ends — its messages are not captured.
WebSocket payloads are (`ws_frames`, capped at 16 KB each).

**What is recorded when.** A script records for as long as its `Session` is open. The CLI records only
while a command runs — between commands, nothing is written. `./disco record` keeps recording until
Ctrl-C; run it in a second terminal when the app's background traffic matters.

### CLI reference

```
./disco open <app> <url> [--headed] [--dialogs accept|dismiss] [--fresh]
./disco open <app> --attach <port|host:port|ws://…> [--url <substring>]
./disco close [<app>]            ./disco ls            ./disco pages            ./disco schema
./disco click|dblclick|rightclick|hover <target> [until…] [--frame F] [--window MS] [--shot] [--js]
./disco drag <target> <to>
./disco fill <target> <text>     ./disco type <target> <text>     ./disco press <key> [--target T]
./disco select <target> <value>  ./disco scroll [<target>|--dy N]  ./disco navigate <url>
./disco until [until…]           until…: --until-selector S [--visible] | --until-gone S | --until-text T
                                         --until-url U | --until-request R [--landed] | --until-fn JS   (repeat → any-of)  --timeout MS
./disco eval <js>                ./disco screenshot [--out f.jpg]    ./disco sql <query> [--json]
./disco body <hash>              ./disco note <text>                 ./disco record
```

`--app <name>` on any command (default: the last `open`, kept in `apps/.current`); `--json` prints the
report as data. Exit code 1 when the action failed or its `until` did not hold.

### `check.ts` and `run-check`

```ts
// apps/shop/check.ts
import { reached } from "../../src/index.ts";
import { login, openOrder } from "./lib.ts";
export const target = { url: "https://example.shop/" };          // { attach: 9222 } to use a running browser
export async function check(s, step) {
  await step("login", () => login(s, "me@example.com", "secret"));
  await step("open an order", async () => { const o = await openOrder(s, "1001"); if (o.total <= 0) throw new Error("no total"); });
}
```

`node scripts/run-check.ts shop` (or `npm run check -- shop`) prints `PASS/FAIL name (ms)` per step and
exits non-zero on any failure. `--headed` to watch, `--close` to kill the browser afterwards.

---

## Timeouts

| Name | Default | Governs |
|---|---|---|
| `action` | 3000 | Playwright's actionability wait inside click/fill/… |
| `until` | 5000 | an `until` without its own `timeout` |
| `window` | 700 | the observation window of a bare act |
| `navigate` | 15000 | `goto` to commit |
| (fixed) 1000 | | how long `act` waits for a missing element to attach before `not-found` |
| (fixed) 300 | | how long the report waits for in-flight bodies before printing |

Set them per session (`open(app, { timeouts })`), per act (`timeout`, `window`). Raise a budget when the
app is genuinely slow *for that step*, and write the number down in the app's README; never raise the
defaults to make a flaky predicate pass.

---

## Working an unfamiliar app

**Recon first (10 minutes).** Open it, look at the log: `SELECT method, path, resource_type FROM requests
WHERE run=<n>` — is it an SPA with a JSON API, server-rendered pages, iframes (`./disco pages` shows
popups; `frame:` handles iframes), a WebSocket? Where is auth (cookie → `resp_headers`; token →
`req_headers`)? What fires on its own (`action_id IS NULL`)?

**Then workflows, as experiments.** Each act is one; read its report before the next. Write the anchor
of each screen (URL + one specific element) into the README as you find it, and the transition's
postcondition as an `until`. Facts come from the wire whenever they travel on it: the list behind a
virtualised table, the record behind a form, the outcome behind an optimistic "Saved ✓" (`{ request:
"/api/save/status" }`, then the status on the wire line — the body only if the page reads it).

**Interstitials.** Dialogs that appear for some records and not others are normal (allergy reviews,
"what's new", session warnings). Make them optional both ways: `until: { any: [{ selector: nextScreen,
label: "next" }, { selector: "[role=dialog]", label: "dialog" }] }`, then handle `which === "dialog"`.

**Keyboard-only widgets.** Comboboxes that ignore the mouse: `type` (keystrokes, not `fill`) with `until:
{ request: "/api/suggest", landed: true }`, then `press("ArrowDown", { target })`, `press("Enter", { target,
until: { selector: theSelectedState } })`. Record the recipe verbatim in the README.

**Auth and expiry.** Log in with an `until: { url }` (or `any` of the landing anchor and the error
banner). Note the cookie name from `resp_headers`. Expiry usually arrives as a dialog or a redirect to
the login URL — add the login URL as an arm of your workflow anchors so a refusal costs milliseconds.

**When a report surprises you,** the log has more than the report: `SELECT * FROM requests WHERE
action_id='act:n'` for headers and bodies, `SELECT * FROM console WHERE t BETWEEN t0 AND t1`, the
`shot`. `s.page` is always there for a Playwright move the wrapper lacks.

**Recovery.** Every workflow function should start by asserting where it is (`s.until(anchor, { timeout:
1500 })`) and know one way back to the shell (usually `navigate(home)` + the shell's anchor).

**Never:** `sleep`; raise a timeout to hide a wrong predicate; assert a fact off the screen when the
response that carried it is in the log; retry a diagnosis without reading it.

**Selector gotchas.** `:has-text("armed")` is a case-sensitive *substring* match — it matches "unarmed";
use `:text-is("armed")` or `text="armed"` for whole strings. A lingering toast from the previous step
makes `[role=status]:has-text("Saved")` already true — wait for it to be `gone` first. When a report's
`ui` line reads `text: "status: idle Chart loaded (3 responses)"`, that is two adjacent elements glued
into one aria line; anchor on the element you mean (`#chart`), not on the line.

**Effects that arrive on the next event.** Setting `scrollTop` or dispatching an event returns before the
handler runs; a synchronous read right after sees the old DOM. Wait on the effect (`until: { fn }` on the
first row's id changing), never on the cause.

**State leaks between scripts — by design.** A second script joins the same browser *where the last one left
it*: mid-modal, on another page, with a popup still open, with the app's knobs still flipped. Start every
script by asserting or reaching an anchor (`navigate(home)` + `until`), and close popups you opened — a page
left in the background is throttled by Chromium (one animation frame per second), which shows up as clicks
that take ~3 s with no diagnosis. The report header says `(+1 other page open)` when that is the case;
`s.closeOtherPages()` / `./disco pages --close-others` clears it.

**The app's own code is on the wire.** `SELECT body_hash FROM requests WHERE resource_type='script'` then
`./disco body <hash>` — reading the client that issues a request is legitimate, fast, and often the only way
to learn why a channel is silent or a body is never read.

---

## The app folder

```
apps/<app>/
  README.md      what the app is and how to drive it — for a human and for the next agent
  NOTES.md       appended by `disco note` / `s.note()`: raw observations with act ids; distil into README.md
  wire.md        endpoint → what it carries; read/write; the bodies worth citing by hash
  friction.md    where disco or these docs got in your way (format: what you tried · what happened · what you did instead)
  lib.ts         the workflows as functions: anchor in → anchor out, `until` on every transition, wire-first reads
  check.ts       target + steps that prove lib.ts still works (`run-check`)
  store/         the log (gitignored)
```

Any subset is legitimate; a folder with only `NOTES.md` is a fine first hour. The habit is
**accumulate → distil**: notes while working, README when something settles.

**README.md sections that earn their place:**

1. **What it is** — one paragraph: architecture (SPA/MPA, frames, API style), auth, where facts live.
2. **Glossary** — the app's nouns as *it* uses them (encounter, chart, order, visit…), each with where it
   appears on screen and on the wire (`Condition.entry[].resource.code.text`).
3. **Anchors** — each screen's cheap assertion: URL pattern + one specific element.
4. **Workflows** — one section per task: preconditions (anchor), the steps with their selectors and
   `until`s, the postcondition, what varies, the act ids that show it. Snippets, not prose.
5. **Interstitials and recovery** — every conditional dialog seen, when it appears, how it is handled;
   how to get back to the shell from anywhere.
6. **Input recipes** — the widgets that need keystrokes, drags, or a specific order.
7. **Gotchas** — optimistic UI, spinners that lie, virtualised lists, iframes, re-renders, expiry.
8. **Open questions** — what you did not verify, with the experiment that would.

---

## The gauntlet

`gauntlet/` is a deterministic hostile app that exercises everything above: concurrent fetches with
one slow, a conditional modal, optimistic UI with an async failure toast, perpetual spinners, heartbeat
and long-poll traffic, WebSocket/SSE/long-poll push, a debounced search, virtualised rows, a re-render
race, same- and cross-origin iframes, native dialogs, session timeout, a child window, canvas, a
keyboard-only combobox, shadow DOM, GraphQL over POST, auth with a login page, and a disabled control
that hit-tests to its parent. `bun gauntlet` serves it on :4800; `gauntlet/scenarios.md` documents every
behaviour and the `/ctl` knobs that drive them.

It is disco's test target (`npm test`) and the exam for agents: characterise it from the README alone,
build `apps/gauntlet/`, and write down where the tool or the docs got in the way.

---

## Tests

`npm test` starts the gauntlet and one browser, and pins the promise table: a no-op costs the window and
little else, a missing selector is diagnosed in about a second with candidates, disabled/occluded in
about 100 ms, `until` returns when the request lands and not later, an expired `until` costs its budget
and no more, `alreadyTrue` is flagged, bodies/cookies/WS frames/dialogs/popups/console errors are in the
log, frames and shadow DOM work, and the CLI and `run-check` run as a stranger would run them.
`npm run typecheck` for the types.

---

## What disco is not

No daemon (the browser is the only long-lived process; every client reconnects over CDP). No settlement
heuristics, verdicts, or "quiet" detection — you say what you wait for. No request classifier: attribution
is the time window and the log. No screencast, no sentinels, no learned state. No page instrumentation:
disco never injects into or patches the page, which is what lets it attach to a browser it did not start.

The previous generation of disco (a daemon with settlement races, ambient-traffic classifiers and
screencast diffing) lives on the `main` branch; its `DECISIONS.md` records what it learned and why
this one is smaller.
