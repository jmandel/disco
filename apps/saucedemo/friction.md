# saucedemo — friction

Where disco or its README got in the way while characterising `https://www.saucedemo.com/`.
Format: what I tried · what happened · what I expected · what I did instead · what it cost.

---

### 1. A slow synchronous handler makes a *successful* action report FAILED, and the armed `until` is thrown away — ~10 min

**Tried** (after `fill`ing the login form as `performance_glitch_user`):

```ts
const r = await s.click("#login-button", { until: { selector: "[data-test='inventory-list']" }, timeout: 15000 });
```

**Happened:**

```
act:78 click #login-button  FAILED  5222ms (act 5194 · window 0 · report 12)  https://www.saucedemo.com/inventory.html
  diagnosis: timeout — locator.click: Timeout 3000ms exceeded. | … - element is visible, enabled and stable - scrolling into view if needed
    shot 63a457d6305f822c
  until: ✗  0ms — action not performed
  ui:  + - text: Swag Labs Products Name (A to Z)  (the inventory, fully rendered)
```

The click *worked*. The URL in the report's own header is `/inventory.html` and the `ui` diff is the
inventory page. The app blocks the main thread ~5.1 s inside its submit handler, so Playwright's
`locator.click` does not return within `timeouts.action` (3 s).

**Expected** two things, neither of which happened:
(a) `timeout: 15000` to cover this — the README's ActSpec table says `timeout` is the "budget for
`until`", and the Timeouts table lists `action` separately, but nothing anywhere warns that a per-act
`timeout` cannot rescue a slow *action*, which is the first thing you reach for;
(b) the `until` to be reported. The README is emphatic that the predicate "is armed the instant you
call `act`/`until`, before anything else happens" and that this is what makes `s.click(x, {until})`
robust — so a predicate that demonstrably became true during the action should have a verdict.
`until: ✗ 0ms — action not performed` discards it and, worse, `reached()` then throws on an app that
is in exactly the state you asked for.

**Did instead**: mutate the session budget around that one click and restore it:

```ts
const saved = s.timeouts.action;
s.timeouts.action = 12000;      // measured: submit blocks the main thread 5.1–5.3 s
try { … } finally { s.timeouts.action = saved; }
```
→ `act:417 ok 5096ms, until ✓`.

**Doc gap**: `s.timeouts` is listed as a Session *field* but nothing says it is writable or that
mutating it is the intended escape hatch. The Timeouts section's rule "raise one only on the step you
watched exceed it, inline" has no worked example for `action`, which is the only one you cannot pass
inline.

---

### 2. `check.ts`'s `target` is documented as `{ url }` / `{ attach }` and nothing else — ~3 min of hesitation

`export const target = { url: "https://www.saucedemo.com/" }` is the only shape the README shows. I
wanted `{ url, timeouts: { action: 12000 } }` for item 1 and had no way to know whether `target` is
spread into `open()`'s options or read key-by-key, and `scripts/` was off-limits. I hedged by doing
the mutation inside `lib.ts` instead. One sentence — "`target` is passed to `open()`" (or not) —
would remove the guess.

---

### 3. Does a standalone `s.until()` count as `alreadyTrue`? Undocumented; I had to read the example pack — ~4 min

`reached()` "throws when the `until` was `alreadyTrue`". `s.until(pred)` is "wait without acting
(`kind: "noop"`)". Taken together, `reached(await s.until(anchor))` — the obvious way to write "assert
I am on this screen", and what the README's own **Recovery** section tells you to do
(`s.until(anchor, { timeout: 1500 })`) — would *always* throw, because an anchor you are standing on
is true before you wait for it. It does not throw, but the only way I could establish that was
`apps/gauntlet/lib.ts`'s `atHome()`. Say it in the `reached` paragraph: *`alreadyTrue` is only flagged
for acts that perform something.*

---

### 4. The CLI's `--until-selector` defaults to **attached**; the API's `{ selector }` defaults to **visible** — ~2 min, and it nearly gave me a false pass

```sh
./disco click "[data-test='add-to-cart-sauce-labs-backpack']" --until-selector "[data-test='shopping-cart-badge']"
  until: ✓ attached [data-test='shopping-cart-badge'] 217ms
```

The `until` predicate table says `{ selector, visible? }` "holds when a matching element is
**visible** (`visible: false`: merely attached)" — i.e. visible is the default. The CLI reference
prints `--until-selector S [--visible]`, which implies the opposite default, and the report line
confirms it (`✓ attached`, not `✓ visible`). On this app that difference is load-bearing: the burger
sidebar links are attached *and* "visible" while the menu is shut (item 5), and a
`--until-selector` on a hidden element would have passed silently. Either make the defaults match or
state the difference in the CLI reference.

---

### 5. Off-canvas panels are "visible", so a sidebar anchor is silently `alreadyTrue` — ~4 min and one crashed probe

**Tried**: `s.click("#react-burger-menu-btn", { until: { selector: "[data-test='reset-sidebar-link']", visible: true } })`

**Happened**: `Error: act:148: until [data-test='reset-sidebar-link'] was already true before the
action`. react-burger-menu parks the panel at `x ≈ -276` with `aria-hidden="true"` and
`tabindex="-1"`; Playwright still calls it visible (non-empty box, no `display:none`).

**Expected**: `visible: true` to mean "on screen".

**Did instead**: anchor on the container's own state — `.bm-menu-wrap[aria-hidden='false']`.

