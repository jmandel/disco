# friction — where disco or its README got in my way

Format per item: **what I tried · what happened · what I expected · what I did instead · what it cost.**
Ordered roughly by cost. Total session ≈ 85 min; I estimate ~22 min of it went to the items below.

---

### 1. WebSocket frames are invisible unless the socket opened inside *your* session (~10 min)

**Tried.** `SELECT t,dir,payload FROM ws_frames ORDER BY seq DESC LIMIT 10` after ~30 acts, each of
which (per the app's own header counter) had sent a WS frame.

**Happened.** Two rows, both from `act:1`:
```
146 in act:1 {"type":"hello","id":1,…}
140 open act:1 null
```
`#ws-count` in the page header said `frames: 5`. Nothing in the report, the diagnosis, or the log said
"this channel is not being observed".

**Expected.** The README sells `{ ws, dir? }` as a first-class predicate for "push channels — the
notification itself, not its rendering", and sells joining a running browser as a feature ("a second
script joins the same browser and the same run"). Nothing warns that the two do not compose.

**Instead.** Navigated to `/` *inside* the session (`s.navigate(HOME, { until: … })`) to force a fresh
socket; frames appeared immediately (`out {"type":"action",…}` / `in {"type":"echo",…}`). `lib.ts:goHome()`
now always navigates for this reason, and it is gotcha #3 in the pack README.

**Fix I'd want.** Either capture frames for pre-existing sockets, or make `{ ws }` fail loudly:
"no WebSocket has been observed in this session — reload the page to attach". A silent 5 s timeout on a
channel that is demonstrably alive is the worst possible outcome.

---

### 2. `s.drag(a, b)` on an adjacent list item silently does nothing, and the README says it reorders (~6 min)

**Tried.** `s.drag("#sort-a", "#sort-b", { until: { fn: "…#sort-order… !== 'a,b,c'" } })`, straight from
the README: *"`to` is an element (Playwright `dragTo`: one straight move, which reorders a list by one
slot)"*.

**Happened.** `until` timed out after 5 s. The wire showed `POST /api/drag-report 200` — i.e. the app
*did* see a complete drag — but the order was unchanged. A second attempt with a hand-rolled 8-step
`s.page.mouse` path also failed.

**Expected.** The README's parenthetical reads as a guarantee. It is really "one straight move to the
centre of the element you name" — which for the *adjacent* item never crosses its midpoint, so nothing
moves.

**Instead.** `s.drag("#sort-a", "#sort-c")` → `b,a,c`. One slot, as promised, but you must aim two
slots away.

**Fix I'd want.** Say so: "`dragTo` releases at the target's centre; to move one slot, target the item
*two* slots away, or use `s.page.mouse` with `{ steps }`."

---

### 3. `s.type()` appends; the sugar table does not say so (~5 min + a 5 s timeout)

**Tried.** `s.type("#med", "asp", { until: { request: "/api/meds?q=asp", landed: true } })` on a field
that already contained `Aspirin` from the previous step.

**Happened.** Three requests `q=Aspirina`, `q=Aspirinas`, `q=Aspirinasp`, then
`until: ✗ 5003ms … no request matching /api/meds?q=asp was issued during the wait`. The diagnosis is
excellent — it told me no matching request was issued — but the wire lines above it were the only clue
as to why.

**Expected.** The table says `s.fill` "sets the value (one input event)" and `s.type` "keystrokes — for
debounced/keyboard widgets". Reasonable to read as "types this text into the field".

**Instead.** `s.fill(target, "")` before every `type`. It is now a recipe line in the pack README.

**Fix I'd want.** One word in the table: "keystrokes, **appended** to the current value".

---

### 4. One un-dismissed interstitial cascades into a dozen 1–3 s failures in `run-check` (~4 min)

**Tried.** First full `node scripts/run-check.ts gauntlet`.

**Happened.** `2 record WITH a delayed modal` failed to notice a modal that arrived 600 ms late, leaving
`div#record-modal.overlay` open. The next **eleven** steps then failed with
`occluded — #save is covered by div#record-modal.overlay`, each burning its own actionability budget
(one burned 5 s, two burned 3 s). 17 failures, ~14 s of it pure timeout, from one root cause.

