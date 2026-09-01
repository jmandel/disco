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
