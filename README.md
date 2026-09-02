# disco

Drive a web app you have never seen and leave behind a pack the next agent can trust. disco is three verbs on
top of Playwright and one SQLite file:

- **`look`** — the screen: the accessibility tree, a screenshot with numbered marks, and a selector that pastes
  for every control. Or one selector: what it matches, where, and what is really under the pointer.
- **`act`** — any Playwright code, run as one observed step. The report says what happened (URL, UI diff,
  wire, storage, console, dialogs), *why it returned* (your `until` held, the app went quiet, `max` expired),
  what is still in flight, and **proposes the `until` you should use next time** — each one false before the action.
- **`sql`** — the log. Every request with its body, every WebSocket frame, console line, dialog, navigation and
  act, in `apps/<app>/store/store.sqlite`. There is no API in front of it.

It works on a browser disco launched or on one that is already running (`connectOverCDP`), and it never injects
anything into the page.

## The promise

| Situation | What you get | Cost |
|---|---|---|
| You act without an `until` | the report, once the app has been quiet for 500 ms — or at `max` with what is still in flight | quiet · ≤ max |
| You act with an `until` | the report the moment it holds | as long as the app takes · ≤ max |
| The `until` never holds | `until.ok: false`, `returned: "max"`, Playwright's reason, the wire that did arrive | max |
| The `until` was true before you acted | `until.alreadyTrue`, and `reached()` refuses it | 0 |
| The element is missing, hidden, disabled, covered, off-screen, re-rendering, or ignores the mouse | `diagnosis.reason` naming the cause, the selector, what covers it, open dialogs, the visible controls, a screenshot | ≤ max |
| A click landed but its handler blocked the page past `max` | `ok: true` with a `note`; the observation continues | max |
| The page never read a response body | the row says so; the status is still there; a Playwright `response.finished()` (body downloaded) in your `until` gets a note | 1.5 s after the headers |
| You want to know what a selector matches before acting | `look(selector)` | ~100 ms |

No wait is longer than the `max` you wrote (default 3 s). Nothing sleeps for you. Nothing decides the page is "done".

## Install and run

Node ≥ 24 and a Chromium/Chrome binary (`/usr/bin/chromium` is found; otherwise `DISCO_CHROMIUM=/path`). Bun only runs the gauntlet test app.

```sh
npm install                                        # playwright-core is the only runtime dependency
./disco open shop https://example.shop/            # launch Chromium, navigate, record everything until close
./disco look                                       # what is on the screen, numbered; a JPEG path to view
./disco act 'page.click("text=Sign in")'           # a bare act: read what happened, copy a proposed until
./disco act 'page.fill("#email", "me@x.io")' --quiet 50
./disco act 'page.click("#login")' --until 'page.waitForURL(u => u.pathname.includes("/account"))'
./disco sql "SELECT method, path, status FROM requests WHERE action_id='act:5'"
./disco close
```

Attach to a browser you started yourself (`chrome --remote-debugging-port=9222 --user-data-dir=/tmp/p`; Chrome ≥ 136
refuses the default profile): `./disco open shop --attach 9222 --url example.shop`.

```ts
import { open, reached } from "./src/index.ts";
const s = await open("shop", { url: "https://example.shop/" });
try {
  reached(await s.act("sign in", (page) => page.click("text=Sign in"), { until: () => s.page.locator("#email").waitFor() }));
  reached(await s.act("email", (page) => page.fill("#email", "me@x.io"), { quiet: 50 }));
  reached(await s.act("log in", (page) => page.click("#login"), { until: () => s.page.waitForURL((u) => u.pathname.includes("/account")) }));
  const me = await s.json("/api/me");                  // the body the app just fetched, from the log
} finally { await s.close(); }                          // a script that never closes never exits
```

## API

### `open(app, { url?, attach?, headed?, appsDir? }) → Session`

