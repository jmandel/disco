<!-- Written by a fresh agent that rebuilt this pack from the docs ALONE (packs deleted, src/ forbidden) on 2026-08-30 — P4-A. Its pack replaced the original; this is its friction log, kept verbatim. Items were folded back in DECISIONS #41. -->

# Friction log — building the saucedemo pack from the docs alone (run 1, 2026-08-30)

Ground rules of this run: only README.md, docs/using-disco.md, apps/README.md, GUIDANCE.md §7–9,
PLATFORM.md, gauntlet/scenarios.md, apps/gauntlet/*, lib/, demos/, schema.sql, scripts/run-check.ts were
allowed; no src/, no DECISIONS/STATE. Every place the docs were unclear, wrong or missing — bluntly, in rough
priority order, with evidence. Praise at the bottom. Wall clock for the whole exercise: ~13 minutes
(22:18 → 22:31), of which the first 2 were lost to item #4.

1. **The library's API surface is documented nowhere I was allowed to read.** README:38-48 shows `connect`,
   `click`, `store.json`, `note`, `close`; using-disco.md:63-69 adds `fill`/`evaluate`/`watch`/`idle`; the
   CLI help lists the verbs. Nothing lists the `Session` methods or their signatures — `fill(target, text,
   opts)`, `navigate(url, opts)`, `press(key, opts)`, `select(target, value, opts)`, `evaluate(fn, opts)`,
   `targets()`, `end()`, `families()`, `awaitSettlement()`, `focusTarget()`, `onEvent()` — nor the full
   option set of an act beyond `until`/`budgetMs`/`frame`/`evaluateAfter`. I got the list by
   introspecting `Object.getPrototypeOf(s)` at runtime (scratch `introspect.ts`) — the only alternative was
   `src/client.ts`, which README:88 literally tells you to open ("helper source in `src/store.ts` doubles
   as schema-by-example"). *Wanted:* a one-screen method table in README (or a generated `.d.ts` excerpt
   pasted into using-disco.md) — signatures, return types, and which options each verb accepts.
2. **The worked examples the field guide leans on don't exist here.** using-disco.md:8-9 says "read
   `apps/openemr/lib.ts` and `apps/saucedemo/lib.ts` alongside this"; the recipe section (using-disco.md:240-258)
   annotates `openPatient` from a pack I couldn't see, calling `findPatient`, `openFinder`, `assertChart`,
   `reached` — three of which are never defined anywhere readable. apps/README.md:26-28 and PLATFORM.md:50-52,
   89-95 describe both packs as done. The one pack that *was* present (gauntlet) is wire-first, so the only
   DOM-first reference — the one this app needed — was a paragraph (using-disco.md:265-267) saying
   "saucedemo waits for *either* the inventory *or* the app's error banner" with no code. *Wanted:* the
   docs should not depend on sibling packs for their only recipe; put a complete 20-line DOM-first
   function (login with the success-OR-error disjunction and the thrown app text) inline.
3. **`evaluate`'s `args` contract is unstated and its failure is a raw engine error.** README:57-62 says
   "Pass data via `args`/`evaluateAfterArg`". It does not say `args` must be an **array of positional
   parameters**: `s.evaluate(fn, { args: { hello: 1 } })` threw `args.map is not a function. (In
   'args.map((a) => ({ value: a }))'…)` (scratch `evalprobe.ts`); `{ args: [1, 2] }` calls `fn(1, 2)`.
   Meanwhile `watch`/`until` use `fnArg` (a single value) and `evaluateAfter` uses `evaluateAfterArg` —
   three spellings for one idea. *Wanted:* one convention, documented with a two-line example; validate
   `args` and throw "args must be an array".
4. **`disco session new` blocks for the daemon's lifetime and the docs don't say so.** README:19,30 and
   using-disco.md:35-39 show it as a plain shell line. Run as `session new … --launch --headless --url … |
   tail -40`, it hung: my first command hit the 120s tool timeout and only exited 12 minutes later, when
   `session end` killed the daemon (`real 12m3.224s`). Nothing says whether it forks, what it prints
   (a families summary + a JSON blob, it turns out), how long the default idle observation is, or what
   `--fg` / `--no-idle` / `--idle-ms` (in `disco help`) mean. I learned the daemon was alive by reading
   `store/daemon.log` and `manifest.json`. *Wanted:* "returns after ~20s idle observation and leaves a
   background daemon; use `--fg` to keep it attached; don't pipe its stdout" in the quickstart.
5. **The CLI report drowns in `data:` URIs.** The app renders inline icons as `data:image/png;base64,…`
   / `data:image/svg+xml,…`; disco records each as a request whose *path is the whole URI* and prints it
   in full: act:3 printed two ~2.4KB base64 lines, act:34 four SVG lines, `families` lists them as
   `GET image/png;base64,iVBOR…` families with periodicity evidence, and the store's `requests.path` holds
   them. using-disco.md:284 promises "the report is ~300 tokens with handles". Worse, they are attributed
   `task` and make a pure client-side pushState `settled:network` (acts 3, 5, 41, 71) — and once the
   browser cache warms the *same* step becomes `settled:visual` (acts 77, 100, 112), so the label of an
   identical transition varies with cache state (ledger #11). *Wanted:* elide `data:` URLs to
   `data:image/png (2.4KB)` in reports/families, and don't let them (or cached subresources) decide the
   verdict — or at least document that subresource loads count as "network".
6. **`--eval` output is silently truncated, and printed last.** act:11's eval was cut mid-JSON at ~300
   chars (`…{"c`) with no marker of the cap or how to get the rest; nothing in the docs mentions a cap or
   the `--json` escape. And because `eval:` prints *after* the UI delta and the wire lines, any `head`
   on a long report loses exactly the line I asked for — I lost the evals of acts 101/103/106 that way
   and had to recover them from the store with `json_extract(report,'$.evaluateAfter')`. *Wanted:* print
   `eval` in full (it is the thing the user asked for), or a `--digest` flag (verdict + timing + until +
   eval, no delta/wire), and document `--json`.
7. **Sentinel spam from third-party telemetry.** act:1's report carried `⚑ sentinel error: "401"` **six
   times** with the same shot hash — the app's Backtrace telemetry (`events.backtrace.io`) 401s on every
   page load. A `404` sentinel fires on every deep link (the GitHub Pages fallback, nav-and-quirks §1). There
   is no documented way to mute a sentinel or mark a host as noise: `families --ambient` exists for
   attribution, sentinels have no equivalent. *Wanted:* dedupe identical sentinels within a window; a
   `sentinels --ignore host` or per-family "not an error" mark; and GUIDANCE §8 should list "third-party
   crash/telemetry reporters" as a failure-mode class next to heartbeats.
8. **A once-per-event third-party request held settlement 3.5s, and the docs offer no move for it.**
   The locked-out refusal renders its banner at ~8ms; a CORS-blocked `POST submit.backtrace.io/UNIVERSE/
   TOKEN/json` (attributed `task`) keeps the window open until it fails: `settled:network 3505/3486ms`
   (acts 18, 60). README:124-132 explains ambient classification for *periodic* traffic; this one fires
   only on refusals (n=5/5), so it will never look periodic. `until` on the banner fixes the *wait*
   (returns at the 1s tail as `still-active`, acts 65/91/127), but the verdict/settle numbers stay
   polluted for the ledger. *Wanted:* say whether `families --ambient F` also removes a family from the
   settlement race, and offer a scope/blocklist for hosts (my `--scope saucedemo.com` did not keep
   `backtrace.io` or `gstatic.com` out — "scope" reads like host filtering but is target filtering;
   using-disco.md:44 doesn't distinguish).
9. **The ambient classifier's thresholds are unstated.** README:129-132: "give the classifiers idle time".
   How much? What n / cv? After 12 minutes the telemetry families sat at `count=3, cv=0.33, ambient=0`.
   `disco families` prints no header row, so `read 3 POST events.backtrace.io/…` had to be guessed as
   `write_kind count family`. I never saw the promised `classifierImmature` flag in any printed report,
   so I can't tell whether it was set. *Wanted:* the rule ("≥N samples with cv<X"), a header line, and the
   flag in the CLI print.
10. **`no-effect` above a UI delta that shows everything happened.** The glitch user's login: `no-effect
    (settled 0ms, reported 499ms; 0 req, 0 mut, 0 px)` followed in the *same report* by `+ …38 more` lines
    of inventory and `→ url: /inventory.html` (acts 22, 26, 69, 94, 130). using-disco.md:265-267 predicts
    exactly this, so it is known — but the report contradicts itself, and without `until` the report still
    took 5.1s to return (act:30: "page 5016ms (settled 0, reported 500)") because the post-snapshot waited
    on the blocked main thread; the verdict isn't even a *fast* lie. Same shape as gauntlet friction #6.
    *Wanted:* `no-effect (late: N mutations after the tier)` or simply `settled:late` when the
    post-snapshot differs from the pre-snapshot.
11. **The failure-message recipe is missing.** lib/nav.ts `reached()` throws on `diagnosis` / unmatched
    `until` — good — but nothing shows how a pack function should surface *the app's own error text* when
    the postcondition is a disjunction (success OR banner). I built it (`until: {fn: inventory || banner}`
    + `evaluateAfter` reading the banner + throw) after one design iteration; the docs' only hint is the
    clause in using-disco.md:265-267. *Wanted:* that pattern as a named move in lib/nav (e.g.
    `untilEither(s, ok, err)` returning which one) or as the inline example in #2.
12. **The reference pack's evidence paths are stale.** apps/gauntlet/nav-and-quirks.md:3 cites
    `sessions/dryrun/store.sqlite`; its friction #8 discusses `sessions/` + `DISCO_SESSIONS_DIR`;
    PLATFORM.md:62 says "There is **no** top-level `sessions/`" and apps/README.md:12 says
    `apps/<target>/store/`. Two minutes of "where will my evidence land?" — the runtime answered
    (`apps/saucedemo/store/`), the docs disagreed with each other.
13. **The report JSON's inner paths are undocumented.** schema.sql:227 says `report TEXT -- JSON: the full
    report`; README:108-115 lists the top-level fields. To write ledger queries I needed
    `$.until.elapsedMs`, `$.until.matched`, `$.settle.reportedMs`, `$.timing.totalMs`, `$.evaluateAfter`,
    `$.wire.attributed[0].p` — learned by dumping one report through Python. `watch()` also returns `ok`
    alongside `matched` (the gauntlet scripts test `w.ok || w.matched`); README:116 documents only
    `matched`. *Wanted:* one annotated report JSON in the docs, with the SQL to reach each field.
14. **CLI `--until` grammar is only in `disco help`.** using-disco.md:53 shows `--until-url … --until-landed`;
    the selector form `--until '.inventory_list'` (which I used throughout) is undocumented outside the
    help line, and whether a bare selector means *present* or *visible* is stated nowhere (the printed
    match preview suggests present-with-box, matching `lib/nav`'s `visible: true`). `--until-budget` also
    only in the help.
15. **`scroll-absorb 242ms` appears on actions that didn't visibly scroll** (acts 7, 12, 37, 39, 41, 42,
    101, 102) and adds ~0.25s to each. using-disco.md:232-233 defines `absorbMs` as "the repaint after a
    scroll-into-view"; on a 960×650 viewport with the target in view the constant 241–242ms looks like a
    fixed wait rather than an observed repaint. Not a blocker; worth a sentence on when it triggers.
16. **Minor:** `disco sql --json` returns an array of row objects (useful; undocumented). `session new`
    accepts `--scope` in launch mode without saying whether it's needed (using-disco.md:44 says mandatory
    in attach mode only). `apps/.current` is written by `session new` (README of apps mentions it only in
    the gauntlet scripts README). The `families` columns `write` for the telemetry POSTs are technically
    right and irrelevant here — there is no state to write.

## Things I was tempted to open in src/ (and didn't)
- `src/client.ts` for the Session signatures (#1) — replaced by runtime prototype introspection.
- `src/report.ts` for the `Report`/`UntilResult`/`Diagnosis` types (#13) — replaced by dumping one stored report.
- `src/daemon.ts` to learn the settlement tiers and the `data:` handling (#5, #8) — worked around with `until`.
- `cli/commands.ts` for the eval-print cap and the `--until` flag semantics (#6, #14) — worked around with SQL.
`bunx tsc --noEmit -p .` passed on the first try, so the types were never *needed* — but I got there by
guessing option names from prose and letting the compiler confirm them, which is slower than a table.

## What worked notably well (keep)
- **`until` with a disjunction made every login path one turn.** Success (`.inventory_list`), refusal
  (`[data-test="error"]`), and the 5-second glitch user all ran through the same `login()` with only a
  budget; the glitch case needed zero special-casing (acts 22/26/69/94/130 — six runs, 5012–5115ms, all
  matched).
- **The `not-found` diagnosis taught me the idempotency rule.** act:54's near-matches named
  `remove-sauce-labs-backpack` in the same line as the miss; `addToCart` became idempotent in one edit.
- **`no-effect` with `0 mut` was the honest signal for the problem user's dead buttons** (acts 37/38/40) —
  the cheapest possible characterization of a broken control, and `fill` with real key events exposed the
  broken last-name field exactly as a human would see it (act:44 → value `""`).
- **The store answered every ledger question in one query.** n-counts, timings and verdicts per user came
  from `json_extract` over `actions.report`; the lost `eval` lines were recoverable; `disco note` put the
  interpretations next to the evidence, cited by act id (notes 1–5).
- **`scripts/run-check.ts` and the gauntlet `check.ts` shape transplanted unchanged** — first run
  all-PASS in a fresh profile; the *live* run's one FAIL was a real product fact (cart persistence,
  ledger #10) that the check now handles.
- **`lib/nav.ts` is small enough to read in full and was all I needed** (`reached`, `assertVisible`,
  `until`); no `lib/wire` on a wire-less app, as PLATFORM.md promised.