**Expected.** The diagnoses were perfect — every one named the overlay and the open dialog, which is why
the fix took two minutes once I read them. But there is no way to say "if a step fails, stop" or "run
this recovery before each step".

**Instead.** Read the first failure, ignored the rest, fixed `openRecord`'s grace window.

**Fix I'd want.** `run-check --bail`, or a documented `beforeEach` hook in `check.ts` (the README shows
`check(s, step)` and nothing else about the harness — not whether failures abort, not what `step`
returns).

---

### 5. `{ selector }` without `visible: true` matches hidden nodes — the predicate table implies otherwise (~3 min)

**Tried.** `until: { selector: "#ctx-menu li" }` to wait for a right-click menu to open.

**Happened.** `alreadyTrue` — the `<li>`s live in the DOM inside a `<ul hidden>` before the menu opens.

**Expected.** The table row reads *"`{ selector, visible?, frame? }` — an element matches (**and is
visible**)"*. That parenthetical reads as a description of the predicate, not as a description of what
happens only when you pass the optional flag.

**Instead.** `{ selector: "#ctx-menu li", visible: true }`.

**Fix I'd want.** Rewrite the row as "an element matches; **add `visible: true`** to require visibility".

---

### 6. Rejoining an app whose previous script left a popup open drives an unclear page (~4 min, unresolved)

**Tried.** Script A did `s.click("#open-child", { until: { page: "child" } })` and exited without
`closeOtherPages()`. Script B did `open("gauntlet", { url: "http://localhost:4800" })`.

**Happened.** `s.context.pages()` in script B reported **two** pages, *both* at `http://localhost:4800/` —
i.e. something navigated the popup (which had been at `/child.html`) to `/`. The log shows an extra act
with its own page load (`hello id:2`) that I never issued. I could not tell from any report which page
`s.page` was.

