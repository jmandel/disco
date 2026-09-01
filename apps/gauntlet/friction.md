# friction — driving the gauntlet with disco

Every place the tool or the README got in my way, numbered, with what I tried, what happened, what I
expected, what I did instead, and the cost. The app itself is a deliberately hostile test target, so
some of these are the app being tricky rather than disco being wrong — I flag which is which.

---

### 1. `./disco sql` uses `t_start`, but the README's one-liners use `t` (tool docs wrong/misleading). ~3 min
- **Tried:** the recon query from the README's "Working an unfamiliar app": essentially
  `SELECT method, path, resource_type FROM requests WHERE run=<n>` — and, extending it, `SELECT t, method, path ...`.
- **Happened:** `Error: no such column: t` and a full Node stack trace dumped to stderr.
- **Expected:** the README (log section) says "Every row has `run` and `t` (ms since the run started)", and
  the `ws_frames`/`console`/`dialogs`/`nav` tables *do* have a column literally named `t`. So `t` reads as universal.
- **Reality:** the `requests` table names its time columns `t_start` / `t_response` / `t_end`, not `t`. Only the
  other tables have `t`. `./disco schema` revealed this.
- **Did instead:** used `round(t_start)` everywhere for requests.
- **Fix wanted:** either add a `t` alias/view on `requests`, or have the README note that `requests` uses
  `t_start`. A raw stack trace for a bad column is also heavier than it needs to be.

### 2. A bad SQL column prints a Node stack trace, not a diagnosis (tool). ~1 min
- **Tried:** the above bad query.
- **Happened:** ~10 lines of `file:///…/src/store.ts:232 … ERR_SQLITE_ERROR` internals.
- **Expected:** a one-line "no such column: t (columns are: …)".
- **Did instead:** ran `./disco schema` to get column names.

### 3. `{url:"/secure.html"}` / `/secure\.html$/` fire `alreadyTrue` on the login page (app trap + a real
   predicate sharp edge). ~6 min
- **Tried:** login workflow with `until: { url: "/secure.html" }` and later `{ url: /secure\.html$/ }`.
- **Happened:** `until: ✓ ... 1ms ALREADYTRUE` while still on the login page; the click never actually waited
  for navigation and my code thought it had logged in.
- **Why:** the login URL is `http://localhost:4800/login.html?next=/secure.html`. The substring `/secure.html`
  (and even the string *end* `secure.html`) is present in the **query string**, so both a `contains` and an
  end-anchored regex match the login page.
- **Expected:** the README warns to "choose one that is false beforehand", but a URL predicate matching the
  *query string* of the previous page is a subtle way to violate that.
- **Did instead:** used `{ fn: "location.pathname === '/secure.html'" }`, which ignores the query string.
- **Fix wanted:** a README note that `{url}` matches the whole href including the query string; consider a
  `pathname` convenience or an example of exactly this trap.

### 4. `{request:"/api/save/status", landed:true}` never lands because the page never reads the body (tool
   behavior + app trap). ~10 min — the single biggest time sink.
- **Tried:** the README's own headline example for optimistic UI:
  `s.click("#save", { until: { request: "/api/save/status", landed: true } })`, budget 8000 ms.
- **Happened:** `until:FAIL ... err=response to request /api/save/status landed did not finish within 8000ms`,
  even though the response is a tiny `{"id":3,"ok":true}` that (I later confirmed by fetching it directly)
  returns in ~3 ms. In the store the row is `status=200` but `body_state=pending` forever.
- **Why:** the client does `const status = await fetch("/api/save/status?id="+id)` and then only reads
  `status.ok` (the HTTP-ok flag) — it **never** calls `.json()`/`.text()`. Chromium therefore never surfaces
  the body over CDP, so disco's `landed` (body finished) predicate can never be satisfied.
- **Expected:** the README pitches `{ request, landed: true }` as *the* tool for "the outcome behind an
  optimistic 'Saved ✓'" — this is exactly that scenario, and it's the case where it silently never fires.
- **Did instead:** anchored on the toast the client *does* render: `[role=status]:has-text('Saved')` /
  `'Save failed'`. Confirmed the endpoint's real bodies by fetching them from inside the page with `evaluate`.
- **Fix wanted:** `landed` should also resolve when the response *completes on the wire* even if the page
  never reads the body (or there should be a `{ request, responded: true }` that waits only for headers/status).
  At minimum, document that `landed` depends on the page consuming the body.

### 5. `:has-text('…')` is a substring match and bit me twice (app trap + expectation). ~4 min
- **a) `#unload-armed:has-text('armed')`** fired `ALREADYTRUE` because the initial text is "un**armed**".
- **b) save-failure test:** `any:[{selector:"[role=status]:has-text('Saved')"...}]` fired `ALREADYTRUE`
  because the previous success toast (still visible for `toastMs`=2000) matched.
- **Expected:** I read `has-text` too literally as "the word".
- **Did instead:** cleared stale toasts with `until:{gone:"[role=status]"}` before re-checking, and chose
  more specific text. This is genuinely documented Playwright behavior; a one-line reminder in the disco
  README ("`has-text` is a substring, case-sensitive") would have saved me the round trip.

### 6. Re-render race: an ordinary click is unwinnable; nothing in the docs points to the escape hatch (app
   trap). ~5 min
