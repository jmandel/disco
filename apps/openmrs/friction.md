# friction — driving dev3.openmrs.org with disco

Everything below happened while characterising OpenMRS O3 in one session (2 runs, ~140 acts,
~35 minutes of tool time). Ordered roughly by cost. I never had to open `src/`.

---

### 1. The CLI silently loses most of a SPA's traffic, and `apps/README.md` recommends the CLI first

**Tried:** followed `apps/README.md`'s first-hour recipe — `./disco open`, `./disco click`,
`./disco sql "SELECT method, path, resource_type FROM requests …"`.
After 8 CLI acts including opening a patient chart, the endpoint map was:

```
GET /openmrs/ws/rest/v1/visit    11
GET /openmrs/ws/rest/v1/obs       8
GET /openmrs/ws/rest/v1/session   3
…20 rows total
```

**Expected:** the chart's traffic. **Happened:** the chart loaded *between* two CLI invocations, so
none of its ~25 requests were recorded. The same single screen, re-driven from a script, logged 30
xhr rows in one window. The root README does say "The CLI records only while a command runs" and
mentions `./disco record`, but it is a parenthetical under *What is recorded when*, while
`apps/README.md` step 1–3 is an explicitly CLI-first recipe. On an app whose every screen keeps
fetching for 2–3 s after the click returns, that recipe produces a map with holes and no warning
that it is incomplete.
**Did instead:** threw away the CLI recon and redid everything as scripts (one `Session` open for the
whole pass). **Cost:** ~5 minutes and a wrong first impression of the app's API surface.
**Fix I'd want:** `apps/README.md` step 1 should be "open a script session (or `./disco record` in a
second terminal) — the CLI is for one-off probes", or the CLI should warn when a page is still
loading at disconnect.

### 2. `until: { any: [...] }` does not flag `alreadyTrue`, and it made me believe a successful login had failed

**Tried:**
```ts
await s.click("role=button[name='Log in']", { until: { any: [
  { url: "/spa/home", label: "home" },
  { text: "Invalid username or password", label: "bad-credentials" } ] }, timeout: 25000 });
```
**Happened:** `until.ok true, which "bad-credentials", elapsedMs 16, alreadyTrue undefined` — and the
login had in fact *succeeded*. The failure toast from a previous probe was still on screen; the arm
was true before the click.
**Expected:** the README says flatly "A predicate that is already true when you act is flagged
`alreadyTrue`" and `reached()` "throws when the `until` was `alreadyTrue`". Neither happened for an
`any` arm. Whether `any` is meant to be excluded is not stated anywhere.
**Did instead:** made `login()` navigate to a fresh login document every time, so no stale toast can
exist. **Cost:** ~4 minutes, and I nearly wrote "login is broken" into the notes.

### 3. `occluded` did not name what covered the element — and the same element passed `visible`

**Tried:** `s.click("role=button[name='Logout']", { until: { selector: loginBox } })` after
`until: { selector: "role=button[name='Logout']", visible: true }` had reported `alreadyTrue`.
**Happened (check output, verbatim):**
```
FAIL log out …: logout: occluded — locator.click: Timeout 3000ms exceeded. | Call log:
  - waiting for locator('role=button[name=\'Logout\']').first()
    - locator resolved to <button … class="-esm-login__logout__logout___fmll0 cds--btn cds--btn--ghost">Logout</button>
    - attempting click action
      - waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
 [shot 6313f2adec11]
```
**Expected:** the promise table says `occluded` gives "`diagnosis: disabled / hidden / occluded`
naming what covers it" and the diagnosis table says "another element is under the pointer (`over`)".
The `reason` was right but the message was Playwright's timeout text with no `over` element — the one
field that would have answered the question. `dialogs` was empty (correctly: it is not a dialog).
The element is a Carbon slide-out panel parked at `x: 1280` in a 1280-wide viewport — off-screen to
the right, yet `visible: true`.
**Did instead:** wrote a throwaway `s.evaluate` probe dumping `getBoundingClientRect()` and class
names before/after clicking `My Account`, and found `.cds--header-panel--expanded` by hand.
**Cost:** ~5 minutes. **Fix I'd want:** put `over` in the message, and/or say in the diagnosis table
that an element translated outside the viewport still passes `visible` — `offscreen` would have been
the honest reason here.

