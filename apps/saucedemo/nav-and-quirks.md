# Navigation & quirks — Swag Labs @ https://www.saucedemo.com (run 1, 2026-08-30/31)

Discovery per GUIDANCE §7 in one headless launched session (`disco session new saucedemo --launch --headless
--url https://www.saucedemo.com --scope saucedemo.com`). Evidence lives in `apps/saucedemo/store/store.sqlite`
(+ `blobs/`), run 1: 133 actions, 212 requests, 156 shots, 5 notes. Citations are act ids (`act:N` = rows in
`actions`, full report JSON in `actions.report`). Companion docs: `ledger.md` (what varies, n-counts, open
experiments), `lib.ts` (the function library), `check.ts` (live drift check), `friction.md` (tool feedback).

## 1. Layout and fingerprint

- **One page, one frame, no API.** A React SPA (Vite bundle `/assets/index-*.js`, 515KB) served by GitHub
  Pages. Every in-app move is a `pushState` (`nav.kind = same_document`, act:3); the verdict for an in-app
  transition is never `navigated`. There is **no data endpoint**: the whole catalogue (6 items) is compiled
  into the bundle and rendered into the DOM. The only network is static assets, Google Fonts, and a
  third-party error reporter (§7). This pack is therefore DOM-first: `lib/nav` anchors + `until`
  postconditions, no `lib/wire`.
- **Deep links are server 404s that still render the app.** `GET /inventory.html → 404` (body `evicted`)
  is GitHub Pages' `404.html` fallback carrying the bundle; the app then routes on `location.pathname`
  (act:14, act:61). Expect an `error: 404` sentinel and a console error on every direct navigation to a
  sub-path — that is the app working, not failing. Only `/` is a 200 document.
- **Login state is one cookie** (`session-username=<user>`, no server session). The cart is
  `localStorage["cart-contents"]` (a JSON array of item ids), **global — not per user** (§8).
- **No frames, no shadow DOM, no canvas, no WebSockets, no dialogs** were observed (targets census act:eval
  at start: one page target, one frame).

## 2. States (cheap predicates) — `lib.ts::state(s)` reads all of these in one eval

