# Friction log — disco dry run (session `dryrun`, 2026-08-30)

Every point where the tool fought me, bluntly, in rough priority order. Praise at the bottom so the
roadmap items stand out.

1. **The library's report shape is undocumented and diverges from the README teaser.** README's
   "Reports in one screen" and the CLI's pretty-printer imply per-request fields; the actual
   `report.wire.attributed[i]` is `{line, body, id, family, a}` — the interesting parts (method, path,
   status, size) are baked into a display string `line`, so a script that wants the status must regex
   the line or re-query the store. Likewise `settleMs` doesn't exist (it's `settle.ms`), and `cursor`
   is `{from,to}`, not the documented `ev:a-b` handle. I burned act:2's turn dumping raw JSON to learn
   this. Fix: export/document the `Report` type in README, or make wire entries structured and derive
   `line` for display.
2. **Pre-attach WebSockets are invisible, silently.** The app's WS was opened before `session new`
   attached (target `late=1`); `websockets` stayed empty while the app's own header showed "ws: open ·
   frames: 34". Nothing in the tool surface said "there is a socket I cannot see" — I only caught it
   because the target app happens to render its WS state on screen. Cost: a full page reload (act:3) to
   bring the socket under instrumentation, which also reset app state. Wanted: on late attach, an
   in-page probe (or a note in the session-start output / target row) that flags live sockets and
   EventSources the daemon isn't tracking, so the agent knows a reload is needed *before* acting.
3. **Causally-downstream requests just outside the window get attribution `none`.** Save settles at
   34ms (POST completes fast); the app's own follow-up `GET /api/save/status` fires at +520ms and the
   toast rides on it — attribution `none`, invisible in act:14's report. The report verdict was
   "settled" while the flow's most interesting wire event hadn't happened yet. Wanted: a
   post-settlement grace tier (tag as `post-window` with low confidence), or let `awaitSettlement
   {action: "act:N"}` reopen/extend the closed window so the follow-up lands attributed. Same story
   for the delayed record modal (sentinel catches it, but its *fetch*, had it made one, would be `none`).
4. **`watch()` predicates can't take arguments** (`evaluateAfter` has `evaluateAfterArg`; `watch.fn`
   has nothing), so "did X change from the value I just read" needs the baseline inlined into the
   function source by string interpolation, or a manual re-check. Also the resolved shape
   (`{matched, ok, elapsedMs, preview}`) is undocumented — I probed `w.verdict` first (undefined).
5. **Response bodies of failed requests can be lost.** `POST /api/login → 401` has
   `body_state='unread'` — whatever hint the 401 body carried (this login page is a discovery dead-end
   without creds) wasn't captured. If `unread` is an eviction/timing artifact it should be rarer than
   this; if 4xx bodies aren't eagerly fetched, they should be — error bodies are premium discovery data.
6. **Verdict `no-effect` while the DOM demonstrably changed** (act:23: hover with
   `rerenderOnHover:true`; `data-gen` 1877→1889 across the window, `evaluateAfter` proves it). Either
   the mutation batch missed the window or it was classified out; either way "no-effect" overclaims.
   A `no-effect (N mutations reclassified/late)` qualifier would keep the fast tier honest.
7. **Diagnosis cursor can be an empty inverted range** (act:10: `{from:2321, to:2320}`). Cosmetic,
   but it breaks the "cite ev:a-b" convention for exactly the reports you most want to cite.
8. **Session resolution is cwd-relative** (`sessions/` under cwd unless `DISCO_SESSIONS_DIR`), and
   this agent's shell resets cwd every call; every script needed absolute repo paths or env vars.
   A `--sessions-dir` note in error text helped; still, an env-var mention in README's quickstart
   would save the first stumble.
9. Minor: toast sentinel `detail.area` was 0 for a visible toast; `families.write_kind` for
   `POST /api/graphql` stays `read` while individual mutations are ✎write-flagged — correct once
   understood (ledger #12), but the family column alone reads as misclassification.

## What worked notably well (keep)
- **Diagnosis-not-timeout paid off twice in one flow**: act:10 (`occluded`, with the dialog census
  naming `#record-modal` and its ack button) and act:30 (combobox option click) — each cost one turn
  and produced the *reason*, plus pending-request context, no 30s waits anywhere in the session.
- **Sentinels caught every interstitial without being asked**: 5 dialog firings (incl. one with
  `action_id NULL` while I was between actions), 2 toasts with screenshots, new-target on the child
  window. The variability ledger's rows 1-4 are substantially sentinel output.
- **sse_events** made the "streaming bodies are uncaptured" gap moot for EventSource traffic: all 5
  `/api/sse` events plus the `/api/notify-sse` push landed queryably.
- **Ambient classification with visible evidence** (`families.evidence` gaps/cv): heartbeat, 3s poll,
  and even the 25s notify-poll long-poll never held a settlement open, and act:37 shows in-window
  ambient traffic correctly tagged instead of hidden.
- The store schema read exactly as documented; every question in this session was answerable in one
  SQL query or one `openStore` script, including FTS (`"via poll"` found the delivery my UI check missed).