### 4. Guessing a `request` predicate costs the whole budget, and the diagnosis will not tell you what did arrive

**Tried:** `./disco type "role=searchbox[…]" "Barbara" --until-request /openmrs/ws/rest/v1/search/patient --landed --timeout 10000`
**Happened:** 10.1 s, then
```
until: ✗ 10003ms — page.waitForResponse: Timeout 10000ms exceeded …
  timeout — until request /openmrs/ws/rest/v1/search/patient landed did not happen … — no request
  matching /openmrs/ws/rest/v1/search/patient was issued during the wait
```
The report's own `wire (3)` block two lines below showed `GET /openmrs/ws/rest/v1/patient?q=Barbara…`.
**Expected:** the README promises "the diagnosis says whether a matching request was issued at all,
and with what status". It does — but it stops there. The diagnosis knows the window's requests (they
are printed right under it); listing them *inside* the diagnosis, the way `not-found` lists
`candidates`, would have turned a 10 s dead end into a 10 s answer.
**Did instead:** read the `wire` block. **Cost:** 10 s wasted and a habit change (always run one bare
act per screen before writing any `request` predicate). Two later guesses cost 9 s each
(`fhir2/R4/Observation` on a cached tab, `Procedure` when the endpoint is REST `/v1/procedure`).

### 5. There is no way to wait for "the request, or nothing at all" — a cache hit always costs the full budget

**Tried:** `chartTab()` waits `until: { request: <tab endpoint>, landed: true }` after the route
changes. Four of the chart's tabs were already fetched by the patient-summary screen, so react-query
serves them with **zero** requests and the predicate can only expire.
**Expected:** the README anticipates exactly this ("A second visit may issue no request") and says to
"wait on the DOM and read the body from the log" — but the DOM anchor for these tabs *is* the data,
which may be legitimately empty, so there is nothing false-then-true to wait on. And there is no
predicate meaning "no matching request within N ms".
**Did instead:** kept the budget at 2.5 s and reported `fromCache: true` when it expires — i.e. I pay
2.5 s per cached tab, every run, to learn a fact disco already knows.
**Cost:** ~10 s per `check.ts` pass, forever. **Fix I'd want:** `until: { quiet: <pattern>, forMs: N }`,
or let `any` arms include a "budget elapsed" arm so the expiry is a result rather than a failure.

### 6. `store.latestJson` is the wrong tool when one screen calls one endpoint twice

**Tried:** `s.store.latestJson("queue-entry?", r.action)` on the Service queues screen, which showed
three patients in "Attending".
**Happened:** `{results: []}` — `totalCount 0`. The screen fires `queue-entry` **twice** in the same
act, and the *newer* response is the empty "waiting" filter (29 B); the rows on screen came from the
earlier 29 KB body.
**Expected:** the README's guidance is "scope wire reads to the act that produced them
(`action: report.action`)". That is exactly what I did, and it does not help — both calls are in one
act. Nothing in the docs warns that "latest" can be the wrong one *within* an act.
**Did instead:** selected by `body_size DESC` in SQL. **Cost:** ~3 minutes, and I briefly wrote down
"the queue is empty" for a screen that visibly was not.

### 7. `Report.requests[]` item shape is undocumented

**Tried:** `(r.requests||[]).forEach(q => console.log(q.method, q.url, q.status))`
**Happened:** `GET undefined 200 undefined` — `method` and `status` exist, `url` does not.
**Expected:** the README documents the *printed* wire line and the `requests` **table** columns
(`id, t_start, method, url, path, status, …`), so I assumed the report array carried the same field
names. The report table entry just says "`requests` | the app's own traffic started in the window".
**Did instead:** stopped using `report.requests` entirely and read the log with SQL scoped to
`window.t0/t1`. **Cost:** ~2 minutes. **Fix I'd want:** one line naming the fields, or make them the
`RequestRow` fields.

### 8. `s.aria(selector)` returns an empty string for a selector that matches nothing — no error, no hint

**Tried:** `await s.aria("body > div, main")` (a comma list, because I did not know which container
held the appointments app).
**Happened:** empty output. Twice, on two different screens, before I realised the call — not the
screen — was the problem.
**Expected:** either the union of matches, or a "no match" signal. The README says
"`s.aria(selector?)` — the page (or one element)" and nothing about multi-match or no-match.
**Did instead:** `./disco aria` with no selector and grepped. **Cost:** ~2 minutes and one wasted
script run.

