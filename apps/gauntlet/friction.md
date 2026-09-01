# friction — driving the gauntlet with disco

Every place the tool or the README got in the way, numbered, with the exact command, what
happened, what I expected, what I did instead, and the rough time cost.

---

### 1. `requests.size` doesn't exist; the column is `body_size` (~30 s)

- **Tried:** `./disco sql "SELECT ... mime, body_state, substr(body_hash,1,12) h, size, action_id FROM requests ..."`
- **Happened:** `error: no such column: size  (./disco schema lists the tables and columns; requests uses t_start/t_end, other tables t)`
- **Expected:** the report prints a size column for every wire row (`... 6086`, `100B`), so I reached for `size`.
- **Did instead:** `./disco schema` → the column is `body_size`. The error message was good and pointed me straight there.
- **Doc note:** the report's wire line labels the last field "size"; the column is `body_size`. A one-word note in the schema section ("the report's `size` is `body_size`") would remove the guess.

---

### 2. Leftover pages from a previous script throttle the next one to ~3 s per click (~6 min — the biggest sink)

- **Tried:** a plain batch of `s.click("#noop", { window: 0 })` in a fresh script.
- **Happened:** every click's `actMs` was ~3000 ms (`act:45 click #noop ok=true act=2970`). Nothing in the report explained why; there was no error, no diagnosis — just slow.
- **Diagnosed:** a `requestAnimationFrame` probe showed 5 frames took **5041 ms** (throttled to ~1 s/frame). `s.context.pages()` still listed `http://localhost:4800/child.html` — a popup opened by an *earlier* script (act:36) that I never closed. disco reuses the same browser across script runs, so the orphaned popup left the main page backgrounded and rAF-throttled; Playwright's "element stable across frames" actionability check then costs multiple seconds per click.
- **Fixed:** closed the stray page (`for (const pg of s.context.pages()) if (pg.url().includes('child.html')) await pg.close()`) and/or `s.page.bringToFront()` → back to 67 ms for 5 frames and ~100 ms clicks.
- **Doc gap:** the README stresses "the browser keeps running / a second script joins the same browser," but never warns that **leftover popups (or a backgrounded main page) silently throttle everything**, and that a slow `actMs` with no diagnosis usually means rAF throttling. This deserves a line in "Gotchas" and, ideally, disco flagging "N background pages open" in the report when `actMs` blows the actionability budget. Cost me the most time because there is no signal — the action just gets slow.

---

### 3. Context-menu item click: a `position:fixed` element below the fold gives an unhelpful `timeout`, and the fix (`js:true`) isn't discoverable from it (~5 min)

- **Tried:** `s.click("#ctx-rename", { until: { selector: '#ctx-result:has-text("Rename")' } })` after `rightclick #ctx-target`.
- **Happened (in `run-check`):** `FAIL context menu ... timeout — locator.click: Timeout 3000ms exceeded ... - scrolling into view if needed`. The **same call had passed** in an earlier ad-hoc session, so it looked flaky.
- **Root cause:** `#ctx-menu` is `position: fixed` at the pointer's viewport Y (`menu.style.top = e.clientY`). When `#ctx-target` sits low on the page, the menu opens near the bottom and its items fall below the viewport; Playwright's "scroll into view" can't move a fixed element, so it spins until the budget expires. Whether it worked depended on the scroll position at right-click time.
- **Expected:** for an occlusion/positioning problem, a `diagnosis: occluded` (with the fixed element named) or `hidden`, not a bare `timeout` — and a pointer to the remedy.
- **Did instead:** read the CSS body (`./disco body 2a3bd7d123`) to find `position:fixed`, then clicked with `js: true` (dispatched event, no actionability/scroll; the handler is delegated on `#ctx-menu`). Now deterministic.
- **Doc gap:** `js:true` is documented only for the *re-render/detached* case ("widgets the app replaces faster than a real click"). It is equally the fix for **a fixed/off-screen element with a delegated handler**. The diagnosis table's `timeout` row ("read message and shot") didn't get me there; the message said "scrolling into view" but not "this element is fixed and can't be scrolled."

---

### 4. `until: { url: "/" }` (and `"/secure.html"` while still on the login URL) is already true (~2 min)

