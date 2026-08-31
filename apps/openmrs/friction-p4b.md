<!-- Written by a fresh agent that built this pack from the docs ALONE (other packs deleted, src/ forbidden) on 2026-08-30 — P4-B, 20 minutes, 6/6 live check on dev3.openmrs.org. Kept verbatim; items folded back in DECISIONS #42. -->

# Friction log — building the OpenMRS O3 pack from the docs alone (2026-08-30)

The experiment: a fresh engineer, allowed only the user-facing docs (README, `docs/using-disco.md`,
`apps/README.md`, GUIDANCE §7–9, PLATFORM, the gauntlet pack, `lib/`, `demos/`, `schema.sql`,
`scripts/run-check.ts`), builds a pack for an app nobody has driven with disco. Every place a doc was unclear,
wrong or missing, every time I wanted `src/`, every CLI/library stumble — blunt, numbered, with evidence.
`src/` was never opened; §"What I did instead" says how each gap was closed. Praise at the bottom.

1. **The library API is not documented anywhere I was allowed to read.** README:38–48 and using-disco.md:63–69
   show `connect`, `s.click(sel, opts)`, `r.wire.attributed`, `s.store.json`; the recipe (using-disco.md:246–258)
   adds `until`/`frame`/`budgetMs`. Nothing lists the `Session` methods, `evaluate`'s option bag, `navigate`'s
   existence, `store.sql/one/action/requests`, or the `Report`/`UntilResult` fields beyond README:108–122.
   I learned them by **runtime reflection** (`Object.getOwnPropertyNames(Object.getPrototypeOf(s))`) and by
   using `tsc` as an oracle (`const x: never = s.evaluate;` → the error prints the signature). That worked, but a
   fresh engineer should not need a trick. Wanted: a one-page API reference (or a pointer: "the types in
   `src/client.ts` are the contract — read `Session`"), reachable from README.
2. **`s.evaluate(fn, arg)` silently drops a second positional argument.** README:57–62 says "pass data via
   `args`" without showing the shape; the real signature is `evaluate(fn, { args: unknown[], frame?, world? })`.
   My first probe printed `undefined` (`.scratch/reflect.ts`). One example line in README would have saved it.
3. **`disco session new --launch` blocks the terminal until `session end`.** README:30 and using-disco.md:38 show
   it as a one-liner between other commands. In launch mode the CLI stays alive as the browser's parent: my first
   invocation sat for 3m29s until I ended the run from another shell. `--fg` in `disco help` implies the default
   is background; it is not, for `--launch`. Wanted: either daemonize, or say "`&` it / use `--fg` semantics" next
   to the launch example.
4. **The login request was hidden as "ambient" — a `chained` false positive.** O3 fetches `GET /ws/rest/v1/session`
   2–3 times back-to-back on every route change; after ~20 the classifier tagged the family `ambient (chained)`
   (`families.evidence` gaps `[149,260,19399,224,…]`). From then on the report for the Log in click read
   **"0 req, ~1 ambient request(s)"** — the one request that decides whether login worked (act:23, act:27, act:31).
   GUIDANCE §10 anticipates "long-polls that carry action results"; this is the simpler case: a burst-fetched
   *read* endpoint. Wanted: (a) `chained` should require the *long-poll* shape (held responses), not merely a
   ≤250ms gap between short responses; (b) the report should list ambient-tagged requests **inside the task
   tier** (started within 30ms of the input) by name, not as a count; (c) `disco families --not-ambient` is the
   manual fix and using-disco.md never mentions it (only `mark-read`, l.322).
5. **Ambient classification did not converge on real EHR heartbeats even after the prescribed `disco idle 120000`.**
   using-disco.md:43–44 promises ≥3 cycles ≈ 2 min. The home page's SWR polls fire in same-family bursts (2×
   `Location`, 2× `queue-entry`, 3× `obs` per cycle), so the gap series is `[0,60001,2,120066,33]` → cv 1.3–1.9 >
   `ambientMaxCv 0.3`, never ambient. Marking manually worked (`disco families --ambient F`), but the family is the
   path shape **without the query string**, so marking `GET …/fhir2/R4/Location` also swallowed the login-location
   list the picker fetches (act:5: `Location?_tag=Login+Location` tagged `ambient`). Wanted: collapse bursts
   (gap < 100ms) before computing cv; and either finer families (query-key aware) or a note that manual marks are
   coarse.
6. **`disco idle` prints the entire families table as JSON — 33KB, including `data:image/svg+xml;base64,…` "families".**
   Unusable in a terminal; the 2-line digest `session new` prints ("families: N, ambient: M") is what I wanted,
   plus the ambient rows. Also data-URI "requests" should not be families at all.
