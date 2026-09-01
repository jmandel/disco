# NEXT (working name) — drive a web app you didn't build, without ever waiting blindly

> DRAFT. This README is the whole documentation. If something needs a second document, it is probably a
> feature we should not build.

A small library over Playwright plus a network recorder plus a folder convention. You point it at a web
app, act on it one experiment at a time, and every experiment comes back **fast** with a report of what
happened — on the screen and on the wire — or with a diagnosis of why it could not. What you learn
accumulates in a folder that a human can read and another agent can pick up.

It exists because agents driving unknown UIs lose most of their time *waiting wrong*: 30-second selector
timeouts that expire on the wrong page, "settled" signals that fire before the screen is ready, polls that
never end. The whole design is organized around one promise:

## The promise: no wait is blind, and no wait is long

Every call returns in one of three ways — **it worked**, **here is why it could not**, or **here is what I
was waiting for and what I saw when I gave up**. Never a bare timeout, never a silent hang.

| Situation | What happens | Bound |
|---|---|---|
| The target is not on the page | returns immediately with a **diagnosis**: near-matches, the open dialogs, what is pending on the wire, a screenshot | ~0.5 s |
| The target is there but cannot take the click | `not-interactable` (disabled / pointer-events / hidden — with the facts) or `occluded` (naming the element actually on top) | ~0.5 s |
| The action did nothing observable | `no-effect` | 0.5 s |
| The action did things | report returns when *this action's* requests are done and the page has been quiet for 300 ms | 3 s cap, 20 s if this action's own requests are still in flight |
| You named the state you need (`until`) | returns when that state holds (plus a short quiet tail), or with a diagnosis when the budget ends | 5 s default, you set it |
| You asked a question of the page (`evaluate`) | returns the value, or the in-page error with a hint | 10 s |

Rules that follow from the promise, for the agent as much as for the tool:

- **Act bare on a screen you have never seen.** Read the report; *then* write the predicate from the ids
  and text it showed you. Guessing an `until` for an unknown screen produces "failures" that are yours.
- **The verdict is evidence, never the gate.** `settled` means the page went quiet, not that the state you
  need exists. Automation always passes `until`; discovery uses the report to learn what `until` should be.
- **Budgets are small and named.** A 5-second postcondition with a diagnosis beats a 60-second timeout that
  tells you nothing. If you find yourself raising a budget past ~20 s, you are waiting for the wrong thing.
- **No sleeps, no hand-rolled wait loops** — in your scripts or in your shell. Long things run in the
  background; the harness tells you when they finish.
- **Read the diagnosis before any retry.** Retrying an `occluded` click clears an overlay; retrying a
  `not-interactable` one never will. The report tells you which.

Responsiveness is a tested contract, not a hope: the test suite pins the numbers in the table (a no-op
reports at ≈0.5 s with < 0.4 s of tool overhead; a diagnosis in < 1 s; `until` returns at the match plus
its tail, never at the hung-request cap; large results never stall the transport).

## Quickstart

```bash
bun install
bun gauntlet &                                   # the hostile demo app on :4800 (every trap, all knobs off by default)
bun cli/next.ts open gauntlet http://localhost:4800/
bun cli/next.ts act click 'role=button[name="Load Chart"]' --until-fn "() => document.querySelector('#chart-status')?.textContent === 'idle'"
#   act:1  click …  →  settled  (0.4 s; 3 requests)   ✓ until matched at 0.43 s
#     ⇄ GET /api/slow → 200 29B     ⇄ GET /api/chart/a → 200 35B     ⇄ GET /api/chart/b → 200 35B
#     + text "status: idle Chart loaded (3 responses)"
bun cli/next.ts sql gauntlet "SELECT method, path, status FROM requests WHERE action_id='act:1'"
bun cli/next.ts note "Load Chart: 3 GETs, screen ready ~0.4 s after click" --action act:1
```

The same thing as a library — this is what packs are written in:

```ts
import { open } from "next";
const s = await open("gauntlet", "http://localhost:4800/");
const r = await s.click('role=button[name="Load Rows"]', { until: { request: "/api/rows", landed: true } });
const rows = s.store.json(r.wire[0].body);              // 10,000 rows off the wire; the DOM shows 23
await s.note(`rows are wire-available on /api/rows`, { action: r.action });
```

## The surface, on one screen

```
open(app, url?, { headless? })                  → Session   (launches its own Chromium; no daemon)
s.act({ kind, target?, …opts })                 → Report    ← the one primitive; the verbs are sugar:
  s.click/rightclick/dblclick/hover(target, o)  s.type(target, text, o) appends   s.fill(target, text, o) replaces
  s.press(key, o)  s.select(target, value, o)  s.scroll({ target?, deltaY }, o)  s.navigate(url, o)  s.drag(target, to, o)
  o = { until?, budgetMs?, frame?, evaluateAfter?(+arg) }
s.until(pred, { budgetMs? })                    → { matched, elapsedMs, which?, diagnosis? }   (standalone wait)
s.evaluate(fn, { args: [...] })                 → value     (fn runs IN PAGE; it captures nothing — pass data as args)
s.screenshot()                                  → handle
s.note(text, { action? })                       → appends to apps/<app>/NOTES.md
s.store.requests({ urlLike, actionId, … })      s.store.json(handle)   s.store.sql("…")
s.close()
```

Predicates (for `until` and `s.until`): `{ selector, visible? }` · `{ fn, arg? }` · `{ request: urlPart, landed? }`
(a request this action started; `landed` = response + body captured) · `{ any: [...] }` (which arm held is
reported) · `{ all: [...] }`. Selectors are Playwright's (`role=`, `text=`, css, `>>`), everywhere.

