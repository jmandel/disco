<!-- Stranger #2 (Opus, 2026-08-31): built this pack in 26m06s from prompts/characterize-ehr.md with the fixed tool; 12/12 live check, 71 actions. Kept verbatim; items folded back in DECISIONS #45. The earlier pack's log is friction-p4b.md. -->

# Friction log — OpenMRS O3 pack (instance #4), 2026-08-31

Where the tool or the docs fought me, bluntly, in rough priority order. Praise at the bottom so the
roadmap items stand out. Everything here is reproducible from `apps/openmrs/store/`.

1. **`any` nested inside `all` never matches — silently.** `assertShell` wanted "the right route AND one
   of three header landmarks". Written the obvious way it is false for the whole budget:
   ```
   watch({ any: [ {selector: X, visible: true} ] })                    → matched in 5ms
   watch({ all: [ {fn: () => true}, { any: [ same arm ] } ] })         → NOT matched in 1500ms
   watch({ all: [ {fn: () => true}, {selector: X, visible: true} ] })  → matched in 8ms
   ```
   Flat `any` works, flat `all` works, **nested does not** — and the failure looks exactly like "your
   selector is wrong": a `budget-expired` diagnosis with a census, no hint that the combinator was the
   problem. README documents `{any: [pred, …]}` / `{all: [pred, …]}` where `pred` is a `Pred`, which is
   recursive by type, so this reads as a bug rather than a documented limit. Cost: one whole check run
   (~90 s) plus the probe to isolate it. Fix: support nesting, or reject a nested combinator loudly at
   the RPC boundary. Workaround now in the pack: collapse the disjunction into one in-page `fn`.

2. **`--launch` reads a stale DevTools port out of the reused profile.** After `session end`,
   `session new … --launch` reported `port=42527` — the *previous* run's port — and then died with
   `ConnectionRefused` on `/json/version`. `src/launch.ts` points Chromium's stderr at
   `<userDataDir>/chromium.stderr.log` and regexes the **first** `DevTools listening on …` in it; the file
   is not truncated between launches, so run 2 matched run 1's line. `rm -rf apps/<app>/store/profile`
   fixed it. Fix: truncate the file before spawn (or match the *last* occurrence, or ignore lines written
   before spawn time). This is a guaranteed stumble for anyone who relaunches a session, which is exactly
   what you do when the first host turns out to be bot-walled.

3. **A 60-second heartbeat is unlearnable in practice.** `disco idle 150000` on a page whose only timer is
   a 60.0 s refresh reported *"133 families, 0 ambient"* — the rule needs ≥3 samples, so ≥4 minutes of
   idle, and the docs' own EHR advice ("`disco idle 120000` for minute-scale heartbeats") is **not enough
   for the most common EHR cadence there is**. Either the doc number should be 240000, or the classifier
   should accept 2 samples when the gap is within a few ms of a round period (60 051 / 60 001 / 60 003 ms
   here — that is a cron, not a coincidence). I spent the budget on measured `ignore()` rules instead,
   which is the right answer, but the tool made me discover that the hard way.

4. **`s.settle` does not exist** (it is `s.awaitSettlement`), while the CLI verb *is* `disco settle`, and
   the README's one-screen `Session` surface lists `s.awaitSettlement` in a dense line that is easy to
   read past. Minor, but it is a TypeError in the middle of a driving script.

5. **`store.requests({urlLike})` needs `%` wildcards that `extractFromWire` adds for you.** Two adjacent
   APIs with different conventions: `extractFromWire({urlLike: "Condition"})` matches a substring;
   `store.requests({urlLike: "Condition"})` matches the *whole* URL and returns nothing. I wrote the
   second and got an empty list with no complaint. Make `requests()` wrap bare terms, or name the
   parameter `urlLikePattern`.

6. **`disco sql` cells are truncated at 60 chars by default**, which is exactly wrong for this app: every
   interesting URL is a `v=custom:(…)` projection whose distinguishing part (`limit=10` vs `limit=50`,
   `includeInactive`) is at the *end*. `--json` fixes it, but the default cost me two round trips before I
   started reaching for `substr(url, N, M)`.

7. **No `disco body <hash>`.** The docs' "digest → drill" workflow says to open a body by its 12-char
   handle; the CLI verb is `blob`, and `body` is an error. A one-line alias would match the vocabulary the
   reports themselves print (`body:e0d103b5c251`).

8. Minor: `report.until.which` is empty for a plain (non-`any`) postcondition — fine — but it is also
   empty when the matched arm has no `name`, which makes the `firstOf`-style "which state am I in" read
   ambiguous unless you always name arms. Worth a sentence in the docs.

## What worked notably well (keep)

- **The instrument step caught the bot wall before I invested anything.** `session new` against
  `o3.openmrs.org` printed *"the page you attached to looks like a BOT CHALLENGE (title 'Just a
  moment…')"* on the very first command. That is the single highest-value 200 ms in the whole run — the
  job named that host, and without the warning I would have spent minutes driving a Cloudflare page.
- **Diagnosis-not-timeout paid for itself three times**: `/Allergies` vs `/allergies` (the census printed
  the real URL), the `.cds--pagination` that does not exist (near-matches listed the real buttons), and —
  the best one — `focused: "#table-toolbar-search-:rr:"` in the failing search step, which is the entire
  explanation of the wrong-search-box bug in one field.
- **Wire-first reading is trivially good on this app.** `extractFromWire` + FHIR bundles meant
  problems/allergies/meds/vitals came out of four captured bodies with zero DOM scraping, and
  `searchResults()` reads 350 patients the DOM never rendered.
- **The write-flag was right and mattered.** It flagged the one non-GET the flows cause
  (`POST user/<uuid>` → `patientsVisited`), which is precisely the fact a read-only stance has to declare
  and which I would never have found by watching the screen.
- **`timing-report` closed the loop**: 6 % of act() time is daemon work; the settle profile in
  `nav-and-quirks.md §5` is measured, not asserted.
