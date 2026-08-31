<!-- Stranger #4 (Fable, 2026-08-31): the same job as stranger #3 on the same tree, 14m48s, 22/22. Its pack was comparable (18 functions, 35 transitions, 15 ledger rows); #3 stays as the adopted pack, this log is kept for its tool findings — folded back in DECISIONS #47. -->

# Friction log — the gauntlet pack (characterized as an unknown app), 2026-08-31

Where the tool or the docs got in the way, bluntly, in rough priority order. Reproducible from `apps/gauntlet/store/` run 1.

1. **`session new --launch --url` failed its own navigation** ("navigate failed: main frame not known yet") and left the tab on `about:blank`. Harmless once noticed — `disco act navigate` as act:1 observed the whole load — but the README sells `--launch --url` as the way to get the document load observed, and the first thing it did was not do that. The same message came back from `evaluate` on a target created 30 ms earlier (`Target.createTarget`); a freshly created target needs a beat before the daemon knows its main frame, and nothing waits for it.
2. **The store hides `Set-Cookie` / `Cookie`.** `requests.resp_headers` for `POST /api/login` had no `set-cookie`, and no later request carried a `cookie` header, so the store said "no cookie" while the app clearly had a session. `curl` settled it in one line (`set-cookie: gauntlet_auth=x; HttpOnly`). CDP only delivers those in the `*ExtraInfo` events; the capture should merge them, or the schema should say the columns are the non-ExtraInfo headers. Auth characterization is exactly where this bites.
3. **`fill` inside the cross-origin frame reports `no-effect`** (act:14) while same-origin `fill`s report `settled:visual` and the value visibly landed in all three (`ui.added: textbox "Name": Linus`). A verdict that says "nothing happened" next to a UI delta that says it did is a contradiction the report should reconcile (at least tag it "OOPIF: quiescence not observed").
4. **The write-flag has no answer for a mixed family.** `POST /api/graphql` is one family for a read (query) and a write (mutation); `families --mark-read` is per-family, so the choice is "flag the read" or "hide the write". A body-shaped rule (`--mark-read <family> --when-body <substring>`) or the GraphQL peek the docs mention would fix it; I distinguished them by the response's `operation` field in the function instead.
5. **A shell-quoting pitfall of my own, worth a doc line**: `sql … --json | tr -d '[]{}"'` left whitespace in the hash and `blob` then said "no blob matches prefix" with the whitespace embedded. `blob` could trim its argument.
6. **Drags settle `still-active` at ~1.2 s** because the page fires an unread `POST /api/drag-report`; the report shows `ms: null` and `body:-` and the verdict reads as "the page is busy" when it is really "a fire-and-forget body is in its 1.2 s grace". Naming the grace in the verdict line (the way `[unread]` is named in the wire line) would stop me pulling that thread twice.
7. **`sql` cell truncation at 60 chars again** (the openmrs log said the same): every interesting `resp_headers` / `req_body` needed `--json` or `substr`. Minor; `--wide` exists.
8. Small: the `sentinels` table has `detail` (JSON) not `title`/`text`; `sse_events` has `request_id` not `url`. Two `schema` calls fixed it — fine, but the CLI's own report lines print `title:` for sentinels, so the column name is a small surprise.

9. Mine, not the tool's: the first `run-check` failed at step 7 because I typed `/api/rows` as `string[]` from the report's text preview ("10000 rows Aardvark-Row-0 …") without opening the body — it is `{id,name,group}[]`. The README's own snippet (`rows[0].name`) had said so. Lesson: cite the body, not the preview. Second run: 22/22.

## What worked well (keep)

- **The control plane made recon trivial**: `GET /ctl` documented every armed behaviour before the first click, exactly as GUIDANCE §7.2 says to look for, and the WS `ctl` frame proved the page took each change live — `setScenario` has a real postcondition because of it.
- **Diagnosis-not-timeout paid off every time**: `occluded by … Allergy Review Required` (act:40) and `… Session expiring` (act:47/48) named the blocker in one turn; the `budget-expired` diagnosis on the shadow-DOM `until` (act:25) listed `focused: "#shadow-host"` which is the whole explanation.
- **The wire-first split is stark here**: 10 000 rows vs 24 DOM nodes, a 32-cell canvas with an API body, a 500 hidden behind "Saved ✓" — three functions read facts the screen never shows.
- **`until` on the act with `any`/`all` arms** handled the login-present-or-absent flow and the wire-AND-DOM record postcondition without a single sleep.
- **`timing-report`** gave the settle profile for the transition table from the store, no extra instrumentation.
