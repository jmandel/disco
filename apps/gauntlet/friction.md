<!-- Stranger #3 (Opus, 2026-08-31): characterized the gauntlet as an unknown app from prompts/characterize-app.md in 15m37s — 25/25 live check, 63 actions. Kept verbatim; items folded back in DECISIONS #46. The original dry-run log (Slice 8, 2026-08-30) is friction-dryrun.md. -->

# friction log — building the gauntlet pack

Where the tool or the docs cost me time. Short, and each with what I did instead.

1. **`session new --launch --url` still leaves an unobserved prefix.** `targets.late=1` and run 1 has no
   `GET /` document request — only `/app.js`, `/style.css`, the iframes. The README says attach mode has
   this problem and implies `--launch --url` is the fix; it is not, at least not for the top-level
   document. Cost: two minutes of confusion reading "the wire at rest". Route-around: one `s.navigate()`
   after the session is up captures the full load (act:31, act:45) — worth doing routinely.

2. **`connect("gauntlet")` resolves `apps/` relative to the *script's* directory, not the repo.** A
   helper script in a scratch dir threw ``no app "gauntlet" under <scratch>/apps``. Fine once known, but
   the error names the wrong thing to fix. Route-around: pass an absolute path to the product home.

3. **`s.scroll({ target, deltaY })` scrolls the page, not the target**, unless the pointer already sits
   over the container. `#rows` stayed at `scrollTop 0` while `window.scrollY` went to 2554. `hover()`
   first and it works. Not a bug exactly — wheel events *do* follow the pointer — but the option name
   `target` reads like "scroll this element", and nothing in the docs says otherwise.

4. **`document.body.textContent` includes `<script>` source**, which quietly broke an `until` disjunction:
   my "did it refuse?" arm was `/invalid|denied|fail/i.test(document.body.textContent)` and it matched the
   login page's own inline handler (which contains the word "failed"). `until.which` said `err` on a login
   that had actually succeeded. My mistake, but it is the kind of mistake a page-function predicate makes
   easy — the docs' "page functions capture nothing" warning has a sibling worth adding: *page functions
   see the whole DOM, including code*.

5. **The write flag needed no correction here, which is itself worth reporting.** The GraphQL body peek
   distinguished `query` (read) from `mutation` (write) on the same URL, and no read-shaped POST was
   mis-flagged. The `families` view aggregates to one `write_kind` per family, though, so
   `POST /api/graphql` displays as `read` while one of its two requests is a write — the per-request row
   is the truth and the family listing can mislead at a glance.

6. **Docs were accurate and the worked examples matched reality**, including the exact `#load-chart` /
   `#save` reports quoted in `docs/using-disco.md`. Re-deriving them from scratch took one act each. The
   one gap: nothing told me `ctl` existed or that every trap in this app is *off* by default — I found it
   in the page's own status bar. For an app with a scenario switch, "read the config endpoint first"
   deserves to be in the recon list in GUIDANCE §7.2 next to "ambient traffic profile".
