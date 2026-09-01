# saucedemo — Swag Labs

`https://www.saucedemo.com/` · driven with `apps/saucedemo/lib.ts` · proved by `check.ts`
(`node scripts/run-check.ts saucedemo`, 17/17 warm and cold).

## 1. What it is

**Swag Labs** is Sauce Labs' public practice storefront: a six-product swag shop with login, a
sortable catalogue, a cart, a three-screen checkout and an order confirmation. Its real purpose is to
be *deliberately broken in named ways* — the login page advertises six accounts, and each one is a
different fault injected into the same code so that UI-automation people have something to catch.
Characterising this app means characterising **the six personas**, not the six products.

Architecture: a **React SPA** (Vite bundle `index-XyuNVFOR.js`, 527 KB, app version `3.0.0`). Every
route serves the same 1.3 KB shell, so the HTML document tells you nothing — `./disco aria` and
`data-test` attributes are the picture of a screen. **There is no backend**: no XHR/fetch to
`www.saucedemo.com` exists anywhere in the log. Auth is a client-set cookie
`session-username=<user>`; the cart is `localStorage['cart-contents']` (a JSON array of product ids);
prices, tax and the order all come from constants in the bundle. The only network traffic the app
makes is **Backtrace telemetry with placeholder credentials** — every call fails, but the request
bodies are a full mirror of app state and a click-by-click breadcrumb trail (see `wire.md`).

Everything is per-browser and disposable: log out, `Reset App State`, or clear localStorage.

## 2. Glossary

| The app's word | On screen | Where it lives |
|---|---|---|
| **product / item** | a card in the inventory list | `[data-test='inventory-item']`; identified by a numeric `id` 0–5 that is *not* the display order (Backpack = 4, Bike Light = 0) |
| **slug** | — | `data-test` suffix = the name lowercased with spaces → dashes: `sauce-labs-backpack`, `test.allthethings()-t-shirt-(red)` |
| **cart** | the badge on the header cart icon | `localStorage['cart-contents']` = `[4,0,2]`. Quantity is always 1; the same product cannot be added twice |
| **session** | "you are logged in" | cookie `session-username=standard_user`. No server, no token, no expiry |
| **Reset App State** | burger-menu item | empties `cart-contents` in place |
| **Your Information** | checkout step one | First/Last name + Zip; not stored anywhere afterwards |
| **Overview** | checkout step two | `SauceCard #31337`, `Free Pony Express Delivery!`, item total, **tax = 8 %**, total |

### The catalogue (as `standard_user` sees it)

| id | name | price |
|---|---|---|
| 0 | Sauce Labs Bike Light | $9.99 |
| 1 | Sauce Labs Bolt T-Shirt | $15.99 |
| 2 | Sauce Labs Onesie | $7.99 |
| 3 | Test.allTheThings() T-Shirt (Red) | $15.99 |
| 4 | Sauce Labs Backpack | $29.99 |
| 5 | Sauce Labs Fleece Jacket | $49.99 |

### The six accounts (password `secret_sauce` for all)

| user | what it does | evidence |
|---|---|---|
| `standard_user` | everything works | `act:346` |
| `locked_out_user` | login refused: "Epic sadface: Sorry, this user has been locked out." | `act:403` |
| `problem_user` | every image is `sl-404`; the sort dropdown is inert; **odd-id products never reach the cart, silently**; the Last Name box writes into First Name → **checkout is impossible** | `act:423`, `act:425`, `act:429/431`, `act:439` |
| `performance_glitch_user` | works, but the login submit handler **blocks the main thread ~5.1 s** | `act:417` (5096 ms) |
| `error_user` | odd-id adds fail with a console exception; sort inert; Last Name never renders (but its state *is* set); **Finish throws and shows nothing** | `act:447`, `act:459` |
| `visual_user` | the Backpack image is `sl-404`; **all six prices are randomised on every render** | `act:471` |

## 3. Anchors

| Screen | URL | Anchor element |
|---|---|---|
| login | `/` | `#login-button` |
| inventory | `/inventory.html` | `[data-test='inventory-list']` |
| product detail | `/inventory-item.html?id=<n>` | `[data-test='back-to-products']` |
| cart | `/cart.html` | `[data-test='cart-list']` |
| checkout step one | `/checkout-step-one.html` | `[data-test='firstName']` |
| checkout step two | `/checkout-step-two.html` | `[data-test='total-label']` |
| complete | `/checkout-complete.html` | `[data-test='complete-header']` |
| burger menu open / shut | any | `.bm-menu-wrap[aria-hidden='false']` / `[aria-hidden='true']` |