Launches Chromium (or rejoins the one launched before, or attaches to `attach`: a port, `host:port`, `http://…`
or `ws://…`), picks the page at `url` (else the first that no popup opened), and navigates only when the page is
somewhere else — as its own act, returning once the new page is quiet (`s.opened` says `navigated` or `joined`). A run
is one browser's life: a second script joins the same browser **and the same run**, wherever the last one left it, and
act ids are unique across runs. `s.page` is the Playwright `Page`; `s.context`, `s.browser`, `s.run`, `s.dir` (`apps/<app>/`).

### `s.act(label, run, { until?, quiet?, max? }) → Report`

`run(page)` is your code — any Playwright call, a `page.evaluate`, several steps. `label` is what the log calls it.
Your code runs in Node: use `page.evaluate(() => …)` for the DOM, and for a `fetch` that should carry the page's cookies — which is
also how you verify a write: `s.act("re-read", (p) => p.evaluate((u) => fetch(u).then((r) => r.json()), url))` puts the answer in `value` and on the wire.

| Option | Default | Meaning |
|---|---|---|
| `until` | — | `() => Promise`. Armed **before** `run`, so a response that lands mid-click counts. The act returns the moment it resolves. A Playwright wait (`locator.waitFor()`, `page.waitForResponse(…)`, `page.waitForURL(…)`), `s.waitFor(…)`, or a `Promise.race` of several — label the arms with `.then(() => "ok")` and `until.value` says which |
| `quiet` | 500 | without `until`: return once nothing has happened for this long — no request, response, frame, console line, dialog, navigation or DOM change, and no request this act started is still unanswered |
| `max` | 3000 | the one budget: the default timeout of every Playwright call inside `run` and `until`, and the longest the act observes |

**The report** (`String(report)` is what the CLI prints; `report.value` is what `run` returned):

| Field | What it is |
|---|---|
| `action` | `act:<n>` — the id every log row inside the window carries (`requests.action_id`, …) |
| `ok` | `run` did not throw. A failed `until` leaves `ok: true`; read `until.ok`. `reached()` checks both |
| `returned` | `until` · `quiet` · `max` · `error` — why the observation ended |
| `until` | `{ ok, elapsedMs, alreadyTrue?, error?, value? }` |
| `diagnosis` | when `run` threw: `reason`, `message`, `selector` (as Playwright named it), `over`, `candidates`, `dialogs`, `shot` |
| `ui` | `{ added, removed }` lines of the accessibility tree that changed between the start and the end of the window (main frame; iframes appear as nodes) — a toast that came and went inside the window is not in it; the wire or a shot is |
| `requests` | the app's own traffic started in the window — `{ id, method, path, status, ms, mime, body (hash), size, state }`; `static` folds scripts, styles, images, fonts into a count, `thirdParty` folds other sites (telemetry) out of the wire, `writes` and `pending`. `(started earlier)` marks a long-poll that answered you |
| `pending` | requests started in the window and still in flight when it closed |
| `writes` | `string[]`: the non-GET app requests in the window, printed as `writes: none` when empty — under a read-only stance, anything else is the signal to stop |
| `storage` | cookie (HttpOnly included), localStorage and sessionStorage changes — the wire of an app that has no wire |
| `console` · `dialogs` · `pages` · `downloads` · `openPages` | errors and warnings; native dialogs (accepted, recorded); URLs of popups opened; files the page started downloading; pages open afterwards (more than 1 throttles the driven page) |
| `proposed` | pasteable `until` code for what this act caused: responses with their `+ms`, roles that appeared (with their new state: `selected`, `expanded`, `checked`), the one that left, the url path, a storage key. **Copy one into the SDK.** |
| `note` | something true that is not a failure: the click landed but the page blocked; a body the page never read; what an already-true or failed until's target looks like now, and what answered just before the act; lines that only moved |
| `aria` | hash of the accessibility tree after the act (`s.body(hash)` prints it) — what a `look` right after would show; it travels with the act's evidence, so a screen fact cites the act that produced the screen |
| `window`, `timing` | `{ t0, t1 }` in the run's clock; `{ runMs, observeMs, reportMs, totalMs }` |

