# disco — the discovery daemon

Observation-first browser instrumentation for agents. Every action is an experiment that returns an
observation report; everything the browser does — screen and wire — lands queryably in SQLite + blobs.
Constitution: [GUIDANCE.md](GUIDANCE.md). Construction plan: [BRIEF.md](BRIEF.md). Decisions/divergences:
[DECISIONS.md](DECISIONS.md). Loop state: [STATE.md](STATE.md).

## Docs

- **[docs/using-disco.md](docs/using-disco.md)** — the field guide: how to use disco to instrument/explore/discover/characterize/automate, with worked examples.
- **[PLATFORM.md](PLATFORM.md)** — the two-layer platform + the plan. **[GUIDANCE.md](GUIDANCE.md)** — constitution + methodology. **[apps/README.md](apps/README.md)** — the per-product packs.
- **[SURFACE.md](SURFACE.md)** — the whole surface on one page: store tables, every `Session` method, the CLI tree.

## Quickstart: ten lines to a first observed click

```bash
bun install
bun gauntlet &                                  # the hostile demo SPA on :4800
chromium --remote-debugging-port=9222 http://localhost:4800 &   # any Chromium you can attach to — SHOWING the app
bun cli/disco.ts session new gauntlet --attach 9222 --scope localhost:4800   # -> apps/gauntlet/store/
#   idle-observes the open page for 30s to learn its ambient traffic (skipped if nothing is scoped yet; --no-idle to skip),
#   then RETURNS, leaving the daemon running in the background (`session end` stops it; `--fg` keeps it attached)
bun cli/disco.ts act click 'role=button[name="Load Chart"]' --until-fn "() => document.querySelector('#chart-status')?.textContent === 'idle'"
#   act:1  click role=button[name="Load Chart"]  →  settled:visual  (settled 872ms, reported 1172ms; 3 req, 2 mut, 5 px)
#     timing: page 1172ms (settled 872, reported 1172, until 433) + overhead 115ms (resolve 85, pre 16, post 11, build 3) = 1287ms
#     ✓ until: matched in 433ms  true                       ← the state you asked for arrived at 433ms (slowMs 400 + render)…
#     + - text: "status: idle Chart loaded (3 responses)"
#     ⇄ GET /api/slow → 200, 29B, 405ms, application/json (task)  body:e0d103b5c251
#     ⇄ GET /api/chart/a → 200, 35B, 6ms, application/json (task)  body:e565556a7a19
#     ⇄ GET /api/chart/b → 200, 35B, 6ms, application/json (task)  body:89cf1590e155
#     (ambient classifier immature: 30s of 90s idle observed — `disco idle 60000` with the page open finishes it)
#   (…while the page kept repainting until 872ms — a first action in a fresh session, before the visual
#    ignore-mask has learned the page's perpetual spinner. The verdict is evidence; `until` is the gate.)
bun cli/disco.ts sql gauntlet "SELECT run, method, path, status FROM requests WHERE run=(SELECT max(run) FROM runs) ORDER BY t_start"
bun cli/disco.ts session end gauntlet
```

Or launch a managed browser: `disco session new gauntlet --launch --headless --url http://localhost:4800`.

## The three faces (descending power, ascending convenience)

1. **The store.** `apps/<app>/store/store.sqlite` (WAL, one run-tagged history per app) + `blobs/` (sha256-addressed). Open it with
   `bun:sqlite`, the `sqlite3` CLI, or `disco sql <app> "…"` — schema in [schema.sql](schema.sql); read it, then
   write any SQL. Works with the daemon stopped. Every row carries `run`, and `t` restarts per run: filter
   `WHERE run=(SELECT max(run) FROM runs)` for "this run". Any hash argument (`blob`, `body(…)`) accepts a prefix. FTS5: `SELECT r.path FROM bodies b JOIN bodies_fts f
   ON f.rowid=b.rowid JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH '"Zebra-Row-9741"'`.
2. **The library** (`src/client.ts`), for Bun scripts:

```ts
import { connect } from "./src/client.ts";       // path or add an import map entry
const s = await connect();                        // current session (or connect("name"))
const r = await s.click('role=button[name="Load Rows"]', { until: { urlLike: "/api/rows", landed: true } }); // act + postcondition
const rows = s.store.json(r.wire!.attributed[0].body!);   // same process, no daemon round trip
console.log(rows.length, rows[0].name, rows.at(-1).name); // the wire had all 10k rows
await s.note(`rows are wire-available at ${r.wire!.attributed[0].family}`, { kind: "ledger", action: r.action });
s.close();
```

   The whole `Session` surface, one screen (details: [SURFACE.md](SURFACE.md)):

   ```ts
   connect(appOrDir?) → Session                    s.act({ kind, target?, …opts }) → Report   ← the ONE primitive; the verbs are sugar:
   s.click|rightclick|dblclick|middleclick|hover(target, opts)   s.type(target, text, opts) appends   s.fill(target, text, opts) replaces ("" clears)
   s.press(key, opts)   s.scroll({ target?, deltaY? }, opts)   s.select(target, value, opts)   s.navigate(url, opts)   s.drag(target, to | {dx,dy}, opts)
   opts = { frame?, targetId?, budgetMs?, quietMs?, noEffectMs?, maxBudgetMs?, evaluateAfter?, evaluateAfterArg?, world?, until?, expect? }
   s.watch(pred, { budgetMs?, frame? }) → { matched, elapsedMs, … }      s.awaitSettlement / s.settle({ action?, budgetMs?, frame? }) → Report
   s.evaluate(fn, { args?: any[], frame?, targetId?, world? }) → value     ← args is an ARRAY of positional parameters: fn(a, b) ← args: [a, b]
   s.note(text, { kind?, name?, action?, data? })   s.targets()   s.info()   s.screenshot()   s.families()   s.idle(ms?)   s.focusTarget(id)
   s.rules()   s.ignore(urlPart)   s.attend(urlPart)   s.mute(name, { selector?, text?, url? })   s.unrule(id)     ← per-app overrides, persist across runs
  s.onEvent(fn) → unsubscribe   s.cdp(method, params, { targetId? | browser? })   s.end()   s.close()
   s.store → sql | requests | body/json/bodyBytes | appearances | timeline | screenshotAt | action | frames | diffTrace | runs
   ```

3. **The CLI** — every command is sugar over the two above; `disco help` for the tree.

`s.click(sel, opts)` / `s.type` / `s.fill` / `s.press` / … are one-line sugar over `s.act({ kind, … })`: one
action primitive, one settlement race, one report shape. **Two questions per step** (docs/using-disco.md):
`act()` answers *what did the app do?* (the verdict is evidence, never a readiness gate); `until` / `watch()`
answers *am I where I need to be?* — automation always passes `until`.

## ⚠️ In-page functions: closures do not transfer

`evaluate`, `evaluateAfter`, and `watch({fn})` / `until: {fn}` ship your function **as source** into the page.
It runs there with nothing from your script's scope — no imported helpers, no captured variables. Pass data
in — three spellings for one idea, by arity: `evaluate(fn, { args: [a, b] })` is **positional** (an array,
`fn(a, b)`); `evaluateAfter` takes one value as `evaluateAfterArg`; `watch`/`until` `fn` takes one value as
`fnArg`. Return JSON-serializable values. `world: "main"` sees the page's globals; the default isolated
world does not (but shares the DOM).

## Reports in one screen

verdict (`no-effect` | `settled:network|dom|visual` | `still-active` | `settled:late` (background, after a
still-active) | `navigated` | `dialog` | `new-target` | `download` | `diagnosis`) + settlement timeline;
`until` (postcondition: matched / elapsed / diagnosis); `timing` (page time vs daemon overhead); semantic UI delta (aria-snapshot diff);
attributed wire lines ranked by interestingness with body handles; ambient-in-window count; other
activity; console errors; environment flags (url change, dialogs, sentinels since last report,
write-flag, new targets); `evaluateAfter` result; a store cursor `ev:from-to`. A failed resolution or
expired watch returns a **diagnosis** (near-matches, dialog census, pending requests, screenshot) —
never a bare timeout.

## Canned helpers and their desugarings (`openStore(dir)` / `session.store`)

| helper | desugars to |
|---|---|
| `requests({urlLike, method, actionId, status, family, since, until})` | `SELECT * FROM requests WHERE url LIKE ? AND … ORDER BY t_start` (a bare `urlLike` fragment is wrapped in `%…%`) |
| `body(hash)` / `json(hash)` / `bodyBytes(hash)` | `SELECT text FROM bodies WHERE hash=?`, else read `blobs/xx/hash` |
| `appearances(text)` | FTS `MATCH` over `bodies_fts` + `ws_fts`, joined to `requests`/`ws_frames`, plus aria-snapshot blobs |
| `timeline(t0, t1)` | `SELECT … FROM events WHERE t BETWEEN ? AND ?` interleaved with `notes` |
| `screenshotAt(t)` | `SELECT … FROM shots WHERE t<=? ORDER BY t DESC LIMIT 1` |
| `action(id)` | `SELECT * FROM actions WHERE id=?` with JSON columns parsed |
| `frames(t0, t1)` | `SELECT … FROM shots WHERE t BETWEEN ? AND ?` |
| `diffTrace(a, b)` | two `action()` reads + set-diffs over wire families, UI lines, sentinels |

