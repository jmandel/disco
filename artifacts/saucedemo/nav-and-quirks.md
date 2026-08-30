# Sauce Labs "Swag Labs" demo — navigation & quirks

Instance #3 (`https://www.saucedemo.com`). Chosen to be **unlike OpenEMR**: a client-rendered React SPA
with **no data API**. `lib.ts` is the executable form; `check.ts` (via `bun scripts/run-check.ts saucedemo`)
is the live regression. Users: `standard_user` / `problem_user` / `performance_glitch_user` /
`locked_out_user`, password `secret_sauce`.

## Why this instance matters (the generality lesson)

OpenEMR is server-rendered PHP, nested iframes, rich wire (finder JSON, summary fragments). Swag Labs is
the opposite: **the catalog and cart live entirely in the JS bundle; the only XHR is analytics
(`/api/*-events/submit` → 401)**. So there is nothing to read off the wire — the pack is **DOM-first**.
It exercises the same reusable pattern (`lib/nav`: anchors + defensive + `assertVisible`) *without* the
wire-first crutch, which is the proof that the Layer-1 layer isn't EHR-shaped. `extractFromWire` simply
isn't used here, and that's fine — the palette is take-what-you-need.

## Anchors

| anchor | recognize by | reach with |
|---|---|---|
| `login` | `/` + `#user-name` | (start) |
| `inventory` | `/inventory.html`, `.inventory_list` | `login(s)` |
| `cart` | `/cart.html`, `.cart_list` | `openCart(s)` |
| `complete` | `.complete-header` ("Thank you for your order!") | `checkout(s, info)` |

## Transitions

- **login → inventory**: type `#user-name`/`#password`, click `#login-button`. `locked_out_user` yields an in-page error (thrown verbatim). Controlled inputs — clear before typing (type appends).
- **inventory → cart**: add via `[data-test="add-to-cart-<slug>"]` (slug = lowercased, non-alnum→`-`); the button flips to Remove and `.shopping_cart_badge` increments. Open with `.shopping_cart_link`.
- **cart → complete**: `[data-test="checkout"]` → fill `firstName`/`lastName`/`postalCode` → `[data-test="continue"]` → `.summary_total_label` → `[data-test="finish"]` → complete anchor.

## Quirks

- **DOM-only, no API** (above) — read facts from the DOM; don't wait on network for data (the analytics XHRs are telemetry noise: `POST /api/unique-events/submit` & `/api/summed-events/submit`, both 401 — a read-only recon note; mark ignorable).
- **Controlled React inputs**: `type` appends to existing value; clear first (the lib does).
- **`data-test` hooks everywhere** — stable selectors; prefer them over classes/text.
- Alternate users are behavior probes: `problem_user` (broken images/among others), `performance_glitch_user` (slow), `locked_out_user` (blocked) — ledger candidates for variability testing.

## Selector strategy

`data-test` attributes are the stable anchor (bare CSS `[data-test="…"]` works for both the selector
engine and `assertVisible`'s raw querySelector); classes (`.inventory_item`, `.cart_item`) for lists.

## Coverage & gaps

Mapped: login, catalog, add-to-cart, cart, full checkout. **Not mapped**: sort dropdown, remove-from-cart,
the alternate-user behaviors (see `ledger.md`), logout/reset.