7. **The report's wire digest ranks megabyte JS chunks above the API calls.** act:4 (login) and act:11 (chart
   open) show 8 lines of `openmrs-esm-*-app/….js → 200, 1.3MB` and "+71 more"/"+104 more"; every REST/FHIR request
   was in the hidden tail. I re-queried the store after every big action. Wanted: `resource_type IN (XHR, Fetch,
   Document, WebSocket, EventSource)` first, scripts/styles/images last (or collapsed to one line "+52 static").
8. **Sentinel false positives: 50 "toast" sentinels in one run, ~3 real.** Carbon's `role=status` loaders
   ("loading", "Logging in…", "Submitting"), inline notifications, and — worst — **DataTable rows** ("Auto9263
   Patient15--Not UrgentWaiting…", "Osteoarthritis of knee04 — Aug — 2026Active…") all fire the toast sentinel; the
   manifest icon 404 fires `error` on every load; `session_expiry` fired once on the logout page with nothing
   expiring. The docs (using-disco.md:56–60, GUIDANCE §5.3) present sentinels as the way to catch interstitials;
   on a Carbon app they are mostly noise. Wanted: dedupe by selector+text within a window; exclude `role=row`;
   a per-app mute list promoted into the pack.
9. **`occluded` diagnosis for a control whose occluder is its own `<label>`.** act:6: `role=radio[name="Outpatient
   Clinic"]` → "occluded by `span.cds--radio-button__appearance` from `label[for=…]` subtree". A click on that span
   *is* the way to toggle the radio; Playwright treats the label subtree as a valid hit target. The fix (click the
   label) is easy once known, but the docs' selector section (README:91–97) says role selectors work "everywhere".
   Wanted: hit-test should accept an occluder inside the target's `<label>` (or the target's `labels`), and the
   diagnosis should suggest it.
10. **`until` cannot express AND/OR.** `Pred` is one of selector | urlLike | fn. Login's postcondition is "shell OR
    picker OR error banner"; chart open is "URL has uuid AND banner rendered"; a wire-and-DOM postcondition ("the
    `Patient/<uuid>` body landed AND the banner is up") is impossible in one `until`. Everything collapsed into
    `fn` predicates — which then need `fnArg` plumbing and cannot see the wire at all. Wanted: `until: [predA, predB]`
    (all) / `{ any: [...] }` — or at least a documented pattern.
11. **`watch({urlLike})` semantics vs. already-landed requests.** README:117–119: for `watch`, "started OR responded
    since watching". So `until(s, {urlLike, landed:true})` *after* an action expires if the response already came
    back — a trap for the natural "act, then confirm the wire" sequence. I avoided it by reading the store
    (`lastBody`), which the docs do recommend, but the trap deserves a sentence in the `until()` doc-comment.
12. **Closures do not transfer — and nothing warns you.** README:57–62 says it; I still shipped
    `document.querySelector(SEL_ERR)` inside an `until.fn` (a module constant). `tsc` was happy, the page would have
    thrown `ReferenceError` at runtime. Caught by re-reading my own code, not by the tool. Wanted: `act`/`watch` could
    check the function source for free identifiers that are not globals and fail fast with "closure capture: SEL_ERR".