The moment a question doesn't fit a helper, drop to SQL + TS; helper source in `src/store.ts` doubles
as schema-by-example.

## Selectors

Playwright's language, vendored (`role=button[name="Save"]`, `text=`, `css=`/bare CSS, `xpath=`,
`>>` chaining, shadow-piercing) — **everywhere**: `act`, `watch`/`until`, and every `lib/nav.ts` move
(`assertVisible`, `actIfPresent`) take the same syntax. Frames: `{frame: "xframe.html"}` (URL substring),
a frame id, or `main`. Cross-origin iframes resolve in their own target; input is dispatched on the root
page with translated coordinates.

## Capture limits (recorded, never hidden)

Streaming bodies (`streaming`), unread fire-and-forget bodies (`unread` — fetched when Chromium still
has them buffered), evicted bodies (`evicted`), late-attached targets (`targets.late=1` — anything
before `observed_from` is an unobserved prefix, including **WebSockets opened pre-attach**, which CDP
cannot enumerate retroactively; reload the tab if you need their frames). Requests that begin within
~1.5s after a window closes on the same root are tagged `attribution=trailing` — causally downstream
(delayed validations) but not part of settlement. In attach mode the navigation that *creates* a tab is an
unobserved prefix (the daemon attaches after it has begun): the document request and the first assets can
be missing from `requests` — reload the tab, or use `--launch --url`, which opens `about:blank`, attaches,
and then navigates as `act:1` so the whole document load is observed.

## Report & watch shapes (the fields scripts should rely on)

`report.wire.attributed[i]` = `{ line, m, p, s, ms, body, id, family, a }` — use the structured
fields (`m`ethod, `p`ath, `s`tatus, `ms`, `body` = 16-char blob prefix), not the display `line`.
`report.settle = { ms, reportedMs, timeline, counts, pending? }`; `report.cursor = { from, to }`;
`report.until = { matched, elapsedMs (from dispatch), which?, preview?|request?, diagnosis? }` when `until` was passed
(`which` = the `any` arm that held — its `name`, else its index);
`report.timing = { resolveMs, absorbMs, preMs, settleMs, reportedMs, untilMs?, waitMs, postMs, buildMs, overheadMs, totalMs }`
(`waitMs` + `absorbMs` = page time; `overheadMs` = daemon work).
`watch(pred, {budgetMs, frame})` → `{ matched, elapsedMs, preview?, request?, diagnosis? }`; predicates (also
`act({until: pred})`, which adds `budgetMs`, `tailMs`, and `frame` for a postcondition in another frame):
`{selector, visible?}` | `{urlLike, landed?}` (for `watch`: started OR responded since watching; for `until`:
started after dispatch; `landed` = the response is back and the body's fate decided — captured, or known
uncapturable such as an `unread` fire-and-forget body after its 1.2s grace) | `{fn, fnArg?}` (in-page, called
with `fnArg`, truthy = match) | **`{ any: [pred, …] }`** (one arm holds; `until.which` names it) | **`{ all: [pred, …] }`**
(every arm holds — a wire-AND-dom postcondition is `all: [{ urlLike, landed: true }, { selector }]`); arms take a
`name` and combinators nest. A `frame` that doesn't exist yet is waited for, not thrown on; from `act()` it is a `frame-not-found`
diagnosis with a frame census. A ReferenceError inside a page function fails the wait **immediately** with the
closure hint (page functions capture nothing from your script), never `false` until the budget.

One report, annotated (every path is `json_extract(report, '$…')`-able from `actions.report`):