### 9. Mixing selector engines without `>>` fails at click time with a raw Playwright parse error

**Tried:** `s.click("#omrs-workspaces-container role=button[name='Close']")`
**Happened:** `close workspace: error — locator.count: Unexpected token "=" while parsing css
selector "#omrs-workspaces-container role=button[name='Close']". Did you mean to CSS.escape it?`
**Expected:** the README's `target` line does say selectors are "chained with `>>`", but every
example in the document is single-engine, and the `frame:` option's `"#outer >> #inner"` reads like
the `>>` is a *frame* thing. The failure surfaces as `reason: error` with Playwright's message
rather than as a disco-level "did you mean `>>`?".
**Did instead:** `"#omrs-workspaces-container >> role=button[name='Close']"`. **Cost:** ~2 minutes
(one failing `run-check` pass). **Fix I'd want:** one scoped example in the `target` line, e.g.
`"#panel >> role=button[name='Close']"`.

### 10. `./disco body <hash>` prints the body for text, the *path* for a screenshot — and the README says both

**Tried:** `P=$(./disco body 24cd60f44e47b6fd); head -c 2500 "$P"`
**Happened:** `head: cannot open '{"authenticated":true,…}' for reading: File name too long`
**Expected:** the *Diagnoses* section says "`shot` (JPEG blob hash; `./disco body <hash>` prints its
path)" while the quickstart says "`./disco body 7a3f2c1e` — a captured body by hash prefix". Both are
true, for different content types, and neither says so.
**Did instead:** piped the command's stdout directly. **Cost:** ~1 minute. **Fix I'd want:** say the
rule (text → stdout, binary → path), or add `--path`.

### 11. `resource_type` values are never listed

**Tried:** the README's own recon one-liner uses `resource_type IN ('xhr','fetch')` and the report
mentions "documents, xhr/fetch, streams, sockets" and `static` "scripts, stylesheets, images, fonts".
I needed `document` to see navigations and guessed it.
**Expected:** `./disco schema` gives the DDL, not the domain of a text column. **Cost:** ~1 minute of
guessing. **Fix I'd want:** list the values next to the `requests` table description.

---

## Waits that expired, and why

| Wait | Budget | Why it expired |
|---|---|---|
| `--until-request /ws/rest/v1/search/patient --landed` | 10 s | guessed endpoint name; the real one is `patient?q=` (item 4) |
| `{request:"fhir2/R4/Observation"}` on the vitals tab | 9 s | already fetched by patient-summary — react-query cache (item 5) |
| `{request:"Procedure"}` on the procedures tab | 9 s | that tab is REST `/v1/procedure`, not FHIR; case-sensitive substring |
| `{request: spec.req}` on 4 cached chart tabs | 2.5 s each, every run | item 5 — unavoidable with the current predicate set |
| `role=button[name='Logout']` click | 3 s (action) | off-screen panel; `visible` said yes (item 3) |

Nothing else ran long. dev3 answered every read in 50–900 ms; the only slow thing is a full SPA
document load (~3 s), and `timeouts.until` never needed to go above 30 s.

## Moments I did not know what to do next

* **After the first chart click**, `./disco aria` showed a screen full of widgets and the log showed
  almost nothing (item 1). I could not tell whether the app was quiet or disco was not looking.
  Nothing in the report says "I stopped recording"; the report's `window` closed and that was that.
* **When the workspaces stopped reacting.** After four side-rail clicks the aria diff went empty for
  every subsequent click. The panels had *stacked* — four workspace containers in the DOM, one
  visible — and the report has no vocabulary for "you already opened this". I found it with an
  `evaluate` dumping class names. The root README's *State leaks between scripts — by design* covers
  page/dialog state; a panel stack inside one page is the same hazard and reads the same way
  (clicks that "do nothing").
* **Choosing between "click the tab" and "navigate to the tab URL."** Both work; one is 200 ms and
  cache-poisoned, the other is 3 s and always truthful. The README's cache paragraph names the
  hazard but gives no rule of thumb, so I had to measure both and decide per workflow.
