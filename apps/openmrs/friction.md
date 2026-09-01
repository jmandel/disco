# friction.md — driving dev3.openmrs.org with disco, 2026-09-01

Format: **what I tried · what happened · what I expected · what I did instead · cost.**
Ordered roughly by how much they hurt. Wall clock for the whole job (recon -> app folder -> green check) was **16 min**; roughly **6 min**
of that was friction cost, and item 1 shaped how every later probe had to be written.

---

### 1. There is no way to see the page. Only the *diff*. — ~5 min + shaped the whole session

**Tried:** `./disco until --until-text "Login" --timeout 20000` — the obvious first move on an
unknown login screen.
**Got:**
```
act:2 until  ok  20072ms (act 0 · until 20010 · report 6)  https://dev3.openmrs.org/openmrs/spa/login
  until: ✗  20001ms — locator.waitFor: Timeout 20000ms exceeded.
    timeout — until text "Login" did not happen
```
The screen says *Username* and *Continue*; it never says "Login".
**Expected:** to be able to ask "what is on this page?" before guessing. The README's recon recipe
(`apps/README.md` step 2) is *"Read the shell off the wire: `SELECT body_hash … resource_type='document'`
→ `./disco body <hash>`. Section ids and control names come for free."* For this app the document is
**3.3 KB of empty single-spa shell** — no sections, no controls, no names. That advice is written for
server-rendered apps and silently fails on every SPA, which is most of what an agent will be pointed at.
**Did instead:** `./disco screenshot` + `./disco eval "document.body.innerText.slice(0,600)"` — 0.3 s,
and the answer. Then for the rest of the session I used a scratch script calling
`s.page.locator("body").ariaSnapshot()` and wrote it to a file, because:
- `report.ui` is only the **diff**, and it truncates (`… 272 more (267 added, 40 removed; report.ui has them all)`);
- from the CLI there is no way to get "them all" — the hint `report.ui has them all` is only actionable
  from a script;
- `ariaSnapshot()` is never mentioned in the README, even though the report is built out of it.

**Ask:** `./disco aria [selector]` (full accessibility tree of the current page) and a sentence in
"Working an unfamiliar app" saying that for an SPA the document body is empty and the aria tree is the
substitute. This single missing command is the difference between a 0.3 s and a 20 s first question.

---

### 2. The `not-found` diagnosis suggests a selector that cannot work — ~2 min

**Tried:** `s.click("button:has-text('Search patient')")`.
**Got:**
```
act:9 click button:has-text('Search patient')  FAILED  1199ms
  diagnosis: not-found — no element matches button:has-text('Search patient')
    visible controls: …, button "Change location", button "Search patient", button "Implementer Tools", …
```
**Expected:** if the diagnosis prints `button "Search patient"` as a *visible control*, a selector
built from that string to match. It cannot: the candidate list prints **accessible names**, and O3's
header buttons are icons with `aria-label` and **no text node**, while `:has-text()` matches text
content. The diagnosis and the fix speak different languages.
**Did instead:** `role=button[name='Search patient']` — worked first try.
**Ask:** print candidates in a form you can paste — `role=button[name="Search patient"]` — or add one
line to the `not-found` row of the diagnosis table: *"candidates are accessible names; use
`role=…[name=…]`, not `:has-text()`, unless you can see the text on screen."*

---

### 3. Wire reports are unreadable on a chunk-loading SPA — ~3 min, every single act

**Tried:** reading the report of a chart navigation.
**Got:** `wire (2)` … `… 215 more (sql: SELECT * FROM requests WHERE action_id='act:15')`, where the
25 printed lines were 22 hashed `.js`/`.css` chunks and 3 pending API calls. One `navigate` on this app
is **220 requests**, ~95 % of them static assets.
**Expected:** some way to say "just the XHR/fetch". `requests` has `resource_type`, the README's own
endpoint-map one-liner filters on it — but nothing on the report or the CLI does.
**Did instead:** wrote my own filter in every probe script:
`formatReport(r).split("\n").filter(l => !/\.js |\.css |\.woff/.test(l))`, and dropped to
`s.store.requests({ action }).filter(q => /\/ws\//.test(q.path))` for anything real.
**Ask:** a `--wire xhr` / `wire: "xhr"` report option, or simply rank `xhr|fetch` rows above
`script|stylesheet|font|image` rows before truncating at 25.

---

### 4. `latestJson` returns `undefined` for "cached, no request" and for "no such request" alike — ~3 min

**Tried:** `openChartTab(s, uuid, "conditions")` returning `s.store.latestJson("/fhir2/R4/Condition?patient=", act)`;
`check.ts` asserted `body.resourceType === "Bundle"`.
**Got:** `FAIL chart tab: Conditions round-trips through FHIR (245ms): conditions body is not a FHIR Bundle`.
The real cause: the app's SWR cache had the Condition bundle from the patient-summary widget, so the
tab issued **no request at all**. `latestJson` returned `undefined` with no way to tell that from
"the request happened but the page never read the body" (`body_state: missing`), which the README
discusses at length as a *different* failure.
**Expected:** `latestJson` to be documented on the miss path, or to throw/return a discriminated result.
**Did instead:** documented `body: null` as "the tab was cache-served" and made the check assert
`body === null || body.resourceType === "Bundle"` plus an independent `fetch`-in-page re-read.
**Ask:** one line in the log section — *"`latestJson` returns `undefined` when nothing matched; use
`store.requests(...)` to tell 'no request' from 'no body'."*