```
{ action: "act:12", kind: "click", verdict: "settled:network",           -- $.verdict
  target: { selector, preview, frame, count?, detachedRetried? },
  settle: { ms, reportedMs, timeline: [{t, what}], counts, pending? },    -- $.settle.reportedMs
  until:  { matched, elapsedMs, preview? | request?, diagnosis? },        -- $.until.matched, $.until.elapsedMs
  timing: { resolveMs, absorbMs, preMs, settleMs, reportedMs, untilMs?, waitMs, postMs, buildMs, overheadMs, totalMs },
  ui:     { added: [aria lines], removed, addedMore, removedMore, changedBoxes, ambientChurn? },
  wire:   { attributed: [{ m, p, s, ms, body, family, a, line }], more, ambientInWindow, otherActivity, ws, sse },  -- $.wire.attributed[0].p
  env:    { url, urlChanged?, navigated?, focus?, dialogs?, sentinels?, writeFlag?, newTargets?, classifierImmature?, classifierIdleMs? },
  evaluateAfter, shots: { pre, post }, aria: { pre, post }, cursor: { from, to }, diagnosis?, extended? }
```
e.g. `SELECT id, verdict, json_extract(report,'$.until.elapsedMs') FROM actions WHERE json_extract(report,'$.until.matched')=1`.

## Timing model (GUIDANCE §4.2 + DECISIONS #16)

The numbers a script author meets (all in `defaults.ts`): Q = `quietMs` 300 · `noEffectMs` 500 · `budgetMs`
3000 (quiet-wait cap; suspended while attributed requests fly) · `maxBudgetMs` 20000 · `watchBudgetMs` 1500 ·
`untilBudgetMs` 5000 · `untilTailMs` 1000 · `trailingAttributionMs` 1500 · classifier warm-up 90s of observed
idle · ambient = ≥3 occurrences, gap cv ≤ 0.3 (bursts within 100ms collapsed) or a long-poll held ≥1s and
re-issued within 250ms.

Settlement = quiescence race (network scoped to attributed-non-ambient requests / DOM minus ambient
churn roots / pixels minus the learned ignore mask and the target's own repaint) with Q=300ms, a fast
`no-effect` tier at 500ms, and a budget that measures **time since the last attributed network
evidence** (in-flight requests suspend it; `maxBudgetMs` bounds hung ones). Give the classifiers idle
time (`disco idle`, or the default idle observation at session start) before acting — reports say how far
along it is (`ambient classifier immature: 30s of 90s`). **The ambient rule:** a request family is ambient
once it has ≥3 occurrences at a regular cadence (inter-arrival cv ≤ 0.3) or reissues as a chained long-poll,
observed while no action window is open; `disco families` shows the evidence, `families --ambient F` /
`--not-ambient F` overrides it, and ambient families are excluded from attribution **and** from the
settlement race. Per-event third-party traffic (crash/telemetry reporters that fire on a refusal, a
CORS-blocked beacon) never looks periodic — mark it ambient yourself. **`--scope` selects tabs** (targets
whose URL matches), not hosts: every request a scoped tab makes is recorded, third parties included.

**Per-app overrides** (the `rules` table; persist across runs; `disco rules` lists, `--remove <id>` drops):
`disco families --ambient <url-part>` / `--not-ambient <url-part>` (or `session new --ignore <url-part>`,
`s.ignore()` / `s.attend()`) match the **full URL**, so one rule covers a host (`backtrace.io`) or a query key
(`Location?_tag=Login`) — finer than a family mark, and `not-ambient` beats a mis-learned family. Ambient
requests are out of attribution **and** the settlement race. `disco sentinels --mute <name> [--selector s]
[--text t] [--url u]` (`s.mute()`) silences a sentinel that fires on noise: muted firings are still recorded
(`sentinels.muted=1`), just never reported or streamed. `disco families --forget` clears learned families
(rules stay); `families.last_run` shows which run last saw a family.

## Responsiveness is measured

Every report's `timing` splits page time (`waitMs`: settle + until) from daemon overhead (`overheadMs`:
resolve + hit-test + two snapshots + report build). `bun scripts/timing-report.ts <app>` prints the
settle/overhead distribution per verdict for an app's recorded runs — the measurements `defaults.ts` is
tuned from. The contract is pinned by tests (`test/gauntlet/until.test.ts` "responsiveness"): a no-op
reports at ≈500ms with < 400ms overhead, `watch()` notices a DOM change within ~Q, an already-true `until`
costs at most the quiet tail, settlement scales with server latency, and the `until` tail cap holds against
a hung request.

## Running the tests

`bun test` — unit (fake clocks, the RPC framer), gauntlet server contracts, the acceptance suites that launch
a headless Chromium against the gauntlet (including `until`/responsiveness and the executed demo), and the
gauntlet pack's function library. `bunx tsc --noEmit -p .` for types. Live drift checks are scripts, not
tests: `bun scripts/run-check.ts <saucedemo|openemr|gauntlet>`.
