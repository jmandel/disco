# Using disco — a field guide

How to wield disco to **instrument, explore, discover, characterize, and automate** a web application you
did not build. This is the *usage* guide (design philosophy + how to use it well, with examples). For the
constitution and the discovery methodology see `GUIDANCE.md`; for what the project *is* and where it's
going, `PLATFORM.md`; for the hard-won engine gotchas, `DECISIONS.md` #16–39.

The worked examples are the three product packs: `apps/gauntlet/lib.ts` (a synthetic hostile app),
`apps/openemr/lib.ts` (OpenEMR 8.3.0) and `apps/saucedemo/lib.ts` (a React SPA with no API). Read them
alongside this. Every report excerpt below is real output of `bun demos/03-two-questions.ts`, which
`bun test` executes — the examples cannot rot.

## The mental model (four ideas)

1. **Every action is an experiment that returns a report — read it, don't guess.** You never "click and
   wait 30s for a selector." You `act()`, and the report tells you what actually happened: a verdict
   (`no-effect` / `settled:network|dom|visual` / `still-active` / `dialog` / `navigated` / `diagnosis`),
   the UI delta, the attributed network, sentinels, timing. A missing selector returns a *diagnosis*
   (near-matches, dialog census, pending requests, a screenshot) in one turn — never a bare timeout.
   The verdict is **evidence of what the page did — never a readiness gate** (see "The two questions").
2. **The screen and the wire are one evidence stream.** The DOM shows what the app chose to render; the
   network shows what the backend actually said. Prefer reading facts off captured responses when both
   carry them — the full patient list is JSON on the wire even though the DOM only renders 10 rows.
3. **Navigate to anchors; be defensive by construction.** Robust automation asserts a known *anchor
   state*, acts **with the postcondition on the act** (`until`), reads the verdict as the diagnostic when
   the postcondition fails — and treats every interstitial as optional (present *or* absent). It never
   assumes position and never trusts the verdict alone.
4. **The output is a folder of files, not a transcript.** `disco note` accumulates raw observations in the
   committed `apps/<target>/NOTES.md`; you distill what earns it — as you go, no ceremony — into
   `README.md`, `wire.md`, `lib.ts`, `check.ts`, `friction.md` (any subset is a legitimate state). The
   store is gitignored scratch:
   **if it isn't in a committed file, it doesn't exist tomorrow.**

## The loop: five verbs

### 1. Instrument — attach a session and start capturing

```bash
# attach to a browser you (or a human) already drives; scope keeps other tabs out
disco session new mysite --attach 9222 --scope example.com
# or launch a managed one:  disco session new mysite --launch --headless --url https://example.com
```