**Expected.** The README covers state leaking ("a second script joins the same browser where the last one
left it… close popups you opened") and `page: 0`, but not that `open(..., { url })` may pick and navigate
a *popup*, nor that `/child.html` "contains" `http://localhost:4800/` for URL-matching purposes.

**Instead.** `s.closeOtherPages()` at the top of the next script and `closeOtherPages()` inside
`openChildWindow()`. Never established which page was actually driven.

**Fix I'd want.** Have `open` print which page it selected (`page 1 of 2: http://…/child.html`), and say
in the README that `url` on a rejoin selects a page by substring and *will* navigate a popup.

---

### 7. Table columns are not in the README, and a wrong column dumps library source at you (~2 min)

**Tried.** `s.store.sql("SELECT id,t,dir,payload FROM ws_frames …")` — `id` because `requests` has `id`.

**Happened.**
```
file:///…/src/store.ts:232
  const sql = (q, ...args) => db.prepare(q).all(...args);
                                   ^
Error: no such column: id
```
An uncaught SQLite error that prints six lines of disco's own (type-stripped, unreadable) source. In a
task whose ground rule is "do not read `src/`", the tool put `src/` on my screen.

**Expected.** The README lists the tables and says "`./disco schema` prints the DDL", which is true and
which I then ran. But the tables' *shapes* differ in a way worth one sentence: `requests` has `id`,
everything else keys on `seq`.

**Instead.** `./disco schema`, then `seq`.

**Fix I'd want.** Catch SQLite errors in `store.sql` and rethrow as
`store.sql: no such column "id" in ws_frames (columns: run, seq, t, url, dir, payload, action_id)`.
Also: `store.sql()` accepts bind parameters (`sql(q, ...args)`) — undocumented; I only learned it from
that stack trace, which is a bad way to learn an API.

---

### 8. Shadow DOM is claimed to work but never shown (~2 min)

**Tried.** `s.click("#shadow-host >> internal:control=enter-frame")`, guessing at a frame-like syntax
because `s.frame("#a >> #b")` is the documented way into nested things.

**Happened.** `diagnosis: error — locator.count: Selector cannot end with entering frame, while parsing
selector …` — a raw Playwright parse error.

**Expected.** The README mentions shadow DOM exactly twice ("frames and shadow DOM work" in Tests, and
"shadow DOM" in the gauntlet's feature list) and never says how.

**Instead.** Discovered by experiment that the root is open and plain CSS pierces it
(`#shadow-host #shadow-btn`), and that state inside the root needs `until: { fn }` through
`.shadowRoot` because the aria diff cannot see it.

**Fix I'd want.** One line in *Selector gotchas*: "Open shadow roots are pierced by ordinary CSS;
closed ones are not reachable. Contents do not appear in the aria diff."

---

### 9. `reached()` is the only documented way to consume a report, but optional checks need the other way (~2 min)

**Tried.** Handling the optional allergy modal: I want "look for `#record-modal` for 1.2 s and tell me
yes or no", which must *not* throw.

**Happened.** Every example in the README wraps acts in `reached()`, and `reached()` throws on both
failure and `alreadyTrue`. Nothing shows the non-throwing idiom.

**Expected.** An example of the "optional" case, given that the README's own *Interstitials* section is
built entirely around conditional dialogs.

**Instead.** `const r = await s.until({ selector: "#record-modal" }, { timeout: 1200 }); if (r.until?.ok) …`.
Works fine; it just is not written down anywhere.

---

### 10. A long-poll's report shows the *new* pending request, not the one that answered you (~1 min of doubt)

`s.until({ request: "/api/notify-poll", landed: true })` returned in 126 ms and the report's wire section
read `GET /api/notify-poll … [pending]`, which looks like a failure. The row that landed is the
*previous* one (visible in `requests` with `t_end` set); the page reissues the poll instantly, and the
reissue is what started inside the window. Correct per "attribution is a time window", but the report
reads as if the thing you waited for never arrived. A `[landed]` marker on the row the `until` matched
would remove the doubt.

---

### 11. Two failures produced the identical `shot` hash (~1 min of doubt)

`act:24` (not-found inside `#same-origin`) and `act:25` (not-found inside `#cross-origin`) both reported
`shot 8aa8da6ed8e9c515`. Content-addressed dedup is sensible, but when you are using shots as evidence of
a *moment* it reads like a bug. Worth one sentence in *Diagnoses*.

---

### 12. Credentials: the README's auth advice points at the form, not the endpoint (~2 min)

*"Log in with an `until: { url }` (or `any` of the landing anchor and the error banner)"* assumes you
already have credentials. I burned two minutes guessing at a login form before doing the obvious thing:
`s.evaluate("fetch('/api/login', …)")` in a loop over candidate pairs, reading statuses off the wire —
which found `admin/admin` on the first try and (later) revealed that **any** non-empty pair works. The
README's own "Calling the app's API yourself" trick deserves a cross-reference from the auth section.

---

### 13. The 5 s default `until` budget is the cost of every wrong guess (no fix, just the number)

Six of my failed predicates cost 5 s each and two cost 3 s: ~36 s of the session was spent waiting for
budgets on predicates I had already gotten wrong. That is the design working as advertised ("no wait is
longer than the number you wrote"), and every one of those failures came with a diagnosis that told me
why — but the honest number for an unfamiliar app is *a wrong `until` costs five seconds*, and on a
30-step check that adds up fast. I'd default `until` to 3000 and tell people to raise it per step.

---

### 14. `apps/README.md` (4 lines) adds nothing (~0 min, but it is a missed opportunity)

It says "one folder per app; see the root README". Since this file is the first thing an agent reads
after the root README, it could carry the *starting* checklist instead: run `./disco open`, dump the
endpoint map, read `body` of the main document, write anchors first. That sequence is in the root
README's prose but nowhere as a list.

---

## What worked so well it is worth recording

- **The diagnoses are the product.** `occluded` naming `div#record-modal.overlay` *and* the open dialog,
  `detached` telling me to use `{ js: true }`, `not-found` inside a frame listing that frame's controls
  (which is literally how I discovered `#if-name`/`#if-submit`) — every one of these saved a debug cycle.
- **`alreadyTrue` as a hard rejection in `reached()`** caught two predicates of mine that were proving
  nothing (a stale `#login-error`, a leftover `#notif-list li`). Both were real bugs in my code.
- **Wire-first reads were the only way to be right** about the save outcome, the 10 000 rows, and the
  cross-origin frame — exactly as advertised.
- **`body_state` distinguishing `missing` / `streaming` / `ok`** turned two of this app's traps
  (the never-read status body, the mislabeled event-stream) into one-line answers.
