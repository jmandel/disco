# friction — driving OpenMRS 3 with disco (one session, ~65 min)

Format: what I tried · what happened · what I expected · what I did instead · cost.
Ordered roughly by how much they cost me. Nothing here is a complaint about the app; it is
about disco and its README.

---

## 1. `./disco sql` truncates every text column, silently, with no way to widen it — 4 min

**Tried:** `./disco sql "SELECT b.hash, substr(b.text,1,600) FROM bodies b JOIN requests r ON …"`

**Got:**
```
hash	substr(b.text,1,600)
744d661942874dd9…	{"results":[{"patientId":9,"uuid":"32351061-0a24-4fc2-a3d3-0251870330d2","voided":false,"identifiers":[{"display":"CR…
```
The `…` is disco's, not SQLite's — my `substr(…,1,600)` was honoured and then the *printer* cut the cell
at ~110 chars.

**Expected:** the 600 characters I asked for, or a documented flag to control the width.

**Instead:** piped `--json` into `node -e` for everything, all session. Every single body inspection in
this session went through a five-line node one-liner.

**Docs:** the README's "Useful one-liners" section shows exactly this kind of query
(`SELECT method, path, status FROM bodies_fts …`) with no hint that the output is column-clipped, and
`--json` is documented only under the CLI reference as "prints the report as data" — its usefulness for
`sql` is not mentioned. One sentence would have saved the four minutes:
*"`sql` clips cells for the terminal; use `--json` when you need the value."*

---

## 2. Nothing in the README warns that `{ url }` and heading predicates are *routinely* already-true in a SPA, and the cost lands on a cold run — 9 min

**Tried:** `until: { any: [{ request: … }, { url: "/home/service-queues" }] }` and, for chart tabs,
`{ any: [{ request: … }, { selector: 'role=heading[name="Conditions"]' }] }`.

**Got (warm run PASS, cold run FAIL):**
```
FAIL service queues dashboard (1896ms): open Service queues: until route was already true before
  the action — it proves nothing; wait for something that is false beforehand
FAIL conditions tab: FHIR Condition bundle (868ms): chart tab conditions: until heading was already
  true before the action — it proves nothing …
```

**Expected:** these are the two predicates the README's "Working an unfamiliar app" section *encourages*
(`{ url }` for route changes, a heading as "the landmark of the next screen"). In a micro-frontend SPA
both are traps: `/spa/home` redirects to `/home/service-queues` so the route arm is true before you
click, and the patient-summary dashboard renders cards headed "Conditions"/"Vitals"/"Allergies" so the
heading is true before you open those tabs.

**Instead:** wire-only predicates plus an explicit `s.page.url().includes(...)` short-circuit.

**Worse:** the two failures were **not reproducible warm** — the same code passed 9/9 warm and failed
cold, because whether the summary card had painted by arming time is a race. `alreadyTrue` is the right
mechanism and it did its job; what is missing is a README line saying *a dashboard that pre-renders the
same widgets your tabs contain makes every DOM predicate already-true — use the wire.*

---

## 3. A `{ request }` predicate against an SWR-cached SPA costs the full budget with no early diagnosis — 7 min

**Tried:** `s.click('nav a[href$="/chart/conditions"]', { until: { request: "/fhir2/R4/Condition?patient=", landed: true }, timeout: 20000 })`

**Got:** `PASS conditions tab: FHIR Condition bundle (20957ms)` — twenty-one seconds, every time, because
`patient-summary` had already fetched that bundle and the tab re-rendered from cache with **zero**
requests.

