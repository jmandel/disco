# saucedemo — the wire

**There is no application API.** Login, the catalogue, the cart, checkout and the order are all
computed in the browser. In two full runs of `check.ts` (17 workflows, ~100 acts) the log contains
**zero first-party XHR/fetch requests**:

```sql
SELECT host, resource_type, count(*) n FROM requests GROUP BY 1,2 ORDER BY n DESC;
-- www.saucedemo.com  image/document/script/stylesheet/manifest  … (static only)
-- submit.backtrace.io  fetch  29      <- crash reports
-- events.backtrace.io  fetch   6      <- session pings
-- fonts.googleapis.com / fonts.gstatic.com  stylesheet/font
SELECT count(*) FROM requests WHERE host='www.saucedemo.com' AND resource_type IN ('xhr','fetch');  -- 0
```

So "read it off the wire" on this app means **read the two places state actually lives**:

| Fact | Where it lives | How to read it |
|---|---|---|
| who is logged in | cookie `session-username=<user>` (set by JS, no `Set-Cookie` anywhere) | `sessionUser(s)` |
| the cart | `localStorage['cart-contents']` — a JSON array of numeric product ids, e.g. `[4,0,2]` | `cartIds(s)` |
| the catalogue, prices, tax | constants inside `/assets/index-XyuNVFOR.js` | the DOM (`products(s)`) |
| checkout form values | React state; the DOM `.value` may lie (see problem_user / error_user) | `submitCheckoutInfo().values` |

`SELECT path, json_extract(resp_headers,'$."set-cookie"') FROM requests WHERE resp_headers LIKE '%set-cookie%'`
returns nothing: there is no server session at all.

## Documents (all 200, all static)

| Request | Carries | Body |
|---|---|---|
| `GET /` (and `/inventory.html`, `/cart.html`, `/checkout-*.html`, `/inventory-item.html`) | the **same** 1.3 KB Vite shell for every route — an empty `<div id="root">`. `./disco aria` is the only picture of a screen | `cb1658fe8199` |
| `GET /assets/index-XyuNVFOR.js` | 527 KB — the entire client: router, catalogue data, per-user bug injection | `75216dd801c9` (`body_state: truncated`, >512 KB cap) |
| `GET /assets/index-Co7SA-g_.css` | 28 KB | `08f044a3ef3f` |
| `GET /manifest.json` | PWA manifest, `"name": "Swag Labs"` | `c82f0157a92a` |
| `GET /assets/<product>-1200x1500-*.jpg` | product photos; `sl-404-Cq1a9k9X.jpg` is the broken-image placeholder problem_user and visual_user get | |

## Lazy chunks — the one genuinely wire-borne workflow fact

"Generate PDF order" on `/checkout-complete.html` renders nothing and logs nothing. Its only evidence:

| Request | Carries | Body |
|---|---|---|
| `GET /assets/OrderReceipt-BqfNTy3l.js` | 3.9 KB — the receipt component | `1c04df158442` |
| `GET /assets/react-pdf.browser-oX9uTdte.js` | 1.4 MB — react-pdf, loaded on first click only | `48d94e0b561f` (truncated) |

`until: { request: "react-pdf.browser", landed: true }` is the postcondition (`act:382`). The PDF
itself is handed to Chromium as a download and never touches the DOM.

## Telemetry — Backtrace (Sauce Labs' own crash reporter), and why it is worth reading

Both hosts are configured with the literal placeholders `universe=UNIVERSE&token=TOKEN`, so every
call fails. That does not matter: **the request bodies are a mirror of application state**, and disco
captures `req_body` even when the response is an error.

| Endpoint | R/W | Carries |
|---|---|---|
| `POST https://events.backtrace.io/api/unique-events/submit?universe=UNIVERSE&token=TOKEN` | write | session ping. `401`, response `d2149a52970e` = `{"error":"invalid token"}`-shaped 53 B. Request body has `application: "Swag Store"`, `appversion: "3.0.0"`, the browser fingerprint and the `guid` that is also `localStorage['backtrace-guid']` (`r1-6`) |
| `POST https://events.backtrace.io/api/summed-events/submit?…` | write | same, aggregated (`r1-7`) |
| `POST https://submit.backtrace.io/UNIVERSE/TOKEN/json` | write | a **crash report**, multipart. Fails at the network layer (`body_state: error`, no status) |

A crash report's `upload_file` part (`./disco req r1-24`) contains:

- `annotations.error.message` — the app's own name for what went wrong;
- `annotations.shoppingCart` — the cart at the moment of the error;
- `attributes.user` / `attributes.username` — who was logged in;
- `attributes.application.version` — `3.0.0`;
- a full JS stack into `index-XyuNVFOR.js`;
- an `attachment_bt-breadcrumbs-0` part: **every click, navigation and HTTP call since page load**,
  with element ids and classes. It is a free session transcript.

Messages seen, and what provokes them (`SELECT count(*), substr(req_body, instr(req_body,'"error.message"'), 60) FROM requests WHERE host='submit.backtrace.io' GROUP BY 2`):

| `error.message` | Provoked by |
|---|---|
| `Someone tried to login with invalid credentials.` | any wrong username/password |
| `Locked out user tried to log in.` | `locked_out_user` |
| `Failed to add item to the cart.` | problem_user / error_user adding an odd-id product |
| `Sorting is broken!` | problem_user / error_user touching the sort dropdown |
| `Cannot read properties of undefined (reading 'value')` | error_user's Last Name field, on every keystroke |
| `ai.cesetRart is not a function` | error_user clicking **Finish** — the order silently never completes |

That last row is the point: the screen shows nothing, `[data-test='error']` is absent, and the only
record that the order failed is a console exception plus this crash report.

## Third party

`fonts.googleapis.com/css2` + `fonts.gstatic.com` (DM Sans, DM Mono). Nothing else.