The README's `offscreen` diagnosis row does say "slide-out panels parked at `left: 100vw` … still
count as *visible*", which is the same fact — but it is filed under *diagnoses for clicks that fail*,
not under *predicates that lie*. The `until` table and the "SPA predicates that are already true"
section are where someone writing a menu workflow will look, and neither mentions it. Cheap fix: add
"a closed slide-out drawer's items are `visible`; anchor on the drawer's `aria-hidden`" to the
gotchas.

---

### 6. `[data-test='open-menu']` → `occluded` by its own parent `<button>` — ~2 min

`Error: act:129: occluded — [data-test='open-menu'] is covered by button#react-burger-menu-btn`.
The diagnosis is exactly right and named the culprit, so this cost only the time to re-read it. It is
listed here because the README explicitly carves out one such case — "a styled checkbox/radio whose
real input hides under a visual in its own `<label>` is *not* occluded — disco clicks through those"
— which reads as a general "disco sees through decorative wrappers" promise. An `<img>` inside its own
`<button>` is the same shape of problem and is *not* clicked through. Say "only labels/inputs", or
extend the pass-through.

---

### 7. Reading the app's own source out of the log is blocked by the 512 KB body cap — no workaround found, ~3 min

The README's "The app's own code is on the wire" tip
(`SELECT body_hash FROM requests WHERE resource_type='script'` → `./disco body <hash>`) is exactly
what I wanted, to answer "are there accounts beyond the six advertised?". The app's only bundle is
527 KB, so `requests.body_state` is `truncated` and half the client is unreachable. Any modern Vite
SPA will be over the cap, which makes that tip mostly inapplicable to the apps it is aimed at. The cap
is documented one section earlier ("bodies (text under 512 KB…)"), but not where the tip is. It is
left as an open question in `README.md` §8.

---

### 8. The report's `console` rows have an undocumented shape — ~2 min

`error_user`'s broken Finish is *only* observable through `report.console`, so I needed to read it.
The report table says `console` = "errors, exceptions and warnings inside the window" and stops there.
The log section documents the `console` *table* but not the field on the report. I wrote
`(r.console ?? []).map(c => c.text ?? c.message ?? String(c))` defensively and confirmed by SQL
(`SELECT level, text FROM console` → `level: "exception", text: "ai.cesetRart is not a function"`).
One example line in the report table would do it.

---

### 9. `actions` table columns are not in the README — ~1 min

`./disco sql "SELECT id, kind, target, url FROM actions WHERE run=2"` →
`error: no such column: url  (./disco schema lists the tables and columns; …)`. The error message is
excellent and told me exactly what to run next. Noting it only because the log section spells out
every column of `requests` and merely names the other nine tables; `actions` (`id, n, t0, t1, kind,
target, ok, report`) is the one you reach for constantly when writing up act ids as evidence.

---

### 10. Waits I paid in full, and why

None of these are disco's fault — they are the app being deliberately broken — but they are the
wall-clock cost of characterising it, and each is a budget that expired rather than resolved:

| Wait | Budget | Why it expired |
|---|---|---|
| `sortBy` under problem_user / error_user | 3000 → cut to **1500** | the `<select>` reverts, so `[data-test='active-option']` never changes. There is nothing to wait *for*; a negative outcome always costs the whole budget |
| `addToCart(1)`, `addToCart(3)` under the broken users | **1500** each ×3 per run | the `remove-*` button never appears |
| `finishOrder` under error_user | **2500** | no banner, no navigation, no request — nothing to wait for except the absence of success |

The general shape: **disco has no way to wait for "the app decided to do nothing"**, so every
characterised failure costs a full budget. `any: [success, theApp'sOwnErrorUI]` is the README's
answer, and it works beautifully for the login refusals (~200 ms), but three of this app's faults have
*no* error UI at all. The only lever is picking a short budget from a measurement of the happy path
("<100 ms when it works" → 1500), which is what I did and what the comments in `lib.ts` record.

---

### 11. Every `fill` costs 700 ms of observation window — ~9 s per `check` run

A four-field form is 2.8 s of pure waiting: `act:436 fill 711ms · act:437 fill 712ms · act:438 fill
713ms`. The `window` option exists and would fix it (`{ window: 50 }`), but the Timeouts section's
rule is "**Don't set them.** Use the default everywhere", which reads as covering `window` too, and
the "Working an unfamiliar app" walkthrough never sets one. For *exploration* the 700 ms is exactly
right — it is how I learned what each field does. For a `check.ts` replaying a known form it is dead
time, and 12 fills × 700 ms ≈ 8.4 s of the run's 53 s. Worth one sentence: *once a step is known,
drop the window on the acts you are no longer reading.* (I left the defaults in, per the rule.)

---

### 12. Moments I did not know what to do next

- **After the first `./disco aria`** — the page has three controls and the wire has nothing but a
  401 from `events.backtrace.io`. The README's recon recipe ("is it an SPA with a JSON API,
  server-rendered pages, iframes, a WebSocket? Where is auth?") has no branch for *the answer is
  none of those*, and I spent a minute looking for the API before accepting there isn't one. The
  useful move — `document.cookie` / `localStorage` before and after every act — is not in the recon
  list, and for a client-only app it is the entire wire. Suggest adding it.
- **Choosing what "characterise" means here.** The app is six products; the *content* is six injected
  faults. Nothing in the docs suggests enumerating accounts as a first-class axis, but on this app
  the persona matrix is the app. (The `apps/README.md` "first hour" list is workflow-shaped and would
  have had me writing one happy path and stopping.)