**Diagnoses** (`diagnosis.reason`):

| Reason | Meaning · what to do |
|---|---|
| `not-found` | nothing matched within max — the visible controls are listed as selectors that paste; `look(selector)` tries one without acting |
| `hidden` · `disabled` | matched, but collapsed / display:none, or not enabled — open what reveals it; wait for what enables it |
| `occluded` | another element is under the pointer (`over`): a dialog or toast to dismiss — **or** a styled checkbox/radio whose real input hides under a span in its `<label>`: click the label, or `check({ force: true })` |
| `offscreen` | outside the viewport and unscrollable (a fixed menu, a panel parked off-canvas — which still counts as *visible*) — open what slides it in, or `locator.dispatchEvent("click")` |
| `unclickable` | `pointer-events: none` — a keyboard widget: `pressSequentially`, `ArrowDown`, `Enter`; or `dispatchEvent("click")` |
| `detached` | the app re-renders it faster than a mouse click — `dispatchEvent("click")` |
| `timeout` · `error` | Playwright's message; for `page.goto`, raise `max` or use `waitUntil: "commit"` and wait for the element you need |

### `s.look(selector?) → Look`

Without a selector: `url`, `aria` (the accessibility tree — on a SPA the HTML is an empty shell and this is the only
honest picture), `controls` (`{ n, selector, role, name, box }` — the numbers match the marks in `shot`), `shot`
(a JPEG path: view it), open `dialogs`. The selector is durable: `data-test`, a stable id, a unique `role=…[name="…"]` (an exact, case-sensitive
match after whitespace normalisation — unlike `getByRole` without `exact: true`, which is a substring), else a short css path. With a selector or `Locator`: `count`, `matches` (`{ n, selector, tag, role, name, text, box,
visible, enabled, inViewport, under, why }`), a `note` on known footguns (`:has-text()` is a case-sensitive substring;
one engine per segment), and `error` when it does not parse. Nothing is written to the page: the marks are drawn on a
copy of the screenshot in a scratch page.

### `s.waitFor(kind, pred, timeout?) → event`

The next event on the recorder's stream that satisfies `pred`: `"request"` / `"response"` (`{ id, method, url, status }`)
· `"ws"` (`{ dir, payload, url }` — including sockets opened before you joined) · `"console"` (`{ level, text }`) ·
`"dialog"` (`{ type, message }`) · `"page"` (a popup, `{ url }`) · `"nav"` (the main frame committed a navigation,
`{ url }`). Default timeout: the enclosing act's `max`. A navigation's honest `until` is
`s.waitFor("nav", e => e.url.includes("/home")).then(() => page.locator("#shell").waitFor())` — false before the goto
even when you were already there.

### `s.sql(query, …args)` · `s.body(hash)` · `await s.json(urlPart, { action?, method? })`

The log. `sql` returns an array of row objects and explains a wrong column with the table's columns. `body` returns a body (or a
screenshot's bytes) as a string, by hash or 16-char prefix. `json` returns the newest JSON body whose URL path contains `urlPart`,
scoped to an act and/or a method (`json("/api/save", { action: r.action, method: "POST" })` reads back a write when the app fired
GETs after it); it waits up to 1 s for a body still arriving, and it **throws** when nothing matched (naming what did answer), when
a query-string fragment matches several endpoints, or when the newest match answered 4xx/5xx — a fact you could not find is never `null`
(for the error body itself, `sql` and `body`). Scope `sql` the same way: `WHERE action_id = ?` for one act, `WHERE run = ?` for one browser's life. Tables: `runs` · `actions` (`id, n, t0, t1, label, code, ok, report` — the
report as JSON) · `requests` (`id, t_start, t_response, t_end, method, url, path, resource_type, req_headers, req_body,
status, mime, resp_headers, body_hash, body_size, body_state, action_id, run`) · `bodies` (+ `bodies_fts`) · `ws_frames` ·
`console` · `dialogs` · `nav` · `shots`. `requests` keys on `id`; everything else on `seq` and `t` (ms since the run
started — restart at every run, so order by `run, t`). `body_state`: `ok | truncated | missing | streaming | error | pending`.