`{ url: "/" }` is useless here (`saucedemo.com/` contains it — `act:25` came back `alreadyTrue`);
always anchor the login screen on `#login-button`.

## 4. Workflows

All of these are `lib.ts` functions; the snippets are what they do.

### Log in

```ts
await reachLogin(s);                       // clears the cookie + cart, navigates, dismisses a stale banner
const r = await login(s, "standard_user"); // r.which === "inventory" | "error"
```

```ts
s.fill("#user-name", user); s.fill("#password", password);
s.click("#login-button", { until: { any: [
  { selector: "[data-test='inventory-list']", label: "inventory" },
  { selector: "[data-test='error']",          label: "error" } ] } });
```

The `any` is what makes a refusal cost ~200 ms instead of a 5 s budget — and three of the six
accounts refuse or misbehave. **`performance_glitch_user` needs `s.timeouts.action` raised around the
click** (see Gotchas). Postcondition worth checking: `document.cookie` now has `session-username`.

### Browse and sort

```ts
const { applied, names } = await sortBy(s, "hilo");   // az | za | lohi | hilo
```
Postcondition is the app's own label `[data-test='active-option']:text-is("Price (high to low)")`,
not the list order (`act:348-354`). `applied === false` is a real answer: for problem_user and
error_user the `<select>` is controlled and reverts — its `.value` snaps back to `az` — while
`s.select` still reports `ok: true`. **`ok` is not the signal; `until.ok` is.**

### Add to cart

```ts
const { added, cart } = await addToCart(s, 4);        // until: [data-test='remove-sauce-labs-backpack']
```
From the detail page the button has **no slug**: `[data-test='add-to-cart']` / `[data-test='remove']`
(`act:358`). `added === false` is the documented outcome for ids 1, 3, 5 under problem_user and
error_user; the budget is 1500 ms because a working add takes < 100 ms.

### Check out

```ts
await openCart(s);                    // header cart icon -> /cart.html
await startCheckout(s);               // -> /checkout-step-one.html
const step = await submitCheckoutInfo(s, { firstName: "Ada", lastName: "Lovelace", postalCode: "12345" });
// step.which === "stepTwo" | "error"; step.values = what the form ACTUALLY holds
const m = await overview(s);          // { subtotalN: 29.99, taxN: 2.40, totalN: 32.39 }
const done = await finishOrder(s);    // done.completed, done.console
```

Tax is `round(subtotal * 0.08)`; the total is the sum. Finish clears `cart-contents` entirely
(`act:380`). `submitCheckoutInfo` returns `values` because on problem_user the DOM lies: filling
Last Name writes "Lovelace" into **First Name** and leaves Last Name empty, so the app then refuses
with "Error: Last Name is required" (`act:439`) — problem_user can never complete an order.

### Generate the PDF receipt

```ts
const { fetched, chunks } = await generatePdf(s);   // until: { request: "react-pdf.browser", landed: true }
```
Nothing happens on screen. The evidence is two lazily-loaded chunks — `OrderReceipt-*.js` then
`react-pdf.browser-*.js` (1.4 MB) — and the PDF goes straight to the browser as a download
(`act:382`).

### Menu: Reset App State / Logout

```ts
await resetAppState(s);   // empties the cart, does NOT close the menu (lib closes it for you)
await signOut(s);         // clears the cookie; the cart SURVIVES (it is localStorage)
```

## 5. Interstitials and recovery

- **The error banner** `[data-test='error']` is one shared element used by the login screen, checkout
  step one and the deep-link guard, with a `[data-test='error-button']` × to dismiss. It **persists**
  across attempts, which makes `until: { selector: "[data-test='error']" }` `alreadyTrue` on the next
  try (`act:33`). `lib.dismissError()` clears it; `reachLogin` calls it.
- **Deep-link guard.** Any `*.html` route without the cookie renders the shell, then the router
  bounces to `/` and shows
  `Epic sadface: You can only access '/cart.html' when you are logged in.` — so the login anchor is
  a legitimate arm of every workflow's `until`.
