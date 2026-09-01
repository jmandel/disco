# friction — driving the gauntlet with disco, from the README alone

Everywhere the tool or its documentation got in the way. Ordered roughly by what it cost me.
Times are wall clock spent on the item, not on the task it belonged to.

---

### 1. `alreadyTrue` is flagged but does not fail `reached()` — it cost me a red check (~7 min)

**Tried.** An `any`-of postcondition for "did the beforeunload dialog let us leave?":

```ts
await s.click("#nav-away", { until: { any: [
  { selector: "h1:text-is('You navigated away')", label: "left" },
  { selector: "#load-chart", label: "stayed" } ] } });
```

**Happened.** `until: ✓ stayed 6ms ⚠ already true before the action — proves nothing`, `reached()`
passed, and my `check.ts` reported `FAIL 11. native dialogs: beforeunload did not let us leave: stayed`
on a run where the browser had in fact navigated correctly. The predicate had been true since before
the click, because `#load-chart` is on the page we were already on.

**Expected.** Either `reached()` to throw on an `alreadyTrue` arm, or at minimum for the docs to say
that `until.which` can name an arm that proves nothing. The README warns about `alreadyTrue` in
prose ("choose one that is false beforehand") but the *mechanism* — a green `until.ok: true` and a
confident `which` — reads as success in code. `reached()` is sold as "wrap every step and failures
explain themselves"; this failure explained itself as a pass.

**Did instead.** Removed the negative arm entirely: wait only for the positive landmark with a short
budget and treat the timeout as "stayed", plus assert `report.dialogs` contains a `beforeunload` entry
so the step still proves the dialog was raised. See `armAndNavigateAway` in `lib.ts`.

**Suggestion.** `reached()` should throw (or at least there should be `reached(r, { strict: true })`)
when the satisfying arm was `alreadyTrue`. A predicate that was true before the action is, by the
README's own words, not a postcondition.

---

### 2. `s.drag(target, to)` cannot address a point — only another element (~5 min)

**Tried.** `await s.drag("#slider-thumb", { x: 250, y: 578 })`, the obvious reading of "For sliders and
reorderable lists".

**Happened.** `act:33 drag #slider-thumb FAILED 82ms — diagnosis: error — locator.dragTo: target:
expected string, got undefined`. A Playwright-internal message leaking through; nothing said "the
destination must be a selector".

**Expected.** Either a `{x,y}` destination, or the README to say `to` is a selector/Locator only —
because a slider is precisely the case where there is no element to drop onto.

**Did instead.** `s.page.mouse.move/down/move(...,{steps:12})/up`. The README does mention
"use `s.page.mouse` for custom paths", but it recommends `drag` for sliders in the same sentence,
which is the wrong way round.

**Also.** `s.drag("#sort-a", "#sort-c")` on the reorderable list moved the item exactly **one** slot
(`a,b,c` → `b,a,c`) rather than to C's position, because `dragTo` teleports to the element centre in
one move and the list reorders on `dragover` midpoints. Any real reorder needs a stepped path. Worth a
sentence in the docs, since reorderable lists are the other advertised use.

---

### 3. There is no `until` for "a new page opened" (~4 min, 8 s of it pure waiting)

**Tried.** `await s.click("#open-child", { until: { fn: "window.__child && !window.__child.closed" } })`
— a guess, because the predicate table has nothing for popups.

**Happened.** The full 5 s budget burned (`page.waitForFunction: Timeout 5000ms exceeded`), on an act
that actually took 8030 ms end to end. The report then cheerfully printed `new page:
http://localhost:4800/child.html` — it *knew*, it just could not be waited on.

**Expected.** `until: { page: "/child.html" }`, symmetric with `{ url }`. The report already has
`pages` and `openPages`; the predicate is the missing half.

**Did instead.** Bare act with `window: 1200`, then `s.context.pages().find(...)`. Works, but it means
the one hazard where a fixed observation window is unavoidable is the one the README's whole design
(«you name what you wait for») is meant to eliminate.

---

### 4. `act` has no `position` — a canvas cell needs raw mouse coordinates (~4 min)

**Tried.** `s.click("#grid")` to hit a specific cell of the 4×8 canvas grid.

**Happened.** It clicks the element centre. `act:55` came back `ok` with an empty `ui` diff and no
wire — indistinguishable from "nothing happened", because for a canvas nothing in the DOM *ever*
changes. I spent two probes convincing myself the click had done anything at all.