From the moment it attaches, disco records every request/response (bodies included), WS/SSE frame,
console line, dialog, navigation, and a screencast — to `apps/mysite/store/` (one run-tagged SQLite + `blobs/`).
**Have the app open before `session new`** (attach mode): the 30-second idle observation learns the page's
ambient traffic, and an empty browser teaches it nothing (it is skipped when nothing is scoped). **Let the
classifiers warm up** before you lean on settlement — reports say how far along it is
(`ambient classifier immature: 41s of 90s`); for an EHR, ≥3 cycles of its slowest heartbeat — `disco idle
200000` for a 60 s cadence (DECISIONS #29, #45). Scope is mandatory in attach mode so you never record a human's mail/bank tabs;
in launch mode it is optional (the browser is yours — a scope still keeps popups to other hosts out of the
store). `session new` writes `apps/.current`, which is what "the current app" means for every command
without `--app`.
Multi-tab: `disco targets` shows which page is `primary` (where `act` goes); `--target <id-prefix|url-part>`
or `disco focus` picks another — a popup can become the only page if the first tab is closed.
**Look at what you attached to before investing anything.** `disco targets` + a screenshot after
`session new`: a bot challenge, a maintenance page, a login wall for another tenant, a redirect to
marketing — all look like "the app" to a script and cost minutes each. `session new` says so when it can
tell (a bot-challenge page is detected and named); when it can't, the census is your check. A headless
browser refused by a bot challenge is not going to pass it by waiting — attach to a real browser you have
passed the challenge in, or use another host of the same build.

**Long observations run in the background.** A classifier warm-up only needs the *page* to sit still — not
you. Size it from the slowest heartbeat: a family is ambient after **3 occurrences** at a regular cadence
seen while no action window is open, so a 60 s heartbeat needs ~3–4 minutes of idle (`disco idle 200000`),
not the 2 minutes older notes suggested; `disco families` shows each family's samples and gaps so far
("×2, gaps 60s — one more cycle"), and a rule (`--ambient <url-part>`) is always available when waiting
is not worth it. Start it as a background command and spend the
time on recon (the store, `families`, `targets`, the frames); the harness tells you when it finishes.
Never write your own wait loop for it: `until ! pgrep -f 'disco idle'` matches its own shell's command
line and spins forever (a real run lost two minutes to exactly that without noticing).

### 2. Explore — act, and read what happened

```bash
disco act click 'role=button[name="Load Chart"]'      # Playwright selectors everywhere
disco act type '#search' --text ada                   # type appends; fill replaces ("" clears)
disco act rightclick '#row-7'      # click/rightclick/dblclick/middleclick/hover/type/fill/press/scroll/select/drag/navigate
disco act click '#save' --until-url /api/save/status --until-landed   # act + postcondition (below)
```

`s.click(sel, opts)`, `s.type`, `s.fill`, `s.press`, … and `disco act <kind>` are all one-line sugar over
**one** primitive, `s.act({ kind, … })` — one resolve, one settlement race, one report shape, one set of
options (`budgetMs`, `frame`, `evaluateAfter`, `until`, …). Anything said about `act()` applies to every verb.

The report prints the verdict, the settle timeline, the UI delta, and the attributed wire lines with body
handles. In the library it's the same, returned as a value:

```ts
import { connect } from "./src/client.ts";
const s = await connect("mysite");
const r = await s.click('role=button[name="Load Chart"]');
r.verdict;            // "settled:network"
r.wire.attributed;    // [{ m, p, s, ms, body, family, a }, …]  ← structured, not scraped
```

### 3. Discover — mine the store in SQL + TS (your native languages, never a DSL)

Bodies are persisted *before* the report returns, so the same script reduces them with no second round trip:

```ts
const rows = s.store.json(r.wire.attributed.find(w => w.p.includes("/api/rows")).body);
console.log(rows.length, rows[0].name);     // 10000  "Aardvark-Row-0"  — the wire had it all along
```

Ask retroactive questions the run never anticipated — FTS over every captured body/frame:

```bash
disco sql mysite "SELECT run, r.path FROM bodies b JOIN bodies_fts f ON f.rowid=b.rowid
           JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH 'Zebra-Row-9741'"
```

(`disco sql <app> "…"` is the canonical spelling; `--app <app>` and the current app are equivalent. The
store holds every run of the app and `t` restarts per run — select `run`, or filter
`WHERE run=(SELECT max(run) FROM runs)`.)

Canned helpers desugar to exactly this (`store.appearances(text)`, `store.requests({urlLike})`,
`store.timeline(t0,t1)`, `store.diffTrace(a,b)`) — see `src/store.ts`. Record interpretations as you go
with `disco note` / `s.note(...)` — each lands as a line in the committed `apps/<app>/NOTES.md` (and as a
store row, so `timeline()` interleaves it with the evidence it cites).

### 4. Characterize — states, transitions, variability

Model the app as **named anchors** (cheap predicates: a URL pattern + a landmark element) and
**transitions** between them (with their settlement profile + wire signature). Keep a **variability
ledger**: what varied, with n-counts, and the experiment that would resolve each. `diffTrace(a, b)`
compares two runs of "the same" step and shows the structural difference (e.g. the interstitial that only
sometimes appears). This is what the app's README (and `wire.md`, for the wire facts) captures.

### 5. Automate — write robust functions and a drift check

Distill the transitions into a **function library** in the pack — plain importable TS, one job each. See
the recipe below. Then a `check.ts` runs them against the live app to catch drift (`bun scripts/run-check.ts <target>`).
Export a `ready` predicate from `check.ts` (the app's first anchor) so the check waits for the shell, not
just a visible `body`. Run the check when you are *done* editing — a check launched and then invalidated by
a patch is a minute lost — and read every result: a failing first check is usually the best bug report
you will get (the diagnosis names the state the app was actually in).

**Your own clock is the bottleneck, not the app.** In a measured 20-minute pack build the app needed 32
seconds of settle time in total; the rest was authoring, deciding, and — the avoidable part — waiting
wrong. `bun scripts/timing-report.ts <app>` shows page time vs daemon overhead; the gaps between your tool
calls are the third column, and the only one you control.

## The two questions: `act()` vs `until` — the contract

Every step of driving a UI — discovery or production — asks two different questions, and disco has a
different primitive for each. Confusing them is the one way this goes wrong.

| Question | Primitive | What it promises | What it does **not** promise |
|---|---|---|---|
| **Q1. What did the app do when I did X?** | `act()` → `Report` | one input, one causality window, everything that happened in it (screen + wire + sentinels + console), and *when the page went quiet* — or that it didn't | that any particular state now exists |
| **Q2. Am I in the state I need to proceed?** | `until` on the act (preferred), `watch()`, `lib/nav` `until()` / `reached()`, a wire read | an evidence-driven wait for a *named* condition; on expiry a diagnosis, never a bare timeout | anything about what happened along the way |

Discovery is Q1-heavy: act, read the report, *learn what the postcondition should be*. Automation is
Q2-heavy: you know the postcondition, so you act **with it** — and you keep Q1's report because it is the
diagnostic when Q2 fails. **The verdict is never the gate.** Settlement means "the page has most likely
finished reacting"; it closes when the attributed network, the DOM and the pixels have all been quiet for
Q=300ms. Any gap longer than Q in the causal chain — a timer, a debounce, a second-hop fetch the app fires
later, a frozen main thread — closes settlement *before* the screen shows the result. That is not a bug to
tune away (raising Q slows every action); it is why the second question exists.

### 1. Settled ≠ ready — the same click, without and with `until`

Load Chart with a 900ms client-side gap between the last response and the render (gauntlet scenario 27):

```
act:1  click #load-chart  →  settled:network  (settled 166ms, reported 467ms; 3 req, 1 mut, 1 px)
  timing: page 467ms (settled 166, reported 467) + overhead 38ms (resolve 9, pre 15, post 11, build 3) = 505ms
  + - text: "status: loading…"
  - - text: "status: idle"
  ⇄ GET /api/slow → 200, 29B, 152ms, application/json (task)  body:df6b82ad7582
  ⇄ GET /api/chart/a → 200, 35B, 34ms, application/json (task)  body:e565556a7a19
  ⇄ GET /api/chart/b → 200, 35B, 34ms, application/json (task)  body:89cf1590e155
  eval: "loading…"
```

Everything the verdict says is true — three attributed requests, quiet at 166ms — and the screen still
says "loading…". A script that trusted the verdict would read the wrong state. Same click, with the
postcondition on it:

```ts
const r = await s.click("#load-chart", {
  until: { fn: () => document.querySelector("#chart-status")?.textContent === "idle" },
  evaluateAfter: () => document.querySelector("#chart-status")?.textContent,
});
```
```
act:2  click #load-chart  →  settled:network  (settled 112ms, reported 424ms; 3 req, 1 mut, 1 px)
  timing: page 1345ms (settled 112, reported 424, until 1013) + overhead 63ms (resolve 6, pre 11, post 45, build 1) = 1408ms
  ✓ until: matched in 1013ms  true
  ⇄ GET /api/slow → 200, 29B, 104ms, application/json (task)  body:373f9a1b85b0
  …
  eval: "idle"
```

Both signals, one report: settlement at 112ms (what the page did), postcondition at 1013ms (when the
state you need arrived), post-state captured *after* both. The causality window stayed open the whole
time, so anything the page did in between is attributed to this action. Discovery omits `until` and
learns from the first report that `#chart-status === "idle"` *is* the postcondition; automation passes it.

### 2. Optimistic UI — the wire is the truth

`#save` flips the screen to "Saved ✓" synchronously, POSTs, gets a `202 {pending:true}`, and only 500ms
later asks `GET /api/save/status` whether it really saved. Settlement closes at ~135ms — long before the
request that matters. `until` the status response is back keeps the window open and lands it *attributed*:

```ts
const r = await s.click("#save", { until: { urlLike: "/api/save/status", landed: true } });
```
```
act:3  click #save  →  settled:network  (settled 135ms, reported 435ms; 1 req, 1 mut, 2 px)
  ✓ until: matched in 1837ms  req 297185.21
  + - text: "state: Saved ✓"
  ⇄ POST /api/save → 202, 56B, 2ms, application/json (task) ✎write  body:acfec170c2c0
  ⇄ GET /api/save/status → 200 [unread], ?, application/json
  ⚑ sentinel toast: "Saved"
  ✎ writes: POST /api/save
  eval: "Saved ✓"
```

Read the status from `r.wire.attributed`, not from the toast. (`[unread]`: the page never reads that body,
so it is known-uncapturable after a 1.2s grace — which is when `landed` matched. Capture limits are
recorded, never hidden.)

### 3. The sometimes-modal — a diagnosis names the blocker

Open record 1, and ~400ms *after* settlement an "Allergy Review Required" dialog appears (only for some
records — the variability ledger's job). The next click lands on it:

```
act:5  click  →  diagnosis
  ✗ occluded — occluded by <div role="dialog" class="overlay" id="record-modal" aria-modal="true" …>…</div>
    open dialogs: Allergy Review Required
    shot: d281c0af6c5a
```

One turn, no timeout, and the report says *what* is in the way. The defensive step is
`actIfPresent(s, "#modal-ack")` (present *or* absent, both first-class), then retry once —
`apps/gauntlet/lib.ts::openRecord` is the composable form.

### 4. Reading the verdict when the postcondition fails

```
act:7  click #noop  →  no-effect  (settled 0ms, reported 499ms; 0 req, 0 mut, 0 px)
  timing: page 803ms (settled 0, reported 499, until 800) + overhead 21ms (resolve 5, pre 8, post 7, build 1) + scroll-absorb 265ms = 1088ms
  ✗ until: NOT matched in 800ms — diagnosis:
  ✗ budget-expired
    near matches: <button id="load-chart">Load Chart</button> | <button data-id="1" id="record-1" class="record">Open Record 1</button> | …
```

This is why automation keeps Q1's report instead of a bare selector-poll: the verdict tells you *why* the
postcondition didn't arrive, and what to do about it.

| `until` | verdict | Meaning | Script should |
|---|---|---|---|
| matched @0.4s | `settled:network` @1.9s | screen ready before the wire finished → **optimistic UI** | trust the wire, not the screen |
| matched | `still-active` (pixels) | done; the page is noisy (spinner) | proceed — it's a pass; note "never settles on pixels" |
| not matched | `settled:dom` @0.3s | the page settled in the **wrong** state (validation error, still on login) | read `ui.added` / the diagnosis; don't retry blindly |
| not matched | `still-active`, `pending` has requests | just slow | raise `until.budgetMs` / `awaitSettlement` |
| not matched | `no-effect` | click swallowed (overlay, disabled, wrong element) | check the diagnosis, dismiss the interstitial, retry once |
| matched @5s | `no-effect` | nothing observable for 500ms, *then* the state arrived (a timer, a frozen main thread, a late hop) — the CLI prints `no-effect → until matched at 5021ms` | trust `until`; the report's UI delta spans the whole wait; note the delay in the ledger |
| — | `diagnosis: occluded by …` | something is in the way | `actIfPresent` it away, retry once |

Mechanics worth knowing: the predicate is watched from dispatch; if it matches *first*, the remaining
quiet-wait is capped to a short tail (`tailMs`, default 1s — never the 20s hung-request budget); if
settlement finishes first, the window stays open while the predicate is awaited (`budgetMs`, default 5s).
`until.frame` names a postcondition in another frame (a finder click whose effect is a new chart frame).
CLI spelling: `--until <selector> [--until-visible]` (a bare selector means *present*; `--until-visible`
means laid out with a box), `--until-fn "() => …"`, `--until-url <part> [--until-landed]`,
`--until-budget ms`, `--until-tail ms`.
`expect` **never waits** — it only flags a surprising report for the ledger. `settled:late` is what a
`still-active` action becomes when the background settler sees it quiet later.

### Where the milliseconds go

Every report carries `timing`: page time (`settleMs` / `reportedMs` / `untilMs`, and `absorbMs` — present
only when the hit-test had to scroll the target into view *and* the viewport repainted after it) versus
daemon overhead (`resolveMs` + `preMs` + `postMs` + `buildMs`, typically 20–60ms). Responsiveness is a tested contract, not a hope: a no-op reports at ≈500ms with under
400ms of overhead, `watch()` notices a DOM change within ~Q, an already-true `until` costs at most the
quiet tail. `bun scripts/timing-report.ts <app>` prints the distribution for an app's recorded runs.

Run all of the above yourself: `bun demos/03-two-questions.ts`.

## Writing a robust function (the recipe)

Every good pack function does four things — assert the precondition anchor, act **with its
postcondition**, read the facts off the wire, handle optional steps both ways. `openPatient` from the
OpenEMR pack, annotated:

```ts
export async function openPatient(s, target) {
  // (1) anchor + reach the row: for a name, search the finder (works past page 1) so the row is visible
  let pid = typeof target === "string" ? (await findPatient(s, target)).pid : (await openFinder(s), target);
  // (2) act WITH the postcondition — which here lives in a different frame: the chart frame the click creates.
  //     reached() throws with verdict + diagnosis if the row wasn't actionable or the chart never came.
  reached(await s.click(`#pid_${pid}`, { frame: "dynamic_finder.php", budgetMs: 15000,
    until: { selector: "#medical_problem_ps_expand", frame: "demographics.php", budgetMs: 20000 } }), `openPatient(${pid})`);
  // (3) the "due clinical reminders" alert may or may not fire — auto-accepted by policy, so proceed either way
  // (4) assert the anchor by name (cheap now: the predicate already holds)
  await assertChart(s, pid);
  return pid;
}
```

Principles it embodies (all from real fixes — see DECISIONS #31, #35, #38):
- **The postcondition is on the act.** `until` keeps the causality window open until the state arrives; the
  verdict stays what it was — the diagnostic. `reached(report)` is the one-line gate.
- **Anchors, not positions.** `assertMainShell` / `assertChart` are `until` calls that verify where you are
  and throw a clear message (with the diagnosis) otherwise. `login` is idempotent (skips work if already in
  the shell) and, on saucedemo, waits for *either* the inventory *or* the app's error banner — the
  `performance_glitch_user` click settles `no-effect` and is safe only because of that.
- **Optional steps both ways.** `actIfPresent(s, sel)` dismisses an interstitial if it appears (visibly)
  within a short budget and does nothing if it doesn't — the absent path is first-class.
- **Wire-first.** `findPatient` / `extractSummary` read the finder JSON and summary fragments, not brittle
  layout; `until: { urlLike, landed: true }` is how a step waits for *its* response. `extractFromWire` is
  the generic move.
- **Evidence, never sleeps.** There is no `sleep(` anywhere in `apps/` or `lib/`. `fill` replaces a field's
  value with real key events (no `evaluate()` hacks); `waitForFrame` is `until` with a `frame:`.
- **One selector language.** Playwright's, everywhere: `click`, `until`, `assertVisible`, `actIfPresent`.

And the DOM-first counterpart, when the app has no API and a step can end in **either** of two states —
`login` from the saucedemo pack: the postcondition is the disjunction, `firstOf` says which arm held, and
the app's own refusal text becomes the error:

```ts
export async function login(s: Session, user: string, pass = PASSWORD): Promise<void> {
  if (await s.evaluate<boolean>(() => location.pathname.startsWith("/inventory"))) return;      // idempotent
  reached(await s.navigate(BASE, { until: { selector: "#login-button", visible: true } }), "login page");
  await s.fill("#user-name", user);                                                                // fill replaces; type appends
  await s.fill("#password", pass);
  // the click ends in ONE of two states — wait for EITHER (performance_glitch_user shows nothing for ~5s:
  // verdict `no-effect`, and the postcondition is what makes this safe), then ask which
  reached(await s.click("#login-button", { until: { fn: () => !!document.querySelector(".inventory_list") || !!document.querySelector('[data-test="error"]'), budgetMs: 15000 } }), "login");
  if ((await firstOf(s, { ok: { selector: ".inventory_list" }, err: { selector: '[data-test="error"]' } })) === "err")
    throw new Error(`login refused: ${await s.evaluate(() => document.querySelector('[data-test="error"]')?.textContent)}`);
}
```

Generic moves live in `lib/` (product-agnostic: `until`, `reached`, `firstOf`, `assertVisible`,
`actIfPresent`, `waitForFrame`, `extractFromWire`, `wireHas`); product-specific functions live in the pack
and lean on them. A move graduates from a pack to `lib/` when a second product would copy it.

## Effective-use tips & rough edges

- **Frame-scope everything** in a nested app: `{ frame: "dynamic_finder.php" }`. Cross-origin iframes
  resolve in their own target; disco translates the click coordinates for you.
- **Digest → drill → reduce.** The report is ~300 tokens with handles; open a body/blob only when needed,
  and reduce it in your own script. Don't pull whole HARs into context.
- **Verdict labels are best-effort** — ambient content rendering in the settle tail can retag
  `network`→`dom` (DECISIONS #30). Assert timing + attribution for non-interference, not the label.
- **The verdict is never the gate** — pass `until` (or call `until()`/`reached()`); `expect` never waits.
- **`type` appends, `fill` replaces** — form fields want `fill`; debounced search boxes that count
  keystrokes want `type`.
- **A missing frame is not an error** — `watch`/`until` wait for it (`frame:` re-resolves per check);
  from `act()` it's a `frame-not-found` diagnosis with a frame census.
- **Watch `timing.overheadMs`** — if it grows, the daemon got slower, not the page.
- **Third-party telemetry is not ambient by itself** — a crash reporter or analytics beacon that fires
  per event (on a refusal, on every page load, CORS-blocked) never looks periodic, so it holds
  settlement until it fails and trips the error sentinel. `disco families --ambient <family>` takes it out
  of attribution *and* the settlement race. `--scope` picks tabs, not hosts.
- **`evaluate` args are positional** (`{ args: [a, b] }` → `fn(a, b)`); `evaluateAfterArg` / `fnArg` are
  single values. `--eval` output prints in full right under the verdict; `--json` for the whole report.
- **`document.body.textContent` includes `<script>` source.** A text predicate over the whole body can
  match a string that only exists in the app's JavaScript (a stranger's "refused" arm matched on a login
  that had succeeded). Use `innerText`, or scope the predicate to the element that carries the message.
- **`scroll({ target })` wheels over the target** — the pointer is moved there first — so a scrolling
  container scrolls, not the page.
- **Page functions capture nothing.** A module constant used inside `until.fn` / `evaluate` is a
  `ReferenceError` in the page and `tsc` will not tell you — pass it as `fnArg` / `args`. The wait fails
  **at once** with `diagnosis.error: "ReferenceError: X is not defined — page functions capture nothing…"`
  (never `false` until the budget), and `evaluate` rethrows with the same hint.
- **The classifier can be wrong for your app** — reports name ambient-tagged requests that fired *with*
  the action. Override with a **URL-substring rule**: `disco families --not-ambient /api/session` (a
  burst-refetched read the classifier mis-learned) or `--ambient backtrace.io` / `session new --ignore
  backtrace.io` (third-party telemetry that holds settlement until it fails). Rules persist per app, match
  the full URL (so `Location?_tag=Login` is one rule), and `not-ambient` wins. `disco rules` lists them.
- **Sentinel noise** (a Carbon app fires "toasts" for table rows): `disco sentinels --mute toast --text
  "Loading"` — muted firings are still in the store (`muted=1`), just not in reports. Put a pack's mutes in
  its `check.ts`/`login` (`s.mute(…)`) so every run starts quiet.
- **Combining postconditions:** `until: { any: [pred, …] }` (one holds; `report.until.which` names the arm
  — give arms a `name`) or `{ all: [pred, …] }` (every arm; a wire-AND-DOM postcondition is
  `all: [{ urlLike, landed: true }, { selector }]`). `firstOf` still answers "which state holds now" after
  the fact. To wait for the *page* URL, `{ fn: () => location.href.includes("/chart") }` (`urlLike` matches
  *request* URLs).
- **`disco sql` is read-only** — it can't mutate the store; notes are written only through the daemon.
- **Warm the classifiers** (`disco idle`) before trusting settlement on a heartbeat-heavy app.
- Full gotcha list: `STATE.md` "Gotchas" + `DECISIONS.md` #16–31.

## Extending the core — sanctioned growth points

The engine and `lib/` are deliberately small (GUIDANCE §0's forbidden-abstractions list; "simple and
powerful beats over-engineered"). They are **not** meant to stay frozen. Several capabilities were
deferred *on purpose*, with the mechanism already understood, to be added to the **core** — not hacked
into a single pack — the moment a real case needs them. If you're driving a novel app and hit one of
these walls, this is your cue: reach for the extension, add it to Layer 1 with a test and a `DECISIONS.md`
note (the promotion path), rather than working around it per-pack. Don't build them speculatively; do
build them when the need is concrete and general. Each is a known door, not a limitation.

**Input**
- **Native HTML5 drag-and-drop.** Have: real mouse drag (`dragFromTo`, `act kind:"drag"`) — covers sliders/sortables/resizes. Add when an app uses true HTML5 DnD (`dragstart`/`dragover`/`drop`, `dataTransfer`) that synthetic mouse moves don't fire — CDP `Input.setInterceptDrags` + `Input.dispatchDragEvent`. *Trigger:* a drag that visibly does nothing on an element with `draggable="true"` / `dragstart` listeners.
- **Touch, file-drop, clipboard paste.** Same shape — `Input.dispatchTouchEvent`, `DOM.setFileInputFiles`, clipboard — add per need.

**Observation**
- **Streaming / SSE response bodies.** Have: SSE *messages* (`sse_events`); the never-finishing body isn't captured (`getResponseBody` needs `loadingFinished`). Add via the `Fetch` domain (`Fetch.enable` + `takeResponseBodyAsStream`) when an app delivers **results over a stream**. *Trigger:* a request flagged `streaming`/`unread` that carries data you need.
- **Content-based attribution fallback.** Have: task/window/dependency tiers + periodicity/independence ambient classification. Add a content match (does this standing-channel frame/response correspond to the action's subject?) when an app delivers **action results over a long-poll/WS/SSE** that the periodicity heuristic classifies as ambient. *Trigger:* the result you expected shows up as "non-attributed activity in the window" on a standing channel.
- **Screencast fallback mode.** Have: native-rate `startScreencast` as the visual signal. Add the sanctioned switch to on-event/interval `captureScreenshot` (GUIDANCE §3.4) when the cast is too costly attached to a heavy real desktop. *Trigger:* measured screencast overhead hurting a human's browser. (A mode switch, not an abstraction layer.)
- **Diff-highlighted screenshot.** Have: numeric `changedBoxes` in the report. Add a rendered variant (draw the boxes onto the post-shot) when a visual diff artifact earns the pixels. *Trigger:* repeatedly wanting to *see* what changed, not just its coordinates.
- **Screenshot OCR in `appearances()`.** Have: `appearances` searches bodies + WS frames + aria snapshots. Add OCR over stored frames when facts live only in **canvas/pixels**. *Trigger:* a canvas-rendered region (flowsheet, schedule grid) whose data isn't on the wire or in the DOM.

**Analysis & orchestration**
- **Orchestrated N-record sampling.** Have: the store + `diffTrace(a, b)` support variability sampling by hand. Add a helper that runs "the same" transition across N records and aggregates the variability. *Trigger:* a ledger question that needs n ≫ 2.
- **Write-flag heuristic for read-shaped POSTs.** Have: per-family write-flag + manual `family mark-read` + a GraphQL body peek. Add a recon pass / heuristic (a POST returning HTML/JSON with no state change is a read) when an app POSTs for reads at scale (OpenEMR's summary fragments are the type case). *Trigger:* the write-flag firing on obviously-read panels.

**Safety (for real, non-demo targets)**
- **Capture-time redaction** and **mechanical read-only enforcement.** Have: environmental posture (demo/BAA data) + stance + write-flag surfacing. Add real redaction (hash/drop PHI at capture) and/or an enforce-mode that refuses `write`/`unknown`-family requests when pointing at a **real, PHI-bearing** system. *Trigger:* a target that is not a demo / BAA-covered environment.

Adding one of these is a Layer-1 change: implement the mechanism, prove it against the gauntlet (or the app
that forced it), and log it in `DECISIONS.md` so the next agent sees why it exists. The current status of
each (built / partial / deferred) lives in `DECISIONS.md` (the `OPEN` tags) and `STATE.md`.

## Where outputs go

Everything you learn lives under `apps/<target>/` (the shape and the accumulate→distill habit:
`apps/README.md` — NOTES.md fills as you work; README/wire/lib/check/friction are what you distill). Tool-level lessons
become engine fixes + `DECISIONS.md`; class-of-app lessons become methodology in `GUIDANCE.md §7–8`.
Every exploration sharpens the platform, not just its own pack.