- **Recovery from anywhere**: `reachLogin(s)` (clear cookie + cart, navigate `/`, assert
  `#login-button`, dismiss the banner). There are no modals, no popups, no iframes, no dialogs and
  no WebSockets in this app.

## 6. Input recipes

- **Selectors**: prefer `data-test` for everything; it is stable and covers every control. The two
  exceptions are the burger buttons, which only have ids: `#react-burger-menu-btn`,
  `#react-burger-cross-btn`.
- **Open the burger menu** with `#react-burger-menu-btn`. Do **not** click
  `[data-test='open-menu']` — that is the `<img>` inside the button and disco correctly diagnoses
  `occluded — covered by button#react-burger-menu-btn` (`act:129`).
- **Do not use `visible: true` on the sidebar links.** react-burger-menu parks the panel at
  `x ≈ -276` with `aria-hidden="true"`, which Playwright still counts as visible, so
  `{ selector: "[data-test='logout-sidebar-link']", visible: true }` is *always* true (`act:148`
  came back `alreadyTrue`). Wait on `.bm-menu-wrap[aria-hidden='false']` instead; it also covers the
  0.5 s slide animation.
- **`fill` is fine everywhere** — no debounced or keyboard-only widgets exist. `type` behaves
  identically on the broken Last Name fields, so it is not a workaround.
- The sort control is a real `<select>`: `s.select("[data-test='product-sort-container']", "hilo")`.

## 7. Gotchas

1. **`performance_glitch_user` breaks `act`, not the app.** The submit handler blocks the main
   thread for ~5.1 s, longer than `timeouts.action` (3 s), so Playwright's `locator.click` times out
   and disco reports the act **FAILED / `timeout`** with `until: ✗ — action not performed`, even
   though the click landed and the app is on `/inventory.html` (`act:78`). `timeout:` does not help:
   it only governs `until`. Raise the *session's* budget around that one click —
   `s.timeouts.action = 12000` — and the same act is `ok` with its `until` held (`act:417`, 5096 ms).
2. **Silent failures are the app's whole point.** For three of six personas the screen shows a
   perfectly normal result while nothing happened. Never assert "the click was `ok`"; assert the
   state (`cartIds`, `until.ok`, `[data-test='active-option']`) or the console.
3. **`error_user`'s Finish is invisible.** No banner, no URL change, no wire request — only
   `report.console` (`ai.cesetRart is not a function`, a scrambled `resetCart`) and a Backtrace crash
   report. This is the one place where reading `report.console` is the *only* way to know
   (`act:459`).
4. **The DOM `.value` can lie.** problem_user's Last Name writes into First Name; error_user's Last
   Name never renders but its React state *is* set (so Continue succeeds with a visibly empty field).
   Read `submitCheckoutInfo().values` and compare with what you typed.
5. **`visual_user` prices are randomised per render** — two consecutive logins gave
   `$43.65 …` then `$80.37 …`. Never hard-code a total for that account; recompute from the overview.
6. **The cart outlives logout** (localStorage, not the session), so a "fresh login" is not a fresh
   cart. `reachLogin` removes `cart-contents` explicitly; the app's own way is Reset App State.
7. **`{ url: "/" }` is always true** on this host — anchor the login screen on `#login-button`.
8. **Adding the same product twice is impossible** — the button flips to Remove. Quantity is always 1.
9. **The bundle is over disco's 512 KB body cap** (`body_state: truncated` on
   `index-XyuNVFOR.js`), so reading the app's own source out of the log gets you only the first half.

## 8. Open questions

- Are there accounts beyond the six advertised? A `POST` probe is impossible (no endpoint); the only
  experiment is reading the credential list out of `index-XyuNVFOR.js` — blocked by the 512 KB body
  cap, so it would need `s.probe("fetch('/assets/index-XyuNVFOR.js').then(r=>r.text()).then(t=>…)")`
  and a slice.
- Does the generated PDF contain the order? The download never reaches the DOM; it would need
  `s.page.on("download")` (raw Playwright) or a `context.route` interception.
- The footer's Twitter/Facebook/LinkedIn links and the menu's **About** (`https://saucelabs.com/`)
  were never followed — they leave the app.
- `visual_user`'s name suggests more than prices + one 404 image (layout shifts a screenshot diff
  would catch). `s.screenshot()` hashes are content-addressed, so comparing a standard_user and a
  visual_user inventory shot would answer it.