**Expected.** Playwright's own `position: {x,y}` exposed on the click spec, since the README's pitch is
"Playwright, unwrapped".

**Did instead.** `s.scroll("#grid")`, read `getBoundingClientRect()` through `s.evaluate`, then
`s.page.mouse.click(box.x+1+x, box.y+1+y)` (the `+1` is the canvas border). Verified via
`window.__gridSelected` and `getImageData`. Fine — but "unwrapped" should not stop at the option that
makes canvases addressable.

---

### 5. `open(app, { url })` silently re-navigates, destroying the state you came to look at (~3 min)

**Tried.** Probe 16 armed the session timeout and left the "Session expiring" dialog on screen.
Probe 17 started with `const s = await open("gauntlet", { url: "http://localhost:4800/" })` and
immediately asserted the dialog.

**Happened.** `dialog present: 0 state: off` — the dialog was gone. `open` had reloaded the page.
The README documents `url` as "navigate after connecting (launch) — or select the page containing it
(attach)", which reads like *ensure we are here*, not *reload unconditionally*.

**Expected.** Either "navigates every time, even when joining an existing browser" spelled out, or a
no-op when the current URL already matches.

**Did instead.** `open("gauntlet", {})` with no `url` when I wanted to inspect leftover state, and an
explicit `s.navigate(...)` when I wanted a clean slate. The README's own "state leaks between scripts —
by design" section should say which of the two `open({url})` is.

---

### 6. `run` does not advance per script, so the recon query in the README finds nothing (~2 min)

**Tried.** The README's recon recipe: `SELECT method, path, resource_type FROM requests WHERE run=<n>`.
After my second script I ran `... WHERE run=2`.

**Happened.** `(no rows)`. Everything — 25 CLI-era rows and every script since — was `run=1`, because
runs are per *browser*, not per session, and the browser is reused. For a minute I thought scripts
were not recording.

**Expected.** The README does say "A new browser starts a new run", but the recon section then says
"look at the log: `WHERE run=<n>`" as though `<n>` were obvious per session. A one-liner
(`SELECT max(run) FROM runs`, or the run number printed by `open`) would close it. `disco open` does
print `run 1` — it should probably print it on every script `open` too; my script `open()`s printed
nothing at all.

---

### 7. `body_state` is `pending` where the docs promise `missing` (~2 min)

**Tried.** The README: "disco marks such rows `body_state: missing` ('body not read by the page') after
1.5 s". I went looking for `missing` on `/api/save/status`, the textbook case (the page does
`if (r.ok)` and never reads the body).

**Happened.** `SELECT body_state FROM requests WHERE path='/api/save/status'` → `pending`, for every
row, long after the fact. `/api/login` and `/api/drag-report` likewise. `/api/sse` *did* end up
`missing`. So the promised transition happens for some rows and not others — probably it needs the
session to still be open 1.5 s later, and my scripts closed first.

**Expected.** Either the sweep to run on close, or the docs to say `pending` is the resting state for a
body that was never read if the session ends first. It matters, because "pending" reads as
"ask again later" and "missing" reads as "there is nothing to ask for".

**Did instead.** Ignored `body_state` for these and used `requests.status`, which is what the README
tells you to do anyway.

---

### 8. `s.until()` returns a failure, it does not throw — so `.catch()` around it does nothing (~2 min)

**Tried.** `const r = await s.until({...}, { timeout: 3000 }).catch(e => e)` — defensively, because
the API table lists `s.until(pred, { timeout })` with no note on failure behaviour, and every *other*
"wait" API I know rejects on timeout.

**Happened.** The `.catch` never fires; a failed wait comes back as a normal report with
`until.ok: false`. Harmless, but I wrote that useless `.catch` into a dozen probes before I was sure.

**Expected.** One line in the API table: "never throws; read `until.ok` (or wrap in `reached`)".
The `reached()` section implies it, but from the other end.

---

### 9. No `until` predicate for a WebSocket frame (~2 min)

**Tried.** Waiting for the app's `{"type":"notify",…}` frame after `POST /ctl {"push":"ws"}`.

**Happened.** The predicate table has `request`, but nothing for `ws_frames`, even though disco records
every frame and the README advertises WebSocket push as a first-class hazard. `{ request: … }` does not
match a WS message.

