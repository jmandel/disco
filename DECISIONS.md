# DECISIONS — disco v4

One line each. A fold-back that adds an option, predicate, command, file or concept must delete one and add a line here.

- **2026-09-01 v4 from v2.** Engine kept (CDP attach, no page instrumentation, always-on SQLite recorder). API, predicate DSL and 5-file pack replaced. Why: every friction round added a predicate nuance; the agent should write Playwright, and the report should carry the evidence.
- **Three verbs.** `look`, `act`, `sql` (+ `body`, `json`), plus `waitFor` and `reached`. Nothing wraps what Playwright or SQL already do. Enforced by `test/budget.test.ts`.
- **`act` is a bracket around the agent's code**, not a set of action kinds. Playwright's own error message names the locator; the diagnosis rebuilds it and hit-tests it.
- **One budget per act: `max`.** It is the default timeout of every Playwright call inside `run` and `until`, and the longest the act observes. A failing click is diagnosed within max; pass a small max while probing.
- **Bare acts return on quiet, not after a fixed window.** Quiet = no request/response/frame/console/dialog/nav, no DOM change, and no request this act started still awaiting its response. A long-poll that predates the act does not block. `returned` and `pending` say what happened; no verdict.
- **The report proposes untils.** Responses, appeared/gone roles (with state: selected/expanded/checked), url path, storage — each false before the action by construction. This replaces the README's predicate teaching.
- **`alreadyTrue` is generic**: any until that resolved before dispatch. A navigation's until is the `nav` event (`s.waitFor("nav", …)`), which is false before a goto even when the page was already there.
- **`look` renders marks in a scratch page of ours**, never in the app's page. Full page, capped at 4000 px, document coordinates.
- **Storage snapshots use `context.cookies()`** so HttpOnly session cookies show. sessionStorage included.
- **`json()` waits up to 1 s for a body still arriving**, then answers from the log.
- **`stats` is `scripts/stats.ts`, not a CLI command** — a dev-side scorecard for the exam loop, outside the five commands.
- **`_record` is an internal subcommand** spawned by `open`; not counted as a command.
- **Pack = `README.md` + `sdk.ts`** (+ gitignored `store/`, + `evidence/` the agent copies by hand). `sdk.ts` exports workflows and `check(s)`, and runs its own check under `import.meta.main`. No check runner, no notes file, no wire file.
- **No `withApp`.** A script closes in `finally`; the README says so once.

## Exam A fold-back (2026-09-01) — 30 friction items from three strangers (gauntlet 22 min/31 checks, saucedemo 22 min/13, openmrs 18 min/5, all cold-green)

- **open navigates as its own act** and returns once the page is quiet; the CLI prints `navigated to` / `joined at`. Why: a SPA redirect or late `navigated` event after `open` returned made the first act's `waitFor("nav")` already-true (saucedemo #1, openmrs #3).
- **open prefers a page no other page opened.** Why: after a popup, both pages matched the url prefix and the CLI drove the child (gauntlet #6).
- **`until.value` keeps JSON objects (≤ 2 KB).** Why: a `waitFor("ws")` resolution was dropped silently (gauntlet #3).
- **Text-line proposals wait on the page's whitespace-stripped text**, not `getByText`. Why: an aria text line merges sibling elements no single element contains (gauntlet #1).
- **An already-true or failed until gets a note with its target's state now**, and a failed response wait lists what answered in the 5 s before the act. Why: "already true" with nothing saying what was true (saucedemo #2); SWR de-duplication answered before the click and the failed until said nothing (openmrs #1).
- **Third-party requests (another site) are folded out of the wire, `writes`, `pending`, and the quiet check.** Why: a CORS-blocked telemetry POST made every bare act hit max and read as a write (saucedemo #4).
- **`json` prefers a path-boundary match.** Why: `/queue-entry` returned `/queue-entry-metrics` (openmrs #2).
- **`look` lists anchors without href, `[tabindex]`, `[onclick]`, `[draggable]`, and walks open shadow roots**; off-viewport reasons use page coordinates. Why: the cart link and a shadow button were missing (saucedemo #5, gauntlet #9).
- **An unnamed dialog is marked `(unnamed …)` in the census.** Why: `look` showed a heading that `getByRole` could not match (gauntlet #5).
- **Screenshots are `<hash>.jpg` and `shots` carries the page url.** Why: blobs without extension could not be viewed or cited as-is (saucedemo #7).
- **A diagnosis for `document is not defined` / `Failed to parse URL` says the code runs in Node**; one README sentence says the same. (gauntlet #7, saucedemo #8)
- **`--json` and `--headed` never take a value**; a clipped `value:` line says so. (saucedemo #3)
- **Proposals print before the wire.** Why: 500-line diffs pushed them off the screen (openmrs #7).
- **A reorder with no additions is noted.** (saucedemo #6)
- **The template's check closes without killing the browser**; README says warm first, cold after `disco close`. (saucedemo #9, openmrs #5)
- **README sentences:** code runs in Node; event shapes and `sql` returns rows; `writes` is `string[]` and `reached` accepts a bare act; the evidence one-liner; a run is one browser's life. (gauntlet #10, openmrs #4/#6/#8)
- **Rejected:** server knobs leaking across sessions (the app's; the warm-from-messy rule caught it, gauntlet #2); long-poll attribution by start time (documented, gauntlet #4); folding diff lines that only change a number (a verdict, gauntlet #8); guessed column names that the error already explains (gauntlet #11, openmrs #9); a "wait for all bodies of this act" helper (`json` waits 1 s; `sql` covers the rest, openmrs #2b).
