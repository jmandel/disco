# disco — the discovery daemon

Observation-first browser instrumentation for agents. Every action is an experiment that returns an
observation report; everything the browser does — screen and wire — lands queryably in SQLite + blobs.
Constitution: [GUIDANCE.md](GUIDANCE.md). Construction plan: [BRIEF.md](BRIEF.md). Decisions/divergences:
[DECISIONS.md](DECISIONS.md). Loop state: [STATE.md](STATE.md).

## Docs

- **[docs/using-disco.md](docs/using-disco.md)** — the field guide: how to use disco to instrument/explore/discover/characterize/automate, with worked examples.
- **[PLATFORM.md](PLATFORM.md)** — the two-layer platform + the plan. **[GUIDANCE.md](GUIDANCE.md)** — constitution + methodology. **[apps/README.md](apps/README.md)** — the per-product packs.

## Quickstart: ten lines to a first observed click

```bash
bun install
bun gauntlet &                                  # the hostile demo SPA on :4800
chromium --remote-debugging-port=9222 &         # or any Chromium you can attach to
bun cli/disco.ts session new gauntlet --attach 9222 --scope localhost:4800   # -> apps/gauntlet/store/
# open http://localhost:4800 in that browser; the daemon idle-observes ~20s to learn ambient traffic
bun cli/disco.ts act click 'role=button[name="Load Chart"]' --until-fn "() => document.querySelector('#chart-status')?.textContent === 'idle'"
#   act:1  click role=button[name="Load Chart"]  →  settled:network  (settled 112ms, reported 424ms; 3 req, 1 mut, 1 px)
#     timing: page 545ms (settled 112, reported 424, until 130) + overhead 38ms (resolve 9, pre 15, post 11, build 3) = 583ms
#     ✓ until: matched in 130ms  true
#     ⇄ GET /api/slow → 200, 29B, 104ms, application/json (task)  body:373f9a1b85b0
bun cli/disco.ts sql gauntlet "SELECT run, method, path, status FROM requests ORDER BY run, t_start"
bun cli/disco.ts session end gauntlet
```

Or launch a managed browser: `disco session new gauntlet --launch --headless --url http://localhost:4800`.

## The three faces (descending power, ascending convenience)

1. **The store.** `apps/<app>/store/store.sqlite` (WAL, one run-tagged history per app) + `blobs/` (sha256-addressed). Open it with
   `bun:sqlite`, the `sqlite3` CLI, or `disco sql` — schema in [schema.sql](schema.sql); read it, then
   write any SQL. Works with the daemon stopped. FTS5: `SELECT r.path FROM bodies b JOIN bodies_fts f
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

3. **The CLI** — every command is sugar over the two above; `disco help` for the tree.

`s.click(sel, opts)` / `s.type` / `s.fill` / `s.press` / … are one-line sugar over `s.act({ kind, … })`: one
action primitive, one settlement race, one report shape. **Two questions per step** (docs/using-disco.md):
`act()` answers *what did the app do?* (the verdict is evidence, never a readiness gate); `until` / `watch()`
answers *am I where I need to be?* — automation always passes `until`.

## ⚠️ In-page functions: closures do not transfer

`evaluate`, `evaluateAfter`, and `watch({fn})` ship your function **as source** into the page. It runs
there with nothing from your script's scope — no imported helpers, no captured variables. Pass data via
`args`/`evaluateAfterArg`; return JSON-serializable values. `world: "main"` sees the page's globals;
the default isolated world does not (but shares the DOM).

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
| `requests({urlLike, method, actionId, status, family, since, until})` | `SELECT * FROM requests WHERE url LIKE ? AND … ORDER BY t_start` |
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
(delayed validations) but not part of settlement.

## Report & watch shapes (the fields scripts should rely on)

`report.wire.attributed[i]` = `{ line, m, p, s, ms, body, id, family, a }` — use the structured
fields (`m`ethod, `p`ath, `s`tatus, `ms`, `body` = 16-char blob prefix), not the display `line`.
`report.settle = { ms, reportedMs, timeline, counts, pending? }`; `report.cursor = { from, to }`;
`report.until = { matched, elapsedMs, preview?|request?, diagnosis? }` when `until` was passed;
`report.timing = { resolveMs, absorbMs, preMs, settleMs, reportedMs, untilMs?, waitMs, postMs, buildMs, overheadMs, totalMs }`
(`waitMs` + `absorbMs` = page time; `overheadMs` = daemon work).
`watch(pred, {budgetMs, frame})` → `{ matched, elapsedMs, preview?, request?, diagnosis? }`; predicates (also
`act({until: pred})`, which adds `budgetMs`, `tailMs`, and `frame` for a postcondition in another frame):
`{selector, visible?}` | `{urlLike, landed?}` (for `watch`: started OR responded since watching; for `until`:
started after dispatch; `landed` = the response is back and the body's fate decided — captured, or known
uncapturable such as an `unread` fire-and-forget body after its 1.2s grace) | `{fn, fnArg?}` (in-page, called
with `fnArg`, truthy = match). A `frame` that doesn't exist yet is waited for, not thrown on; from `act()` it is
a `frame-not-found` diagnosis with a frame census.

## Timing model (GUIDANCE §4.2 + DECISIONS #16)

Settlement = quiescence race (network scoped to attributed-non-ambient requests / DOM minus ambient
churn roots / pixels minus the learned ignore mask and the target's own repaint) with Q=300ms, a fast
`no-effect` tier at 500ms, and a budget that measures **time since the last attributed network
evidence** (in-flight requests suspend it; `maxBudgetMs` bounds hung ones). Give the classifiers idle
time (`disco idle`, or the default idle observation at session start) before acting — reports carry
`classifierImmature` until then.

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