**Did instead.** `until: { fn: "+document.getElementById('notif-count').textContent > N" }` — i.e. I had
to wait on the DOM rendering of the frame, which is exactly the indirection `{ request }` exists to
avoid. For an app whose only channel is a socket, there is no wire-first option at all.

**Suggestion.** `{ ws: /"type":"notify"/ , dir?: "in"|"out" }`.

---

### 10. Every report carried two lines of pure noise, and there is no way to mute a region (~ongoing tax)

The gauntlet's header contains a live WebSocket frame counter. Because a click sends an action frame,
**every** report's `ui` diff contained:

```
+ - text: "ws: open · frames: 4 · ambient: off (heartbeats 0 / polls 0) · x-origin: … last ws frame: {
- - text: "ws: open · frames: 3 · ambient: off (heartbeats 0 / polls 0) · x-origin: … last ws frame: {
```

The README's "two adjacent elements glued into one aria line" gotcha covers *why* it reads badly, but
not the bigger problem: a page with any live counter poisons the aria diff of every act, and there is
no `ignore` / `scope` option to diff only a subtree. On a real dashboard this would be most of the diff.

---

### 11. The truncation hint tells scripts to use a CLI flag (~30 s, cosmetic)

`formatReport` printed `… 88 more lines (--json for all)` inside a **script**, where `--json` does not
exist. Also the truncation applies to the combined added+removed list, so a navigation (which removes
the whole previous page) drowns the two added lines I cared about. Suggest truncating each side
separately, and phrasing the hint as "see `report.ui`".

---

### 12. `POST`ing to an app's control plane is undocumented (~2 min)

The gauntlet is driven by `POST /ctl`, and every serious app has some equivalent (a seed endpoint, a
feature flag). The README has `s.evaluate(fnOrSource, arg)` but never says whether a returned promise
is awaited (it is) or shows a fetch. I guessed:

```ts
s.evaluate(`fetch('/ctl',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"modal":true}'}).then(r=>r.json())`)
```

It works and — importantly — the call lands **in the log** as a normal request, which
`s.page.request.post()` would not. That is a genuinely good property and deserves a documented line,
because the obvious alternative silently costs you the record.

---

### 13. Documentation mismatch: the "disabled control that hit-tests to its parent" (~1 min)

The root README lists among the gauntlet's hazards "a disabled control that hit-tests to its parent",
which primes you for an `occluded` diagnosis with `over: div.field-wrap`. What actually happens is
`diagnosis: disabled — #noop-disabled is disabled` in 106 ms, because the disabled check runs first.
The behaviour is better than advertised; the sentence still sends you looking for the wrong thing.
(I confirmed the hit-test claim separately: `elementFromPoint` over it returns `DIV.field-wrap` and its
`pointer-events` is `none`.)

---

### 14. The README's worked example names an endpoint the app does not have (~1 min, 5 s of waiting)

The "Keyboard-only widgets" recipe reads `until: { request: "/api/suggest", landed: true }`. I copied
the shape and the path; the gauntlet's combobox calls `/api/meds`, so the act burned its full 5 s
budget. Self-correcting — the report listed the two `/api/meds` requests that *did* land right
underneath the timeout, which is the system working as designed — but a placeholder in the docs that
looks like a real path is a trap in a repo where the example app is one command away. Consider
`"/api/<your-suggest-endpoint>"`.

---

### 15. `t` restarts every run, so the README's "newest row" one-liners are cross-run wrong (~9 min)

**Tried.** `lib.ts` read facts the way the README teaches — `s.store.latestJson("/api/rows")`,
`s.store.requests({ url }).pop()`, and for the WebSocket
`SELECT payload FROM ws_frames WHERE dir='out' ORDER BY t DESC LIMIT 1`.

**Happened.** Green on every warm run. Then I killed the browser and ran the check cold, as a stranger
would, and got:

```
FAIL 6. a click sends a WebSocket action frame (130ms):
  no action frame: {"type":"action","id":"load-fake-stream","t":1788237312303}
```

The "newest" out-frame was section 28's frame **from the previous check run**. `ws_frames.t` is
"ms since *this* run started" (the README says so, in a parenthesis), so a two-hour-old run's row at
`t = 803440` outranks the frame I had just sent at `t = 30000`. Every "latest" read in the store has
this hazard, including `latestJson` and the README's own recipe
`SELECT t_start, method, path FROM requests WHERE action_id IS NULL ORDER BY t_start`.