13. **`families` has no `run` column.** After the o3 → dev3 host switch (same app dir, run 2) the table still
    carried run 1's Cloudflare families and their ambient marks (`GET https://challenges.cloudflare.com/* ambient
    periodic`). Harmless here, misleading in `disco families` output; PLATFORM.md:60–71 says "every run-scoped row
    carries `run`" — this one doesn't (schema.sql:245–254).
14. **The worked examples the field guide leans on are not in the tree I was given.** using-disco.md:8–11 names
    `apps/openemr/lib.ts` and `apps/saucedemo/lib.ts` as the packs to "read alongside", and the recipe at l.246–258 is
    an OpenEMR excerpt; `apps/README.md:26–28` and PLATFORM.md:82–95 describe them. Only `apps/gauntlet/` existed.
    (Deliberate for this experiment — but it means the only end-to-end example of `login`/`findPatient`/`openPatient`
    /`extractSummary` was 12 lines. The gauntlet pack has no login, no navigation, no multi-page anchors.)
15. **`scripts/run-check.ts` opens the URL and gates only on `body` visible** (l.31). For an SPA that is "an empty div
    with 50 scripts pending"; the pack's first act ran against a half-hydrated form (friction 1 → nav-and-quirks §5.1).
    Wanted: let `check.ts` export an optional `ready` predicate, or document that `check()` must assert its own anchor
    before acting (I now do: `login` re-navigates when `whereAmI` is `other`).
16. **CLI: `--until-landed` exists (README:53) but is missing from `disco help`'s `act` line**; `--until-url` matches
    the request URL (substring), while `--until-fn` is the only way to wait for the *page* URL — I guessed both.
17. **CLI: `act navigate` is in the kind list but the report line prints just `act:13  navigate  →`** with no URL;
    `sql`'s pretty table truncates nothing and has no `--limit`, so one query with `v=custom:(…)` URLs produced 55KB
    (I learned to `substr(url, instr(url,'/ws/'), n)`). A `--cols`/width cap, or `path`+`query` columns, would help.
18. **`defaults.ts` is where the numbers live, and it is outside the docs.** README:137 mentions it; to know
    `untilBudgetMs 5000`, `budgetMs 3000`, `maxBudgetMs 20000`, `watchBudgetMs 1500`, `trailingAttributionMs 1500`
    I read it (it is a config file, not `src/`, but the rules of the experiment made me hesitate). Wanted: the
    handful of user-facing defaults inline in README's "Timing model".
19. **The store path for a pack is `apps/<app>/store/`, but the gauntlet pack's own docs still say
    `sessions/dryrun/store.sqlite`** (apps/gauntlet/nav-and-quirks.md:3, ledger.md:3, scripts/README.md:15–21 mention
    `apps/.current`, README:19 says `apps/gauntlet/store/`). Two generations of layout in the reference pack.
20. **GUIDANCE §7.2 says "read the classifier's families (`ambient_families` table)"** — the table is `families`
    (schema.sql:245). And "`disco settle --idle` re-runs it" — the command is `disco idle [ms]` per `disco help`.
21. **Cloudflare / bot-scored hosts are not mentioned anywhere.** The first 5 minutes went to a 403 "Just a moment…"
    page; the tool gave me the evidence (targets census showed the `challenges.cloudflare.com` iframe; the
    screenshot showed the Turnstile checkbox) but no doc says "headless Chromium will be bot-scored; attach to a
    real browser or expect Turnstile". Worth a line in using-disco.md's instrument step.
22. **Minor:** the aria delta for navigations lists dozens of `+ - img` lines (act:9: 10× `img` then "+33 more") —
    avatars; the `digestMaxUiLinesNav` cap exists but images should be collapsed first. `still moving: … req 302426.225,
    req 302426.228, …` lists request ids that nothing in the CLI can resolve (`disco sql "… WHERE id=?"` works, but
    the report could print the path).

## Temptations to open `src/` (none acted on)
- `src/client.ts` — for the `Session` surface (friction 1, 2). Closed with reflection + the `tsc` oracle.
- `src/report.ts` — for `Diagnosis`/`Report` fields (`r.until`, `r.diagnosis.reason`). Closed by `lib/nav.ts` (which
  imports the types and uses `r.until.matched`, `dg.reason`, `dg.occludedBy`, `dg.candidates`, `dg.pendingRequests`).
- `src/store.ts` — for `requests()`' filter names. Closed by `lib/wire.ts` (`{urlLike, actionId}`) and by writing SQL.
- the ambient classifier — to understand `chained` (friction 4). Closed by `families.evidence` JSON + `defaults.ts`.

## What worked notably well (keep)
- **`act` + `until` with the report as the diagnostic** carried the whole exploration: 31 acts, 24 with `until`,
  24 matched; the one `diagnosis` (act:6) named the occluder and the fix was one turn away. No sleeps anywhere.
- **The store answered every retroactive question** — endpoint inventory, param decoding, body shapes, timing
  gaps, "which request carried the location list" — in one SQL each; `--json` + a python one-liner was the
  workflow. FTS was not even needed.
- **`lib/nav.ts` is exactly the right size**: `until`/`reached`/`assertVisible` were all the pack needed;
  `diagnosisLine` made every thrown error self-explanatory (the run-check #1 failure message *was* the bug report).
- **`scripts/run-check.ts`'s contract (`target` + `check(s)`) is trivial to satisfy** and the cold-browser run
  found a real hydration race the warm session never showed — the drift loop earned its keep on day one.
- **The timing line** (`page 1368ms (settled 110, until 1013) + overhead 50ms`) told me the demo was slow, not the tool:
  5% overhead across the run (`bun scripts/timing-report.ts openmrs`).
- **Write flags** caught the three writes on read flows (`✎ POST /user/<uuid>` on chart open) without being asked.