| state | URL | landmark | notes |
|---|---|---|---|
| `login` | `/` | `#login-button` (`[data-test="login-button"]`, an `<input type=submit>`) | also `#user-name`, `#password`; the page lists the accepted usernames in `.login_credentials` |
| `login.error` | `/` | `[data-test="error"]` (an `<h3>`) + `.error-button` | text is the app's own message (§6) |
| `inventory` | `/inventory.html` | `.inventory_list` (`[data-test="inventory-list"]`), `[data-test="title"]` = "Products" | 6 × `.inventory_item`; `.product_sort_container` select |
| `cart` | `/cart.html` | `#checkout` + `.cart_list` | `.cart_item` rows; `#continue-shopping` |
| `checkout.info` | `/checkout-step-one.html` | `#first-name`, `#last-name`, `#postal-code`, `#continue`, `#cancel` | validation banner appears as `[data-test="error"]` |
| `checkout.overview` | `/checkout-step-two.html` | `#finish`, `[data-test="subtotal-label"]`/`tax-label`/`total-label` | payment "SauceCard #31337", shipping "Free Pony Express Delivery!" |
| `complete` | `/checkout-complete.html` | `.complete-header` ("Thank you for your order!"), `#back-to-products` | also a "Generate PDF order" button (unexplored, ledger #18) |
| `menu` (overlay on any logged-in page) | unchanged | `.bm-menu-wrap[aria-hidden="false"]`, links `#inventory_sidebar_link`, `#about_sidebar_link` (external), `#logout_sidebar_link`, `#reset_sidebar_link`, close `#react-burger-cross-btn` | links exist in the DOM always, become *visible* after a ~0.5s slide-in (§3) |

Header on every logged-in page: `#react-burger-menu-btn`, `[data-test="shopping-cart-link"]`
(`a.shopping_cart_link`), `.shopping_cart_badge` (absent when the cart is empty).

## 3. Transitions (settlement profile + wire signature)

Settlement census (run 1): click `settled:visual` n=45 avg 124ms; `settled:dom` n=6 avg 84ms;
`settled:network` n=11 avg 685ms (max 3505 — the locked-out case); `no-effect` n=9 (glitch login ×6,
problem-user dead buttons ×3); `still-active` n=3 (locked-out with `until`); fill `settled:dom` n=44 avg 270ms.

| transition | acts | verdict, settle | postcondition (`until`) | wire | notes |
|---|---|---|---|---|---|
| Open `/` | 13, 15, 19, 23, 27, 31, 62, 66 | `navigated` 60–119ms | `#login-button` visible | 8 req: `/` 200, css, js (304 after first), 3 fonts, manifest | login form renders even when a cookie is set (act:13) |
| Login (standard_user) | 3, 52, 77, 100, 112 | `settled:network` 39–138ms (images not cached) **or** `settled:visual` 34–50ms (cached) | `.inventory_list` matched 11–106ms (n=5) | 6 product JPEGs + 2 data-URI PNG icons, `task` | pushState to `/inventory.html`; the label flips network↔visual with cache state (ledger #11) |
| Login (problem_user) | 34, 106 | `settled:network` 57–98ms | `.inventory_list` 26–73ms | `/assets/sl-404-*.jpg` ×1 + 4 data-URI SVGs | all six product images are the same 404 placeholder |
| Login (locked_out_user) | 18, 60 (no until); 65, 91, 127 (until banner) | `settled:network` **3486–3505ms** without `until`; `still-active` ~1010ms with it | `[data-test="error"]` matched 8–14ms | `POST submit.backtrace.io/UNIVERSE/TOKEN/json` (CORS-blocked, fails after ~5.5s, attributed `task`) | banner "Epic sadface: Sorry, this user has been locked out."; cookie IS set (§6) |
| Login (performance_glitch_user) | 22, 26, 69, 94, 130 (+ act:30 without until) | **`no-effect`** at the 500ms tier | `.inventory_list` matched **5012–5115ms** (n=6) | the same 6 JPEGs, `task` (or `trailing` without `until`, act:30) | the main thread is blocked ~5s; without `until` the report itself takes 5s to come back. Only login is slow (§5.3) |
| Add to cart (`[data-test="add-to-cart-<slug>"]`) | 4, 35, 36, 39, 53, 70, 78, 95, 101, 113, 114, 131 | `settled:visual`/`dom` 3–137ms | `[data-test="remove-<slug>"]` visible, 6–9ms | none | badge increments; button becomes Remove. Idempotency: the add selector no longer exists once the item is in the cart → `not-found` diagnosis naming the Remove button (act:54) |
| Add to cart, problem_user, dead items | 37, 38, 40 | `no-effect` (0 req, 0 mut, 0 px) | never | none | Bolt T-Shirt, Fleece Jacket, allTheThings T-Shirt (n=1 each) |
| Remove (`[data-test="remove-<slug>"]`) | 55 | `settled:visual` 18ms | badge gone / add button back | none | |
| Cart link | 5, 41, 71, 115 | `settled:network` 28–32ms | `#checkout` visible, ~11ms | one data-URI PNG | pushState to `/cart.html` |
| Checkout (`#checkout`) | 6, 42, 72 | `settled:visual` 28–32ms | `#continue` visible, ~9ms | none | → `/checkout-step-one.html` |
| Fill info (`fill`) | 8–10, 43–45 | `settled:dom` 69–197ms | field value (verify — §5.2) | none | `fill` replaces; real key events |
| Continue, invalid | 7, 46 | `settled:visual` 19–42ms | `[data-test="error"]` | none | "Error: First Name is required" / "Error: Last Name is required" — stays on step one |
| Continue, valid | 11 | `settled:visual` 36ms | `#finish` visible | none | → `/checkout-step-two.html`; totals rendered (§4) |
| Finish (`#finish`) | 12 | `settled:network` 72ms | `.complete-header` visible | `/assets/checkmark-*.png` | → `/checkout-complete.html`; cart emptied |
| Back Home (`#back-to-products`) | check runs | `settled:*` | `.inventory_list` | none | |
| Open menu (`#react-burger-menu-btn`) | 47, 56, 73, 102, 107 | `settled:visual` **404–544ms** (slide-in animation, 4–8 px batches) | `#logout_sidebar_link` *visible* matched 3–15ms | none | act on the link as soon as `until` says visible — no need to wait for the animation |
| Reset App State (`#reset_sidebar_link`) | 48, 108 | `settled:visual` 28–31ms | `.shopping_cart_badge` absent | none | clears `cart-contents`; does **not** navigate, clear the form, or close the menu |
| Logout (`#logout_sidebar_link`) | 49, 57, 74, 103, 109 | `settled:visual` 28–42ms | `#login-button` visible, 6–12ms | none | clears the cookie, pushState to `/`; does **not** clear the cart (§8) |
| Direct `/inventory.html` | 14 (valid cookie), 61 (locked cookie) | `navigated` 119–216ms | — | `GET /inventory.html → 404 [evicted]` + bundle + images | with a valid cookie the inventory renders; with the locked cookie → `/` + "Epic sadface: You can only access '/inventory.html' when you are logged in." |

## 4. DOM-available facts (there is nothing on the wire)

- **Catalogue**: `.inventory_item` → `.inventory_item_name`, `.inventory_item_desc`, `.inventory_item_price`
  ("$29.99"), `img[src]`, one `button` whose `data-test` is `add-to-cart-<slug>` or `remove-<slug>`.
  Slugs: `sauce-labs-backpack` 29.99, `sauce-labs-bike-light` 9.99, `sauce-labs-bolt-t-shirt` 15.99,
  `sauce-labs-fleece-jacket` 49.99, `sauce-labs-onesie` 7.99, `test.allthethings()-t-shirt-(red)` 15.99.
  The last slug contains `.`/`(`/`)` — use the **attribute** selector `[data-test="…"]`, never `#id`.
- **Cart lines**: `.cart_item` → `.inventory_item_name`, `.cart_quantity`, `.inventory_item_price`.
- **Overview totals**: `[data-test="subtotal-label"]` "Item total: $39.98", `[data-test="tax-label"]`
  "Tax: $3.20", `[data-test="total-label"]` "Total: $43.18". Tax = 8% of the subtotal, rounded to cents
  (n=4: 29.99→2.40, 39.98→3.20 ×3).
- **Session**: `document.cookie` `session-username`; **cart**: `localStorage["cart-contents"]` e.g. `[2,1]`.
- **Error banner**: `[data-test="error"]` text — the app's message verbatim.

## 5. Failure modes actually seen (GUIDANCE §8 instances)

1. **Settled ≠ ready, in its purest form** — `performance_glitch_user`'s login click reports `no-effect`
   (0 req / 0 mut / 0 px at the 500ms tier) while the same report's UI delta lists the whole inventory: the
   page's main thread is blocked ~5s, so the DOM changes after the fast tier closes. `until: .inventory_list`
   (budget ≥ 10s) is the only correct gate; it matched at 5012–5115ms in 6/6 runs. Without `until` the
   *report itself* still takes ~5.1s to return (act:30: "page 5016ms (settled 0, reported 500)") because the
   post-snapshot waits on the frozen page — so the verdict is not even a fast lie.
2. **Inputs that drop keystrokes (problem_user)** — `fill("#last-name", "Lovelace")` settles `dom` like a
   healthy fill (act:44) but the field holds `""`, and `#first-name` (filled "Ada", act:43) holds `"e"`.
   `lib.ts::checkout` reads the three values back and throws naming the field *before* clicking Continue;
   otherwise the failure surfaces one step later as "Error: Last Name is required" (act:46).
3. **Dead buttons (problem_user)** — 3 of 6 add-to-cart buttons swallow the click: `no-effect` with zero
   mutations (acts 37/38/40). The postcondition (`remove-<slug>` visible) never arrives; `addToCart` throws
   with the verdict. Do not retry — it is deterministic per item.
4. **Third-party request holding settlement** — the locked-out refusal renders its banner at ~8ms, but a
   CORS-blocked `POST submit.backtrace.io/UNIVERSE/TOKEN/json` (the app's crash reporter, attributed `task`)
   keeps the window open until it fails ~3.5s later (acts 18/60: `settled:network` 3505/3486ms). With
   `until` on the banner the act returns at the 1s tail as `still-active` (acts 65/91/127). Never gate on
   settlement here.
5. **Verdict label drift on identical steps** — standard login is `settled:network` when product images are
   fetched and `settled:visual` once they are cached (acts 3/52 vs 77/100/112). Assert the postcondition,
   not the label.
6. **Client state that outlives "logout"** — see §8. A check that assumes an empty cart after login fails on
   a reused profile (that is exactly how the first live check run failed: Backpack "already in cart").
7. **Auth bounce** — with the locked user's cookie, `/inventory.html` bounces to `/` with the "You can only
   access … when you are logged in" banner (act:61). With no cookie the same happens (prior; the app's
   message names the path).
8. **Not seen**: dialogs, toasts, iframes, virtualized lists, first-run tips, session expiry (no server
   session to expire; 10 page loads across the 12-minute run, none differed).

## 6. Auth / session behaviour

- Any of the six advertised usernames + `secret_sauce`; the page prints them.
- The cookie `session-username=<user>` is written **before** the lock check: after a refused
  `locked_out_user` login the cookie reads `locked_out_user` (n=5) yet routes are still refused (act:61). Do
  not treat the cookie as "logged in" — `lib.ts::state().user` is informational; the anchor is `.inventory_list`.
- Logout clears the cookie (n=5). Navigating to `/` shows the login form regardless of the cookie (act:13,
  n=8), so `login()` reaches its anchor by navigating, never by logging out first.
- Refusal texts observed: "Epic sadface: Sorry, this user has been locked out." (n=5); "Epic sadface: You can
  only access '/inventory.html' when you are logged in." (n=1). Form validation: "Error: First Name is
  required" (n=1), "Error: Last Name is required" (n=1). Wrong-password / unknown-user texts: unobserved
  (ledger #15).

## 7. Standing channels / ambient traffic (complete inventory)

| channel | what | cadence | settlement impact | store |
|---|---|---|---|---|
| `POST events.backtrace.io/api/{unique,summed}-events/submit` (+ CORS preflight `OPTIONS`) | Backtrace telemetry; answers **401** | on page load, then ~+10s and ~+30s (gaps 10.2s/20.2s, n=3 each) — then quiet | never landed inside a window (`attribution=none`); fires `error: 401` sentinels (6 in act:1's report) | `requests`, `sentinels`, never classified `ambient` (n too small) |
| `POST submit.backtrace.io/UNIVERSE/TOKEN/json` | Backtrace crash report, fired by the app on the locked-out refusal | per refusal (n=5) | **holds the window ~3.5–5.5s** (CORS failure, `task`) | `requests` (status NULL, `error`), `console` (CORS error) |
| Google Fonts (`fonts.googleapis.com/css2`, `fonts.gstatic.com/*.woff2`) | fonts | per full page load | inside the navigation window only | `requests` |
| data-URI images (`GET image/png;base64,…`, `image/svg+xml,…`) | inline icons the report counts as requests | per render of the header/menu | attributed `task`; the reason a pure-client pushState is labelled `settled:network` | `requests` (path = the whole data URI) |

No WebSocket, SSE, long-poll, heartbeat, or token refresh exists. `disco idle` buys nothing here beyond the
session-start observation.

## 8. Client state and recovery

- **Cart persists across logout and across users** (`cart-contents` in localStorage): after the glitch user
  added the Onesie and logged out, the standard user's next login showed badge 1 (check run 1, act:95→112);
  act:103 shows `cookie=""` with `cart-contents="[2,1]"`; act:106 shows the problem user inheriting it.
  **Recovery**: menu → Reset App State (`lib.ts::resetAppState`) — clears the badge (act:48, 108); or start
  from a fresh profile (`scripts/run-check.ts` does).
- **Menu left open** blocks nothing observed but `resetAppState` closes it (`#react-burger-cross-btn`,
  wait for `.bm-menu-wrap[aria-hidden="true"]`) so the next click is not on the overlay.
- **Mid-flow recovery**: every pack function starts with `state(s)`; `login()` navigates to `/` from
  anywhere; `openCart()` clicks the header cart link from any logged-in page; `checkout()` accepts being
  on the cart or already on the info form.
- **Stale error banner**: the banner stays until the next submit; `login()` reads `evaluateAfter` from its
  own click, so an old banner cannot be mistaken for a new refusal.

## 9. Selector strategy (and why)

**Primary: `data-test` attributes** (`[data-test="add-to-cart-sauce-labs-backpack"]`,
`[data-test="error"]`, `[data-test="shopping-cart-link"]`) — present on every control, survive re-renders,
and are the hooks the vendor put there for tests. Quote them: slugs contain `.()`. **Ids** are equally
stable (`#login-button`, `#checkout`, `#continue`, `#finish`, `#first-name`, `#react-burger-menu-btn`,
`#logout_sidebar_link`) and read better in code; used where the id has no special characters.
**Class landmarks** for anchors (`.inventory_list`, `.cart_list`, `.complete-header`, `.shopping_cart_badge`).
**Playwright chaining** works (`.inventory_item:has-text("Sauce Labs Backpack") >> role=button[name="Add to
cart"]`, act:4) but the disco-generated selector for that same target was the `data-test` form, so the
library resolves names → slugs in one `listProducts` eval and clicks by `data-test`. Avoid `text=` for
buttons: "Add to cart" ×6 and "Remove" are ambiguous.

## 10. Driving it — the short version

```ts
import * as swag from "./lib.ts";
await swag.login(s, { user: "standard_user" });            // idempotent; navigates to / from anywhere
if ((await swag.state(s)).badge) await swag.resetAppState(s); // stale cart is optional-both-ways
await swag.addToCart(s, "Sauce Labs Backpack");             // no-op if already in the cart
await swag.openCart(s);
const { total } = await swag.checkout(s, { firstName: "Ada", lastName: "Lovelace", zip: "12345" }); // 32.39
await swag.logout(s);
```
Budgets: login 20s (glitch user needs ~5.1s), everything else ≤ 8s; no step needs a sleep.