**Expected.** Either `latestJson` / `requests()` to default to the current run, or the docs to lead with
"filter by `run`, or better by `action_id`" instead of mentioning `run` as one filter among many. The
store is per app and outlives browsers **by design** — so cross-run contamination is the default state,
not an edge case.

**Did instead.** Two helpers in `lib.ts`, `jsonFrom(s, rep, url)` and `statusFrom(s, rep, url)`, that
scope every read to `rep.action` — exact attribution, no ordering question at all — and, for the socket,
`WHERE seq > <max seq before the act>` (`ws_frames.seq` is a global `AUTOINCREMENT`, so it is the only
monotone column in the table). Both cold and warm runs are green now. The tool already had the right
answer (`action_id`); the documentation just does not point at it as the *first* choice for wire reads.

---

### 16. Moments I did not know what to do next

- **After `POST /ctl {"push":"poll"}` produced nothing for 30 s.** Nothing in the report, nothing in
  `ws_frames`, no failing request — a channel that is simply absent looks identical to a channel that
  is broken. What unstuck me was the README's own advice to query the log
  (`SELECT … FROM requests WHERE path LIKE '%notify%'` → there was no `/api/notify-poll` row at all,
  so the client had never opened one). That is a good habit the docs teach, but "the thing you are
  waiting for was never started" deserves to be a named diagnosis on a timed-out `{ request }`
  predicate: *no request to that URL was even issued during the wait*. disco knows this. (~4 min)
- **Whether reading `/app.js` off the wire was in bounds.** The README explicitly blesses it ("The
  app's own code is on the wire … legitimate, fast"), while my instructions said to treat the app as a
  black box. I chose not to read it, and never needed to. But the two framings conflict, and a fresh
  agent will resolve the ambiguity by reading the client on minute one. (~1 min of hesitation)
- **`gauntlet/scenarios.md`.** The root README points at it as documenting "every behaviour and the
  `/ctl` knobs that drive them". For an exercise whose whole point is discovering those knobs, that
  file is the answer key, and the root README hands you the link in the same paragraph that sets the
  exam. I did not open it; everything in `README.md`/`wire.md` here was derived from driving the app.
  If the exam is meant to be closed-book, the pointer should not sit in the tool's own documentation.

---

### 17. Waits that were longer than I wanted

| Wait | Cost | Why |
|---|---|---|
| `until { request: "/api/suggest" }` (wrong path) | 5.0 s | item 14 |
| `until { fn: "window.__child…" }` for the popup | 5.0 s | item 3 |
| `until { url: "/secure.html" }` after logging in from `/` | 5.0 s | the app redirects to `next`, which was `/`. My fault, but a `{url}` timeout does not show you the URL you *did* land on until you read the report header |
| `until { selector: "#dbl-state:text-is('saved')" }` | 5.0 s | I guessed the word; it is `committed: <value>` |
| `until { text: "Save failed" }` on a successful save | 3.0 s | deliberate negative test |
| `POST /ctl {"push":"poll"}` with `notify:false` | 30.0 s | item 15 — my budget, but nothing could have shortened it except knowledge |
| `s.click("#rerender")` without `js:true` | 3.1 s | correct behaviour: Playwright's actionability wait, then a perfect `detached` diagnosis naming the fix |

Total ≈ 56 s of dead waiting across ~75 acts. Every one of them was my predicate being wrong, and in
five of the seven cases the report told me exactly why. That part of the promise holds.

---

### 18. What worked so well it deserves saying

- `diagnosis: unclickable — pointer-events: none on li#med-opt-1 — the app wants the keyboard
  (type / ArrowDown / Enter)` and `diagnosis: detached … try { js: true }` each replaced an entire
  debugging session with one line. Same for `occluded … over: div#record-modal.overlay` naming the
  overlay that a *previous* step had armed.
- `not-found` listing the visible controls turned a wrong selector into an oriented one instantly.
- Wire-first reads (`store.latestJson("/api/rows")` for 10 000 virtualised rows;
  `requests.status` for a save whose screen lies) are the difference between a workflow that works and
  one that scrapes. This is the tool's best idea.
- Cross-origin iframe traffic, child-window traffic and `set-cookie` all landing in one queryable log,
  with no configuration, is the reason `wire.md` took ten minutes to write.