**The report**, in the order you read it: `verdict` · `until` (matched / when / which / diagnosis) ·
`wire` (this action's requests: `METHOD path → status size`, body handle) · `ui` (aria delta: what appeared,
what vanished) · `dialogs` · `console` errors · `evaluateAfter` · `timing` (page time vs tool overhead) ·
`shot` · `diagnosis` (reason, near-matches, open dialogs, pending requests, the facts about the target).
Everything is a few hundred tokens; bodies and shots are handles you open only when you need them.

**The store** is one SQLite per app (`apps/<app>/store/`, gitignored): every request and response with
headers (cookies included) and bodies, WebSocket/SSE frames, console, dialogs, one row per action with its
report — attributed to actions by time window. Plain SQL is the query language; three helpers cover 90 %.

## The app folder — what a pack contains

`apps/<app>/` is documentation plus code. The two files tools run are `lib.ts` and `check.ts`; the rest is
prose with a recommended shape. Any subset is a legitimate state; the habit is **accumulate, then distill**
— `note` appends to NOTES.md as you work, and whenever a note has become understanding it moves up.

```
apps/<app>/
  NOTES.md      raw, chronological, act ids inline — written for you by `note`
  README.md     the distilled doc (sections below)
  wire.md       where the facts live: endpoint family → what it carries, read/write, standing channels, bodies worth citing
  friction.md   where the tool or this README got in your way — feedback to us, briefly and bluntly
  lib.ts        the workflows as functions       check.ts   the live check (`bun scripts/run-check.ts <app>`)
  store/        the recording (gitignored)        screenshots/  cited shots, if they help
```

### What the app README should say

Write it for a smart colleague who has never opened the app and must drive it tomorrow. The sections that
have earned their place, in the order a reader needs them:

1. **What this app is** — one paragraph: architecture (SPA? frames? which APIs), auth (cookie/token, where
   the session lives, how it expires), where facts live (UI vs wire), the one thing to know first (a config
   or scenario endpoint, a bot wall, a required role).
2. **Glossary** — the app's own concepts and what they mean *here*: for an EHR, patient / encounter /
   visit / chart / order / problem list; for a shop, cart / line / checkout step. Each entry: the term, what
   it is, where it shows on screen, which endpoint carries it, the identifier that names it (`uuid`, `pid`,
   a slug). This is the section strangers most wish existed.
3. **Anchors** — the named states you can cheaply assert (URL pattern + a landmark), because every workflow
   starts from one and ends at one: login page, shell, search results, chart open, section X open.
4. **Workflows / tasks** — one entry per thing a user does. The template that has worked:

   ```
   ### Find a patient by name
   Start: shell.  End: search results (anchor) with the patient's row visible.
   How: fill the search box (it is debounced; the request is the postcondition, not the rows) → results land.
     await s.fill('css=input[placeholder^="Search"]', name, { until: { request: "/patient?q=", landed: true } })
   Read the result off the wire: results[].{uuid, display, identifier}  (wire.md → /patient?q=).
   Selectors: the search box is the SECOND input[type=search] on the shell (the first is the queue filter) —
     scope to the search form. Result rows are virtualized; the wire has all of them.
   Postcondition: the response landed (not the rendered rows, which lag and page on scroll).
   Gotchas: 1-char queries return nothing; Enter opens the full results page (limit=50) instead of picking.
   Varies: totalCount vs rows on wire (300–350 of 373); observed n=4.  Evidence: act:14, act:22.
   ```

   Every workflow entry carries: start/end anchors, the snippet that does it, the selectors and *why
   those*, the postcondition, the gotchas, what varies (with counts), and act ids. The snippet is the same
   code that lives in `lib.ts` — the README explains, `lib.ts` runs.
5. **Interstitials and recovery** — every dialog, toast, banner, timeout that can interpose, whether it is
   conditional, and the move that clears it (present *or* absent). How to get back to the shell from anywhere.
6. **Input recipes** — keyboard-only widgets, comboboxes, date pickers: the exact key sequence, verbatim.
7. **Gotchas** — the failure-mode checklist with a verdict per item (present / absent / unobserved):
   conditional interstitials · optimistic UI · debounced inputs · virtualized lists · iframes / shadow DOM /
   canvas · keyboard-only widgets · session expiry · reads over POST · disabled controls · bot walls ·
   layout shift under a click · hydration races on cold load.
8. **Open questions** — what you did not get to, with the experiment that would answer each.

Observed vs inferred is visibly different throughout; every claim cites an act id or a store query.

## Method, in five lines

1. Open the app; **look at what you attached to** (targets, a screenshot) before investing anything.
2. Recon the wire at rest and the config surface before driving flows.
3. Act bare → read the report → name the anchor and the postcondition → act with `until` from then on.
4. Facts from the wire, UI for acting. Cite act ids. `note` as you go; distill when a note becomes understanding.
5. When a workflow is a routine, it becomes a `lib.ts` function; when it matters, it gets a `check.ts` step.

## What this deliberately does not do

No daemon (each session launches and owns its Chromium). No always-on screencast (screenshots on demand;
a spinner-page cast cost ~2 cores). No ambient-traffic classifier (attribution is by time window; the
postcondition decides, so a misattributed poll is cosmetic). No attach-to-a-human's-browser mode until a
real case needs it. No ledgers, palettes, or promotion paths — a folder of files and one habit.

## Running the tests

`bun test` — the gauntlet scenarios (every trap in the demo app, each pinning one claim above), the
responsiveness contract, the recorder, the transport. `bun scripts/run-check.ts <app>` — a pack's live check.