---

### 5. The lazy SPA does its real work between your commands — ~4 min of wrong conclusions

**Tried:** `p7.ts` clicked into a chart with `until: { url: "/chart" }`, closed the session, then a
separate `p8.ts` waited for the content and I ran `SELECT … FROM requests` over the run.
**Got:** no `Condition`, `Observation` or `AllergyIntolerance` rows anywhere — I briefly concluded the
chart rendered from cache. It hadn't: the chart's ~40 API calls fired in the ~2 s gap **between** the
two sessions, when nothing was recording.
**Expected:** the README does say *"The CLI records only while a command runs — between commands,
nothing is written"* — so this is documented. What is not said is the consequence that bites on every
lazy-loading SPA: **your `until` holds before the interesting traffic starts**, so a
`navigate → close → reopen → inspect` loop systematically loses the payload you came for.
**Did instead:** one script per question, holding the session open across `navigate` **and** the
content anchor, then reading `s.store.requests({ action })`.
**Ask:** put that consequence next to the sentence — *"an `until` that holds on a route change is
before the data; keep one session open across both, or run `./disco record`."*

---

### 6. A guessed anchor costs the full budget, twice — 50 s

**Tried:** probing four unknown home apps with a generic anchor
`until: { selector: "main h1, main h2, main h3, main h4" }, timeout: 25000`.
**Got:** `appointments` ✓, `ward` ✓, `patient-lists` ✗ 25 s, `laboratory` ✗ 25 s — both are tab-first
screens with no heading in `<main>`.
**Expected:** my own fault; the README explicitly says *"While exploring, pass a short timeout
(1000–1500) to probes whose outcome you are unsure of."* I had raised the session default to 25 s for
this slow server and the probe inherited it. The trap is that **`open(app, { timeouts: { until } })`
silently becomes the exploration budget**, so the "short probe" advice quietly stops applying the
moment you accommodate a slow server.
**Did instead:** bare `navigate` first, dump `[...document.querySelectorAll('main [role=tab],main button')]`,
then anchor. Recorded `role=tab[name='Starred lists']` / `role=tab[name='Tests ordered']`.
**Ask:** README "Timeouts": *"raising `timeouts.until` for a slow server also raises the cost of every
wrong guess — pass an explicit short `timeout` on probes."*

---

### 7. `ORDER BY seq` on `requests` — ~1 min

**Tried:** `./disco sql "SELECT … FROM requests … ORDER BY seq"`.
**Got:** `error: no such column: seq  (./disco schema lists the tables and columns; requests uses t_start/t_end, other tables t)` — an excellent error message.
**Expected:** the README says both *"`requests` is keyed by `id`; every other table by `seq`"* (correct)
and, two paragraphs later, *"order by `seq` (or `run, t_start`)"* in a passage about ordering wire rows
(wrong for the only table that passage is about).
**Did instead:** `ORDER BY run, t_start`.
**Ask:** drop `seq` from the "Newest is per run" sentence, it is about `requests`.

---

### 8. `./disco close` orphans the CLI from a store that is still perfectly readable — ~1 min

**Tried:** `./disco close openmrs`, then `./disco sql "SELECT … FROM actions"` to gather act ids for
this write-up.
**Got:** `error: no app: pass --app <name> or run 'disco open' first`.
**Expected:** the log is a file; reading it should not need a browser. The message's first branch
(`--app <name>`) is right, but it is offered as an alternative to `disco open`, which implies you need
a browser again.
**Did instead:** `./disco --app openmrs sql "…"` — works fine.
**Ask:** say that `close` clears `apps/.current`, and that `--app` is all a read needs.

---

### 9. Column aliases silently shadow real columns in `disco sql` — ~1 min

**Tried:** `SELECT run, id, kind, substr(target,1,60) t FROM actions ORDER BY t`.
**Got:** rows ordered by the *alias* (the target text), not by time, with no warning — output looked
plausibly wrong (all navigates, then all fills).
**Expected:** SQLite behaviour, not disco's fault. Worth one line in the log section anyway, because
`t` is disco's universal time column and a two-character alias is the natural thing to type.

---

### 10. `alreadyTrue` fired twice on selectors that *look* conditional — 0 cost, credit where due

`until: { selector: "[role=alert]" }` on the login page (an empty live region is always there) and
`until: { selector: "role=button[name='Logout']" }` on the account menu (the menu is always in the DOM
and always `visible` — the header only slides it into view). Both were caught instantly and by name.
Without that flag I would have written a `logout()` that "worked" and proved nothing. **This is the
feature that most earned its place.**

---

## Things the README got exactly right on this app

- `{ request, landed: true }` on the debounced search box — the postcondition that made
  `searchPatients` deterministic on the first attempt.
- `s.evaluate("fetch(…)")` running with the page cookie *and* landing in the log — on an API-first app
  like this it is half the tool.
- `reached()` messages carrying the diagnosis: every `check.ts` failure in this session explained
  itself without a second run.
- "Never anchor on the URL" is not stated, but *is* implied by "prefer a specific element"; this app
  punishes URL anchors hard (`{ url: "/chart" }` holds ~2.5 s before the chart exists) and it would be
  worth an explicit line in **Gotchas** about client-side routing.