```sql
SELECT method, path, count(*) n FROM requests WHERE resource_type IN ('xhr','fetch') GROUP BY 1,2 ORDER BY n DESC;   -- the endpoint map
SELECT r.method, r.path FROM bodies_fts f JOIN bodies b ON b.rowid=f.rowid JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH '"Alan Turing"';  -- where a string on the screen comes from
SELECT t_start, method, path, status FROM requests WHERE action_id IS NULL AND run=2 ORDER BY t_start;              -- what the app did on its own
```

### `reached(report, what?) → report` · `s.close({ browser? })`

`reached` throws with the diagnosis unless `run` ran and its `until` held (a bare act passes on `ok`), and throws when the `until` was already true.
`close` disconnects; `{ browser: true }` also kills a browser disco launched (an attached one is only forgotten).

## The pack

```
apps/<app>/
  README.md    the narrative an agent judged worth writing: what the app is, anchors, the wire facts that matter, traps, open questions
  sdk.ts       the app's missing API: typed workflows, reached() on every step, facts read from the server; exports check(s)
  evidence/    reports, bodies and shots you copied because README.md cites them (optional)
  store/       the log (gitignored)
```

**The rule:** every claim in `README.md` is either backed by a function in `sdk.ts` or cites an act (`act:86`) whose
report or shot is in `evidence/`; a number without an act id is a guess. Write the README from the evidence files, not from
memory: a number or a quoted string belongs in a sentence only with the act whose evidence contains it. A fact about a screen —
an anchor, a selector, what a menu contains — is either an exported constant in `sdk.ts` (refer to it by name) or cites the act
that put that screen there: its evidence carries the accessibility tree it left behind. When a stance requires
a marker and a record has no free-text field for it, the marker goes in the parent record or an attached note — the workflow is
not skipped. Workflow narrative — precondition, steps, postcondition, side effects, gotchas — lives in
the docblock above the function, once. Every `close` (a script's or `./disco close`) copies each act the README cites (`act:12`, or a range `act:12-15`) into
`evidence/`: the report (`act-N.json`), its shot, its wire (`act-N-wire.json`: requests with headers and bodies, navigations) and the
accessibility tree it left behind (`act-N-aria.txt`) — and
prints what it could not back: cites with no report, a number beside a cite that its evidence does not contain, numbers with no cite,
and sentences with neither a cite nor an sdk function. It reads the number itself, so quote the report's own numbers (`timing`, `status`, a count from a body). `sdk.ts` runs its own check:

```ts
// apps/shop/sdk.ts
import { open, reached, type Session } from "../../src/index.ts";
export const URL = "https://example.shop/";
/** Every anchor and selector the README asserts lives here by name; the cold check exercises them and the README refers to `anchors.account`, not to a bare string. */
export const anchors = { login: "#email", account: "[data-test='account-header']" };
/** Log in. Precondition: any page. Postcondition: /account. Side effects: none. Verified cold 2026-09-01 (act:14). */
export async function login(s: Session, user: string, pass: string) {
  reached(await s.act("open login", (p) => p.goto(URL + "login"), { until: () => s.waitFor("nav", (e) => e.url.includes("/login")).then(() => s.page.locator("#email").waitFor()) }));
  reached(await s.act("credentials", async (p) => { await p.fill("#email", user); await p.fill("#password", pass); }, { quiet: 50 }));
  reached(await s.act("submit", (p) => p.click("#login"), { until: () => s.page.waitForURL((u) => u.pathname.includes("/account")).then(() => s.page.locator(anchors.account).waitFor()) }));
  return s.json("/api/me");
}
export async function check(s: Session): Promise<number> {
  let failed = 0;
  for (const [name, fn] of [["login", () => login(s, "me@x.io", "secret")]] as const) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message}`); break; }   // steps share the browser: stop at the first failure instead of paying every later step's max
  }
  return failed;
}
if (import.meta.main) { const s = await open("shop", { url: URL }); let f = 1; try { f = await check(s); } finally { await s.close(); } process.exit(f ? 1 : 0); }
```

A write workflow takes the record's fields as parameters (`addOrder(s, { sku, qty })`) and the check supplies marked values,
so the first real task can call it. `node apps/shop/sdk.ts` runs it and leaves the browser running; while it runs,
`./disco sql "SELECT n, label, ok FROM actions ORDER BY n DESC LIMIT 5"` is its progress bar, and its `close` prints the evidence and claim check. A pack is done when it passes **warm and cold** — once on
the browser you explored with, then once more after `./disco close shop` on a fresh one. The cold run catches every until that was only true because of what you
had already done.

## Method

Look before you guess: `look` shows the controls with selectors that paste, and `look(selector)` tells you what one matches
before you spend an act on it. Act bare first and read the report — the wire, the diff, the storage line — then copy one of
its proposed untils into `sdk.ts` and keep it; a proposed until was false before the action, so it can never be already
true. Never write an until you have not seen hold: take it from a bare act's proposals or from a report where it held, not
from what the endpoint or the screen ought to be called. On a failure read the diagnosis before retrying: it names the cause,
and retrying the same call is the one thing that never helps. Keep `max` small while probing (1000 is plenty); raise it only
on the one act you watched exceed it, inline, with the measurement in a comment — a pack-wide `max` is compensation for
guesses. When a fact travels on the wire, read it from the log (`json`, `sql`) rather than off the screen; verify a write by
re-reading the server, not the toast. Start every workflow by asserting its anchor and skipping the navigation when already
there (`if (!(await s.look(anchor)).count) reached(await s.act("go", …))`), end it where you found the app, and run the check
cold before you write a sentence about it. Before you write the pack, run `npm run stats -- <app>`: an expired budget above
10 s in its *failed untils* share means your untils were guesses — fix the method, not the numbers (deliberate probes that fail
are counted separately, as failed acts).

## CLI

```
disco open <app> <url> [--headed]                 disco open <app> --attach <port|host:port|ws://…> [--url <substring>]
disco close [<app>]
disco look [<selector>]
disco act <js> [--until <js>] [--quiet MS] [--max MS] [--label TEXT]      page and s are in scope; an expression's value is the act's value
disco sql <query>
```

`--app <name>` on any command (default: the last `open`); `--json` prints data. Exit code 1 when the act failed, its
`until` did not hold, or was already true. `open` starts a detached recorder, so the log also holds what the page did
between commands.

## The gauntlet and the tests

`gauntlet/` is a deterministic hostile app: concurrent fetches with one slow, a conditional modal, optimistic UI with an
async failure toast, perpetual spinners, heartbeats and long-polls, WebSocket/SSE push, a debounced search, virtualised
rows, a re-render race, iframes, native dialogs, session timeout, a child window, canvas, a keyboard-only combobox, shadow
DOM, GraphQL, auth, a skeleton table, a cached revisit, stacked panels, styled radios, a submit that blocks the main
thread, and a 10,000-row page. `bun gauntlet` serves it on :4800 and a second origin on :4801 (`--port N` takes N and N+1). `gauntlet/scenarios.md` is the answer key — an agent
characterising it from this README alone leaves it closed. `npm test` starts it and pins the promise table with timing
ceilings; `test/budget.test.ts` pins the size of this surface (exports, methods, options, commands, this file's length).

## What disco is not

No daemon: the browser is the only long-lived process, every client reconnects over CDP. No page instrumentation, which
is what lets it attach to a browser it did not start. No settlement verdicts: `quiet` is a number you name, and the report
says whether it was reached. No selector language of its own, no predicate language, no action kinds: you write
Playwright, disco observes. v2 (`git log v2`) had all of those; `DECISIONS.md` says why v4 does not.
