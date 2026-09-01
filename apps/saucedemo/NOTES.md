# saucedemo — notes

Appended by `disco note` / `s.note()`. Distill into README.md when it settles.

- [run 1 · 105665ms] act:5 login is 100% client-side: 0 XHR/fetch, sets cookie session-username=<user>; act:8 cart is localStorage['cart-contents']=[4] (numeric item ids); act:21 finish clears cart-contents; act:23 Generate PDF order lazily loads /assets/OrderReceipt-*.js + react-pdf.browser-*.js (1.4MB) and downloads a PDF - no DOM change

## Raw observations (run 1 exploration, run 2 = the cold `run-check`)

- `act:1` first load: `GET /` is a 1.3 KB Vite shell (`cb1658fe8199`) + `index-XyuNVFOR.js` (527 KB). The
  accessibility tree is the only honest picture of any screen. Every control carries `data-test=…`;
  use that, not text.
- `act:5` login: **zero first-party requests**. `document.cookie` becomes `session-username=standard_user`.
  There is no API, no token, no `/api/*` of the app's own anywhere in the log.
- `act:8` add to cart → `localStorage['cart-contents'] = "[4]"`. Product ids are 0–5 and are *not* the
  display order (backpack = 4, bike light = 0).
- `act:10/12/19/21` cart → step one → step two → complete are real navigations to
  `/cart.html`, `/checkout-step-one.html`, `/checkout-step-two.html`, `/checkout-complete.html`.
- `act:14` clicking Continue with an empty form renders `[data-test='error']`
  "Error: First Name is required" and a `[data-test='error-button']` × to dismiss it. Same element is
  used by the login page and the deep-link guard.
- `act:21` Finish clears `cart-contents` entirely (key removed, not `[]`).
- `act:23` "Generate PDF order" changes nothing on screen; the wire shows
  `/assets/OrderReceipt-BqfNTy3l.js` (`1c04df158442`) then `/assets/react-pdf.browser-oX9uTdte.js`
  (1.4 MB, `48d94e0b561f`). The PDF itself is a browser download.
- `act:25` Logout via the burger menu clears the cookie but **not** `cart-contents`.
- `act:29/33` login refusals: "Epic sadface: Sorry, this user has been locked out." /
  "Epic sadface: Username and password do not match any user in this service". Both POST a Backtrace
  crash report (`r1-24`, `r1-25`) whose `req_body` carries `annotations.shoppingCart`,
  `attributes.username` and a full breadcrumb trail of every click since page load.
- `act:129` `[data-test='open-menu']` is diagnosed `occluded — covered by button#react-burger-menu-btn`:
  it is the `<img>` *inside* the burger button. Click `#react-burger-menu-btn`.
- `act:148` `{ selector: "[data-test='reset-sidebar-link']", visible: true }` came back `alreadyTrue`:
  the react-burger sidebar sits at x≈-276 with `aria-hidden=true`, which Playwright still calls visible.
  The honest anchor is `.bm-menu-wrap[aria-hidden='false']`.
- `act:78` performance_glitch_user login: the act is reported **FAILED / timeout** at 3 s
  (`locator.click: Timeout 3000ms exceeded`) although the click worked and the app is on
  `/inventory.html`. The submit handler blocks the main thread ~5.1 s. Fix: `s.timeouts.action = 12000`
  around that one click (`act:417` = 5096 ms, ok).
- problem_user / error_user, add-to-cart: ids 0, 2, 4 work; ids 1, 3, 5 are silently dropped
  (`act:429`, `act:431`, `act:447`: the `remove-*` button never appears, the badge does not move).
  error_user logs `Failed to add item to the cart.` as a console exception; problem_user says nothing.
- problem_user / error_user, sort: the `<select>` is controlled and reverts — its own `.value` snaps back
  to `az`, `[data-test='active-option']` never changes, nothing reorders. A Backtrace crash report
  "Sorting is broken!" is the only trace.
- problem_user, checkout step one: typing into Last Name writes into **First Name** and leaves Last Name
  empty → "Error: Last Name is required" forever. problem_user cannot check out.
- error_user, checkout step one: Last Name never renders its value but the state behind it *is* set, so
  Continue reaches step two. `act:459` Finish then throws `ai.cesetRart is not a function`
  (a scrambled `resetCart`), stays on step two, and shows **no** error banner.
- visual_user: the backpack image is `sl-404-Cq1a9k9X.jpg`; all six prices are randomised on every
  render ($43.65/$71.14/$7.3/… then $80.37/$13.67/$86.12/… on the next login).
- Deep links are guarded client-side: `GET /cart.html` without the cookie renders the shell, then the
  router bounces to `/` with "Epic sadface: You can only access '/cart.html' when you are logged in."