**Expected:** the README does flag this ("A second visit may issue no request … write such waits as
`any: [{ request }, { selector }]`"), and it also promises *"the diagnosis says whether a matching
request was issued at all"*. That diagnosis is only useful **after** the budget is gone. On a shared
demo box where `SLOW` has to be 20 s, one cached tab is 20 s of a 23 s check.

**Instead:** I probe the log before acting —
`s.store.requests({ url: family, status: 200, run: s.run }).length > 0` → budget 4 s instead of 20 s.
That worked, but it is a pattern the README should own: **"if the family already answered in this run,
expect a cache hit and shorten the budget."** The suggested `any: [{request},{selector}]` does *not*
solve it here, because the DOM arm (§2) is already-true.

---

## 4. `./disco eval` produces no act and its traffic is unattributed — 3 min

**Tried:** `./disco eval "fetch('/openmrs/ws/rest/v1/session',{headers:{Authorization:'Basic '+btoa('admin:definitely-wrong')}}).then(r=>r.status)"`

**Got:** `200`. No `act:` line, no report. Later, wanting to cite that probe in `wire.md`, I found the
rows only as `action_id IS NULL` (`r1-981`, `r1-982`) and had to reconstruct which they were by
grepping `req_headers` for the base64.

**Expected:** the README's *"Calling the app's API yourself"* paragraph says `s.evaluate("fetch(…)")`
"lands in the log like any other request" — true, but it lands **unattributed**, which is the opposite of
the attribution guarantee the rest of the document sells. The `actions` table has no `eval` kind at all.

**Instead:** cited the request ids. Fine, but the docs should say "an `evaluate` is not an act; its
requests have `action_id IS NULL`" — or `eval` should open a window like every other command.

---

## 5. `./disco aria <selector>` needs a Playwright selector, but the docs' phrasing invites a role name — 2 min

**Tried:** `./disco aria banner` (the thing I wanted was the `banner` node the previous `aria` had printed).

**Got:** `error: aria: no element matches banner`

**Expected:** the README says `s.aria(selector?)` — "the page (or one element) as the accessibility tree
sees it". Since the *output* of `aria` is a tree of role names, passing a role name back in is the
obvious move; it silently means "the CSS element `<banner>`". `role=banner` works. A one-word example in
the CLI reference (`./disco aria 'role=banner'`) would close this.

---

## 6. A loading skeleton satisfies every structural predicate — 5 min

**Tried:** `s.click('a[href*="/home/patient-lists/"]', { until: { any: [{ selector: 'table' }, { selector: '[role=dialog]' }] } })`

**Got:** `until: ✓` in ~1 s, and an aria tree of a *complete* table — `columnheader`×5, `row`×6,
`cell`×25 — all with empty accessible names, under `heading "--"`. The real data arrived several
seconds later.

**Expected:** the README's "spinners that lie" gotcha covers spinners; it does not cover the modern
skeleton, which is worse — it is structurally indistinguishable from the loaded screen and defeats
`selector`, `text` and `gone` predicates alike.

**Instead:** waited on `cohortm/cohortmember`. My follow-up attempt to express "the heading is no longer
`--`" as `{ selector: 'h1:not(:has-text("--"))' }` returned `until.ok: false` while the loaded heading
("nini") was plainly on screen — `:not(:has-text())` does not compose the way you would guess, and the
README's selector-gotchas section discusses `:has-text` substring matching but not its negation.

---

## 7. Invalid mixed selectors fail as a silent `until` timeout, not as a parse error — 3 min

**Tried:** `{ selector: 'input#username, role=textbox[name="Username"]' }` (I wanted "either one").

**Got:** `until.ok: false`, `until.which: undefined`, no error text, no diagnosis I could act on — it
simply never matched, and I initially concluded that `/spa/login` had redirected me away.

**Expected:** the README warns that mixing engines within a segment is "a raw Playwright parse error at
click time" for `role=button[name='Save'] >> css=svg`. A comma-joined CSS+role selector is the same
mistake and produces no error at all inside an `until`.

**Instead:** one engine per predicate, and separate `any` arms when I want alternatives.

---

## 8. `./disco schema` does not print what the README's log section promises to name — 2 min

**Tried:** `./disco schema | grep -A25 "CREATE TABLE requests"` (README: "`./disco schema` prints the DDL").

**Got:** nothing — the DDL says `CREATE TABLE IF NOT EXISTS requests`. My grep, not disco's fault, but:
the README's `st.requests(...)` field list ("id, t_start, method, url, path, status, mime, body_hash,
body_size, body_state, req_body, resp_headers, action_id…") **omits `req_headers`**, which is the column
the same README tells you to use for token auth ("token → `req_headers`"). I only found it by dumping
the DDL.

---

## 9. Waits that expired, and why

| Wait | Budget | Why it expired |
|---|---|---|
| `until --until-text "Login Location"` (act:6) | 3 s | my guess; this deployment has no location picker. Deliberately short — the README's advice to keep probe budgets at 1000–1500 is the single best piece of advice in it |
| `{ request: "/fhir2/R4/Condition?patient=" }` on the Conditions tab | 20 s | SWR cache hit, §3 |
| `{ selector: 'h1:not(:has-text("--"))' }` | 8 s | selector semantics, §6 |
| `{ selector: 'input#username, role=…' }` | 20 s → returned fast but false | invalid selector, §7 |

Nothing else ever hit a ceiling. dev3 is slow but honest: chart routes 1–8 s, searches ~200 ms,
the 259 K visits payload ~1.5 s.

---

## 10. Moments I did not know what to do next

- **After the first cold-vs-warm divergence** (§2). Two runs of the same code, different results,
  and the failing predicate was one the README recommends. I had no way to ask disco *"is this
  predicate already true right now?"* other than running it and reading the refusal. A
  `s.until(pred, { timeout: 0 })` idiom — or having `where()`-style assertions documented as the
  legitimate use of a bare `until` — would have made this a ten-second check. (I did eventually confirm
  that a **bare** `s.until()` is *not* flagged `alreadyTrue`, so it can be used as an assertion —
  but that asymmetry between `act`-with-`until` and bare `until` is nowhere in the README, and I only
  learned it by having `reached(await s.until(anchor))` pass 9/9.)
- **Choosing between `navigate` and clicking the SPA nav.** The README says to prefer the app's own
  navigation "a click keeps the app's state and caches". That is exactly what made my chart-tab
  predicates unreliable (§3) — the cache is the problem. For library entry points I ended up
  navigating; for tabs I click. Nothing in the docs helps you make that call.
- **Whether an app-initiated `POST` violates a read-only stance.** Opening a chart writes
  `userProperties`. There is no disco affordance for "warn me before the page writes"
  (`s.page.route` could block it, but then the app misbehaves). I documented it instead.

---

## 11. Small things

- `report.requests[].size` is `null` for rows whose body had not landed at report time; the README
  documents `[body pending]` in the printed line but the *data* field just goes null, so a script that
  prints `${x.size}B` emits `nullB`. Worth saying "read `state`".
- The `run-check` output line `openmrs: run 1, page …` reports the run of the *browser*, not of the
  check, so after `./disco close` + rerun it said `run 2`, `run 3`, `run 4` — useful, but the act ids in
  `apps/openmrs/store` then span runs and `act:9` exists four times. The README's "Newest is per run"
  warning covers reads; it does not warn that **act ids repeat across runs**, which makes citing
  `act:9` in documentation ambiguous unless you also cite the run.
- `apps/README.md` step 5 says to run the check "warm, then after `./disco close <app>` cold. Both green
  before you write the README." That is the right instruction and it caught both of my bad predicates —
  it deserves to be in the root README too, not only in `apps/README.md`.

---

# Pass 2 — friction while *writing* (continuing the numbering)

## 12. The `occluded` diagnosis names the right element but the README's advice for it is wrong for the commonest case — 6 min

**Tried:** `reached(await s.click('role=radio[name="Female"]'))` on the registration form.

**Got:**
```
Error: act:249: occluded — role=radio[name="Female"] is covered by
  span.cds--radio-button__appearance [shot 6d9ada7cffb0]
```

**Expected:** the README's diagnosis table says of `occluded`: *"another element is under the pointer
(`over`) — **usually a dialog** — `dialogs` lists open ones; dismiss it, then retry."* There was no
dialog. This is Carbon Design System, which every OpenMRS 3 screen is built from: the real
`<input type=radio>` is `opacity:0` under a styled `<span>`. **Every radio and checkbox in the entire
application** fails this way — sex, visit type, allergy reaction, allergy severity, queue priority,
list selection. Following the documented advice (look for a dialog to dismiss) leads nowhere.

**Instead:** `{ js: true }`, wrapped as a `tick()` helper. The right README line is one clause:
*"…or a design system that hides the real input under a styled span (Carbon, MUI): `{ js: true }`."*
The `unclickable` row already says something like this for `pointer-events: none`; `occluded` needs the
same treatment, because the diagnosis text (`covered by span.cds--…__appearance`) is enough to tell
the two situations apart automatically.

**Credit where due:** the diagnosis *named the covering element and its class*, which is exactly what
turned this into a one-line rule instead of a hunt.

## 13. Three kinds of overlay, and no way to ask which one opened — 25 min across the pass

**Tried:** `s.click('role=menuitem[name="Add to list"]', { until: { selector: 'role=banner[name="Workspace header"]' }, timeout: 15000 })` — because every other "open a form" in this app is a workspace.

**Got:** the full 15 s, then
```
timeout — until role=banner[name="Workspace header"] did not happen: locator.waitFor: Timeout 15000ms exceeded.
  dialogs: ["div \"Add patient to list\""]
```

**Expected:** "Add to list" to behave like the other nine launchers. It is the one that opens a Carbon
**modal** instead of a workspace. Ten minutes earlier the same mistake in reverse cost 10 s:
`New list` → I guessed `role=dialog`, and it is a workspace.

**Instead:** anchor on a *field* of the form (`role=searchbox[name="Search for a list"]`,
`role=textbox[name="List name"]`) rather than on the container. That is the general lesson and it
belongs in the README: **anchor on the control you are about to use, not on the chrome around it.**

**What would have saved the time:** the diagnosis *did* print `dialogs: ["div \"Add patient to list\""]`
— the answer was in the failure. But it only appears after the budget expires. A cheap "what is on
screen that wasn't before" — the bare-act `ui` diff — is available for 700 ms, and I should have used a
bare act first. The README says exactly this ("Act bare, read the report") and I skipped it because the
app had been predictable for an hour. Cost: my own fault, but the asymmetry is real — a *wrong* `until`
costs its whole budget, while a bare act costs 700 ms and tells you what to wait for.

## 14. `alreadyTrue` again, and this time it is about a control that never leaves — 5 min

**Tried:** `s.click('role=button[name="Save order"]', { until: { selector: 'role=button[name="Sign and close"]' } })`.

**Got:** `save order to basket: until role=button[name="Sign and close"] was already true before the
action — it proves nothing`.

**Expected:** "Save order" returns you from the order form to the basket, so I waited for the basket's
button. But the basket panel is never unmounted — it sits behind the order form the whole time.

**Instead:** `{ gone: 'role=button[name="Save order"]' }`.

**Pattern worth a README line:** in a stacked-panel UI, *the thing you are leaving* is the reliable
predicate, not the thing you are arriving at. Three of my four `alreadyTrue` refusals across both passes
were this shape. `reached()` catching them is the single best thing in disco — but the docs frame
`alreadyTrue` as a footnote about "a heading, not *a* heading", when it is really the dominant failure
mode on a component-framework SPA.

## 15. `latestJson` cannot read a write — 8 min

**Tried:** `s.store.latestJson("/ws/rest/v1/patient/", report.action)` to get the patient the app just created.

**Got:** the body of a **GET** — because registration navigates to the new chart on success, and the
chart's `GET /ws/rest/v1/patient/<uuid>?v=custom:(…)` starts inside the same act window and is newer
than the POST.

**Expected:** the README's log section is entirely read-shaped: `latestJson(family, act)` = "the parsed
body of the newest matching response — scope it to the act whose report showed it". Scoping to the act
is not enough when the act contains both your write and the reads it triggered. `jsonAll` does not help
either — "pick by shape" is exactly what you should not have to do when the *method* is the discriminator.

**Instead:** `s.store.requests({ url: family, method: "POST", action, run: s.run })` and then
`s.store.json(row.body_hash)` — wrapped as `written()` / `writtenRow()` in `lib.ts`. It works and it is
five lines, but every agent characterising a write-capable app will write those same five lines.
`latestJson(family, act, { method })` — or a `st.written(family, act)` — is the missing helper.

## 16. `{ request: "/ws/rest/v1/visit" }` cannot distinguish a POST from a GET — 4 min

**Tried:** waiting for the visit to be created with `until: { request: "/ws/rest/v1/visit", landed: true }`.

**Got:** it works *here*, but only by luck: the start-visit workspace happens not to re-GET
`/visit?patient=` inside that window. On the order flow the same predicate would have resolved on the
`GET /visit?patient=…` that the basket fires, and I would have read the wrong body.

**Expected:** the `until` predicate table documents `{ request, landed }` as URL-matching only. There is
no `method` field. For an app where reads and writes share a path (`/visit`, `/encounter`,
`/patient/`, `/cohortm/cohort/`) that is a real gap — and `/encounter` is used by **two different
writes** in this app (vitals and orders).

**Instead:** every write function waits on the URL family and then *asserts the POST row exists*,
throwing a specific error if it does not (`no POST /visit response in act:261`). Safe, but it is a
postcondition expressed in two places. `{ request: "…", method: "POST" }` would collapse it to one.

## 17. A script that forgets `s.close()` hangs forever with no message — 3 min

**Tried:** a throwaway probe ending in `console.log(await s.aria(...))` with no `await s.close()`.

**Got:** nothing. The process sat there until my 180 s tool timeout killed it; the output I wanted had
already been produced but was never flushed to me because the command never exited.

**Expected:** the README's quickstart does show `await s.close()`, so this is my omission — but the
failure mode is maximally unhelpful (no message, no timeout, no hint that a CDP connection is holding
the loop open). A one-line note — *"a Session keeps the process alive; `close()` in a `finally`"* —
next to the quickstart would pay for itself. Every probe script after this one used `try/finally`.

## 18. `s.aria(selector)` throws instead of diagnosing — 2 min

**Tried:** `console.log(await s.aria('main'))` on the registration page.

**Got:** an uncaught `Error: aria: no element matches main` that killed the whole probe script,
losing the three acts that had already run.

**Expected:** `aria` is the *reconnaissance* tool — the thing you reach for precisely when you do not
know what is on the screen. Every other "I guessed wrong" path in disco returns a diagnosis
(`not-found` even lists the visible controls); `aria` is the one that throws. When the guess is wrong
you get nothing at all, not even the page you were trying to look at.

**Instead:** `./disco aria` with no selector and `sed -n '/marker/,$p'`. Fine, but the natural fix is
for `aria(selector)` to fall back to the whole page with a note, or at least to say what *does* match.

## 19. `disco sql` clipping (item 1) is worse for writes — 2 min

The request bodies are the whole point of documenting a write, and `req_body` is long. Every
`SELECT … req_body …` had to go through `--json | node -e`. Item 1 again, but the cost repeats once per
workflow rather than once per session. (`./disco body <hash>` covers *response* bodies; there is no
equivalent for request bodies, which are stored inline in the `requests` row.)

## 20. Waits that expired in this pass, and why

| Wait | Budget | Why |
|---|---|---|
| `until: { selector: 'role=dialog' }` on "New list" | 10 s | it is a workspace, not a modal (§13) |
| `until: { selector: 'role=banner[name="Workspace header"]' }` on "Add to list" | 15 s | it *is* a modal (§13) |
| `until: { request: "conceptsearch" }` on the condition typeahead | 12 s | I guessed the endpoint name. **The diagnosis then printed the request that actually arrived** — `GET /ws/rest/v1/concept?name=Headache&searchType=fuzzy&class=…` — which is disco at its best: the failure handed me the answer |
| `role=button[name="Sign and close"]` while the basket item was *Incomplete* | ~100 ms | not a wait at all: `disabled`, diagnosed instantly. This is the promise table working exactly as advertised |

Total budget burned on wrong predicates in this pass: **~40 s**. Total spent driving the nine write
workflows: about 20 minutes. The ratio is the argument for bare-act-first, which I under-used.

## 21. Moments I did not know what to do next (pass 2)

- **After "Sign and close" came back `disabled`.** The basket said `status "Incomplete"` and I had no
  idea what completes an order. Nothing on the screen says "open the order form"; I found it by
  clicking the order's *name*. A `not-found`-style list of "what is enabled right now" would have
  helped, but honestly the app is at fault here, not disco.
- **Deciding what "verify off the wire" should mean.** The POST response is already "the wire", but it
  is the app's own echo. I settled on an independent GET issued via `s.evaluate("fetch(…)")` — which
  the README explicitly blesses for carrying cookies and landing in the log — and that turned out to be
  the right call twice: the order's `orderNumber` and the allergy's FHIR-side identity only exist on a
  re-read. Worth stating in the README as the write-verification pattern, because "assert on the POST
  response" is the tempting shortcut and it hides exactly the fields the server fills in.
- **How much to write.** Nothing in disco or its docs helps you bound blast radius on a shared demo:
  no dry-run, no "show me the request you are about to send", no per-session write log. I ended up
  querying `SELECT method, path, status FROM requests WHERE run=6 AND method='POST'` after every
  workflow to keep an inventory. That query is genuinely good and belongs in the README's one-liners
  as *"what did I change?"*.