- **Tried:** `s.click("#rerender")`, then again with `rerenderOnHover:false`.
- **Happened:** both time out at 3 s: `element was detached from the DOM, retrying` / `element is visible,
  enabled and stable` then timeout. The button is `replaceWith`-ed every 100 ms (and on hover), so Playwright
  resolves a node that is gone before it clicks.
- **Expected:** the README lists "a re-render race" as a covered behavior but gives no recipe.
- **Did instead:** dispatched the click programmatically — `s.evaluate("document.getElementById('rerender').click()")`
  — which works because the real click handler is delegated on `#rerender-host` and survives the swaps.
- **Note:** this is a legitimate "use `s.evaluate` / `s.page` when the wrapper is in your way" moment, which
  the README does bless in general terms — but a "widgets that re-render under you" line in the gotchas would help.

### 7. Mouse-drag widgets need `s.page.mouse` and manual scroll-into-view; there is no `s.drag` (tool gap).
   ~6 min
- **Tried:** first attempt dragged the slider/sort with `s.page.mouse.move/down/up` using
  `getBoundingClientRect` coords, without scrolling the section into view.
- **Happened:** no movement (`slider-value` stayed 0) — the target section was below the fold, so the
  viewport coords didn't land on the element.
- **Did instead:** `evaluate("…scrollIntoView({block:'center'})")` first, then `page.mouse`. Worked
  (`slider-value` 61, `sort-order` b,c,a; both POST `/api/drag-report`).
- **Also:** the `{request:"/api/drag-report", landed:true}` postcondition only fires if armed *before*
  `mouse.up()` — I armed it after and it timed out (my error, but a reminder that request predicates only see
  post-arm responses would help). There is no drag sugar; `s.page.mouse` is the only path.

### 8. Virtualized-list re-render is on the async `scroll` event, so a synchronous read after setting
   `scrollTop` sees stale DOM (app trap + expectation). ~4 min
- **Tried:** `evaluate("rows.scrollTop=5000")` then immediately read the first mounted row.
- **Happened:** still showed row 0. The list re-renders in a `scroll` handler that hadn't fired yet.
- **Did instead:** `until:{fn:"…firstChild.dataset.id !== <before>"}`. After it, first mounted row is 203,
  ~28 nodes of 10000. Fine once you wait on the DOM effect rather than the scroll assignment.

### 9. Poll push silently does nothing unless `notify:true` (app trap; docs thin). ~5 min
- **Tried:** `POST /ctl {push:"poll"}` and waited for `#notif-count` to advance (ws and sse worked instantly).
- **Happened:** 6 s timeout, no notification.
- **Why:** the `/api/notify-poll` long-poll loop only runs when ctl `notify:true` (the ws and sse channels are
  standing from load; the poll one is not). I found this only by reading the app's own served `app.js` off the
  wire (`syncNotify` guards on `state.notify`).
- **Did instead:** set `{notify:true, notifyPollHoldMs:800}` then pushed poll — delivered in ~2 ms.
- **Note:** the section text says "standing channels live from load", which is true for ws/sse but not poll.
  This is the app's `scenarios.md`/`/ctl` territory, which I was told not to read; the section copy on the page
  is slightly misleading.

### 10. Reading the app's own `app.js` was necessary to resolve #4 and #9 (method note, not a disco bug).
- To explain the un-landing save/status and the poll channel, I read `/app.js` — but it is the app's own
  client, served over the wire and captured in the store (`./disco body <hash>`), not disco's `src/`. So this
  stayed within "work from the wire", and I did not open anything under `src/`. Calling it out for honesty:
  I did not manage to characterize save's async outcome or the poll channel from the *report* alone; I needed
  the client source. A black-box-only agent would have been stuck on both.

### 11. Report `ui` diff concatenates sibling text nodes, which made me misread which element updates
   (expectation). ~3 min (cost the one initial check failure).
- **Observed:** `+ - text: "status: idle Chart loaded (3 responses)"`. I read this as "`#chart-status`
  became 'Chart loaded'".
- **Reality:** `#chart-status` stays `idle`; the "Chart loaded (3 responses)" text is a *separate* sibling
  (`#chart` div). The aria line glues adjacent text together.
- **Cost:** my first `run-check` failed on the chart step (anchor `#chart-status:has-text('Chart loaded')`
  timed out) until I re-read the aria and switched the anchor to `#chart`.
- **Fix wanted:** nothing actionable in disco necessarily, but a caution that aria `text:` lines can merge
  adjacent nodes would help calibrate how much to trust them as element anchors.

### 12. No `sleep`, and I honored it — but two "standing" waits are long and only tunable via the app's own
   ctl (observation). 
- The notify long-poll default hold is 25 s (`notifyPollHoldMs`) and the ambient poll 3 s (`pollHoldMs`).
  Nothing in disco sleeps, but characterizing these means either lowering them through `/ctl` (app-specific)
  or budgeting a long `until`. For a generic app with no such knob, a slow standing channel would force a
  long `until` budget. Not a disco fault; noting the shape of the problem.

### 13. `appsDir` must be passed explicitly from a script run outside the repo root (minor). ~2 min
- **Tried:** `open("gauntlet", { url })` from a scratch script; the default `appsDir` is `./apps` relative to
  the *process cwd*, and my agent shell resets cwd between calls.
- **Did instead:** passed the absolute `appsDir` in every `open`. Worked. The README documents the default
  and `$DISCO_APPS_DIR`; just a reminder that "./apps" is cwd-relative, which matters for scripts.
