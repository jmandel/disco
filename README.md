# disco — the discovery daemon

Observation-first browser instrumentation for agents. Every action is an experiment that returns an
observation report; everything the browser does — screen and wire — lands queryably in SQLite + blobs.
Constitution: [GUIDANCE.md](GUIDANCE.md). Construction plan: [BRIEF.md](BRIEF.md). Decisions/divergences:
[DECISIONS.md](DECISIONS.md). Loop state: [STATE.md](STATE.md).

## Quickstart: ten lines to a first observed click

```bash
bun install
bun gauntlet &                                  # the hostile demo SPA on :4800
chromium --remote-debugging-port=9222 &         # or any Chromium you can attach to
bun cli/disco.ts session new s1 --attach 9222 --scope localhost:4800
# open http://localhost:4800 in that browser; the daemon idle-observes ~20s to learn ambient traffic
bun cli/disco.ts act click 'role=button[name="Load Chart"]'
#   act:1  click …  →  settled:network  (settled 743ms; 3 req, 6 mut, 2 px)
#   ⇄ GET /api/slow → 200, 29B, application/json (task)  body:0b41…
bun cli/disco.ts sql "SELECT method, path, status, resp_size FROM requests ORDER BY t_start"
bun cli/disco.ts session end
```

Or launch a managed browser: `disco session new s1 --launch --headless --url http://localhost:4800`.

## The three faces (descending power, ascending convenience)

1. **The store.** `sessions/<name>/store.sqlite` (WAL) + `blobs/` (sha256-addressed). Open it with
   `bun:sqlite`, the `sqlite3` CLI, or `disco sql` — schema in [schema.sql](schema.sql); read it, then
   write any SQL. Works with the daemon stopped. FTS5: `SELECT r.path FROM bodies b JOIN bodies_fts f
   ON f.rowid=b.rowid JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH '"Zebra-Row-9741"'`.
2. **The library** (`src/client.ts`), for Bun scripts:

```ts
import { connect } from "./src/client.ts";       // path or add an import map entry
const s = await connect();                        // current session (or connect("name"))
const r = await s.click('role=button[name="Load Rows"]');
const rows = s.store.json(r.wire!.attributed[0].body!);   // same process, no daemon round trip
console.log(rows.length, rows[0].name, rows.at(-1).name); // the wire had all 10k rows
await s.note(`rows are wire-available at ${r.wire!.attributed[0].family}`, { kind: "ledger", action: r.action });
s.close();
```

3. **The CLI** — every command is sugar over the two above; `disco help` for the tree.

## ⚠️ In-page functions: closures do not transfer

`evaluate`, `evaluateAfter`, and `watch({fn})` ship your function **as source** into the page. It runs
there with nothing from your script's scope — no imported helpers, no captured variables. Pass data via
`args`/`evaluateAfterArg`; return JSON-serializable values. `world: "main"` sees the page's globals;
the default isolated world does not (but shares the DOM).

## Reports in one screen

verdict (`no-effect` | `settled:network|dom|visual` | `still-active` | `navigated` | `dialog` |
`new-target` | `download` | `diagnosis`) + settlement timeline; semantic UI delta (aria-snapshot diff);
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
`>>` chaining, shadow-piercing). Frames: `{frame: "xframe.html"}` (URL substring), a frame id, or
`main`. Cross-origin iframes resolve in their own target; input is dispatched on the root page with
translated coordinates.

## Timing model (GUIDANCE §4.2 + DECISIONS #16)

Settlement = quiescence race (network scoped to attributed-non-ambient requests / DOM minus ambient
churn roots / pixels minus the learned ignore mask and the target's own repaint) with Q=300ms, a fast
`no-effect` tier at 500ms, and a budget that measures **time since the last attributed network
evidence** (in-flight requests suspend it; `maxBudgetMs` bounds hung ones). Give the classifiers idle
time (`disco idle`, or the default idle observation at session start) before acting — reports carry
`classifierImmature` until then.

## Running the tests

`bun test` — unit (fake clocks), gauntlet server contracts, and four acceptance suites that launch a
headless Chromium against the gauntlet. `bunx tsc --noEmit -p .` for types.