- **Tried:** `s.click("#login", { until: { url: "/" } })` — the login script does `location.href = next` where `next="/"`.
- **Happened:** `until: ✓ url / 2ms  ⚠ already true before the action` — because the current URL was `…/login.html?next=/` which *contains* `/`. The click "passed" without proving the navigation.
- **Expected:** I knew the substring rule from the README, but `"/"` is a pathological case (every href contains it) that is easy to write by reflex.
- **Did instead:** waited on the **destination landmark** (`#who` for the secure page, `#load-chart` for the shell). `lib.ts login()` does this.
- **Doc note:** the README does warn about the query-string substring rule; a concrete "never use `{url:'/'}`; wait on the destination element" example would have saved the reflex. Minor.

---

### 5. Combobox mouse-click diagnosis names the section as the occluder, not the real reason (~1 min, low cost because the README warned me)

- **Tried:** `s.click("#med-list li >> nth=0", ...)` on a suggestion.
- **Happened:** `diagnosis: occluded ... over: <section id="s-17">` after a 3 s actionability timeout.
- **Reality:** the list itself calls `preventDefault()` on `mousedown`/`click`, so the option can never be clicked; it's a keyboard-only widget. The `over: <section#s-17>` is technically the top element at the point but misattributes the cause.
- **Did instead:** used the keyboard recipe (`type` → `ArrowDown` → `Enter`), which the README's "keyboard-only widgets" section had already told me to expect. Cheap because I was forewarned.

---

### 6. No documented way to pretty-print a Report from a script (~1 min)

- **Tried:** looked in the README API for a formatter to log a report in a probe (the CLI prints one, scripts get the object).
- **Happened:** the API section documents the report's *textual format* but not a function that produces it. I introspected the module (`Object.keys(import('../src/index.ts'))`) and found `formatReport`, which is exported but undocumented.
- **Did instead:** `import { formatReport } from ".../src/index.ts"` and logged `formatReport(r)` throughout discovery — invaluable, and it should be in the "From a script" quickstart.

---

### 7. Scripts reuse the browser *and* whatever state the last script left (design, but a repeated trap) (~2 min cumulative)

- **Observed:** `open("gauntlet", {})` with no `url` attaches to the existing page wherever the previous script left it (mid-modal, on `/secure.html`, with a child window open, with `ctl` knobs still flipped). Several probes started from a dirty state (e.g. a record modal already up, or `saveFails` still true from a prior run).
- **Did instead:** every workflow in `lib.ts` starts with `assertShell`, and `check.ts` opens with `resetCtl(s)` + `gotoShell(s)`. Knob-flipping helpers restore their knob (`clickRerender`, `pushNotification`).
- **Doc note:** the README explains reuse for *joining* a run but doesn't emphasize that **state leaks between scripts** — recon scripts should reset (`/ctl/reset`, `navigate`) at the top, and this pairs with #2 (a leftover popup is part of that leaked state).

---

### 8. `s.store.requests()` / `RequestRow` shape isn't in the README (~1 min, guessed right)

- **Tried:** to read the save outcome I wrote `s.store.requests({ url: "/api/save/status" })` then `rows[rows.length-1].status`.
- **Happened:** worked, but I was guessing the field name — the README lists the *SQL columns* and the `store` helper *methods*, but not the TS shape returned by `st.requests(...)`. I matched the DB column name (`status`) and it happened to be right.
- **Doc note:** a one-line `RequestRow` shape (or "fields mirror the `requests` columns") next to the `st.requests(...)` bullet would remove the guess.

---

## Things that worked well (for balance)

- `until: { request, landed: true }` + `s.store.latestJson(...)` is the cleanest way to read
  API-first data; used for chart/records/search/rows/meds/graphql/iframes/delete.
- The `any`-of predicate made the conditional allergy modal a non-issue (`openRecord`).
- `body_state: missing` is exactly right for `/api/save/status` and `/api/drag-report`, and the
  status code being preserved meant I could still assert the real save outcome.
- Diagnoses for `disabled` (#noop-disabled, ~100 ms) and `detached` (#rerender, with the "try
  { js: true }" hint) were fast and correct — the re-render hint saved real time.
- `./disco body <script-hash>` to read `/app.js` was the single highest-leverage move: it turned
  every "why is this silent?" into a two-minute read.
