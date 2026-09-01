// apps/saucedemo/lib.ts — Swag Labs (https://www.saucedemo.com/) as functions.
// Rules kept throughout: anchor in -> anchor out, an `until` on every transition,
// facts read from the app's own state (localStorage) or the wire, `reached()` on every step.
//
// This app has NO backend API: login, catalogue, cart and checkout are entirely
// client-side. The only network traffic is Backtrace telemetry (see wire.md), so
// "read it off the wire" here means "read localStorage / the DOM", plus the two
// genuinely wire-borne facts: the lazy react-pdf chunk and the crash reports.
import { reached, type Session, type Report } from "../../src/index.ts";

export const HOME = "https://www.saucedemo.com/";
export const PASSWORD = "secret_sauce";

/** The six accounts the login page advertises. All share PASSWORD. */
export const USERS = [
  "standard_user",
  "locked_out_user",
  "problem_user",
  "performance_glitch_user",
  "error_user",
  "visual_user",
] as const;
export type User = (typeof USERS)[number];

/** Cheap anchors: URL + one element that only that screen has. */
export const anchors = {
  login:     { url: "/",                       el: "#login-button" },
  inventory: { url: "/inventory.html",         el: "[data-test='inventory-list']" },
  item:      { url: "/inventory-item.html",    el: "[data-test='back-to-products']" },
  cart:      { url: "/cart.html",              el: "[data-test='cart-list']" },
  stepOne:   { url: "/checkout-step-one.html", el: "[data-test='firstName']" },
  stepTwo:   { url: "/checkout-step-two.html", el: "[data-test='total-label']" },
  complete:  { url: "/checkout-complete.html", el: "[data-test='complete-header']" },
} as const;

/** The catalogue as standard_user sees it. `id` is the number stored in cart-contents. */
export const CATALOG = [
  { id: 0, name: "Sauce Labs Bike Light",             price: 9.99  },
  { id: 1, name: "Sauce Labs Bolt T-Shirt",           price: 15.99 },
  { id: 2, name: "Sauce Labs Onesie",                 price: 7.99  },
  { id: 3, name: "Test.allTheThings() T-Shirt (Red)", price: 15.99 },
  { id: 4, name: "Sauce Labs Backpack",               price: 29.99 },
  { id: 5, name: "Sauce Labs Fleece Jacket",          price: 49.99 },
] as const;

/** data-test suffix the app builds from a product name: lowercase, spaces -> dashes. */
export const slug = (name: string) => name.toLowerCase().replace(/\s+/g, "-");
export const byId = (id: number) => CATALOG.find((p) => p.id === id)!;

const ERROR = "[data-test='error']";
const BADGE = "[data-test='shopping-cart-badge']";

// ---------------------------------------------------------------- state (this app's "wire")

/** The cart: the app keeps it in localStorage as a JSON array of product ids. */
export const cartIds = (s: Session): Promise<number[]> =>
  s.evaluate("JSON.parse(localStorage.getItem('cart-contents') || '[]')") as Promise<number[]>;

/** The session: a client-side cookie `session-username=<user>`. No token, no server call. */
export const sessionUser = (s: Session): Promise<string | null> =>
  s.evaluate("document.cookie.match(/session-username=([^;]*)/)?.[1] || null") as Promise<string | null>;

/** Wipe cookie + cart without using the UI — the fast way back to a known state. */
export async function clearSession(s: Session) {
  await s.evaluate(
    "document.cookie='session-username=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';" +
    "localStorage.removeItem('cart-contents')");
}

/** Assert an anchor without acting. A standalone `until` is never flagged alreadyTrue. */
export async function at(s: Session, a: { el: string }, timeout = 2000) {
  return reached(await s.until({ selector: a.el }, { timeout }), "anchor");
}

/** The visible error banner, or null. Shared by login, checkout and the deep-link guard. */
export const errorText = (s: Session): Promise<string | null> =>
  s.evaluate(`document.querySelector("${ERROR}")?.textContent ?? null`) as Promise<string | null>;

/** Dismiss the banner (its × is `[data-test='error-button']`). A stale banner makes the
 *  next `until: { selector: error }` alreadyTrue, so clear it between attempts. */
export async function dismissError(s: Session) {
  if (await s.holds({ selector: ERROR })) reached(await s.click("[data-test='error-button']", { until: { gone: ERROR } }), "dismiss error");
}

// ---------------------------------------------------------------- auth

/** Reach the login form from anywhere, logged out and with an empty cart. */
export async function reachLogin(s: Session) {
  if (!s.page.url().startsWith(HOME)) await s.navigate(HOME);
  await clearSession(s);
  await s.navigate(HOME);
  await at(s, anchors.login);
  await dismissError(s);
}

/**
 * Log in. Returns `which: "inventory" | "error"` — a refusal costs milliseconds, not a budget.
 *
 * performance_glitch_user blocks the main thread for ~5 s inside the submit handler, which is
 * longer than `timeouts.action` (3 s): Playwright's click never returns in time and disco
 * reports the act FAILED even though the click worked. Raising the *session's* action budget
 * for the duration of the click is the only fix (`timeout:` only governs `until`). See friction.md #1.
 */
export async function login(s: Session, user: string, password = PASSWORD) {
  await at(s, anchors.login);
  reached(await s.fill("#user-name", user));
  reached(await s.fill("#password", password));
  const slowUser = user === "performance_glitch_user";
  const saved = s.timeouts.action;
  if (slowUser) s.timeouts.action = 12000; // measured: submit blocks the main thread 5.1–5.3 s
  try {
    const r = await s.click("#login-button", {
      until: { any: [
        { selector: anchors.inventory.el, label: "inventory" },
        { selector: ERROR, label: "error" },
      ] },
      timeout: slowUser ? 15000 : 5000,
    });
    if (!r.ok) throw new Error(`${r.action}: login click ${r.diagnosis?.reason} — ${r.diagnosis?.message}`);
    if (!r.until?.ok) throw new Error(`${r.action}: login went nowhere (${s.page.url()})`);
    return { act: r.action, which: r.until.which as "inventory" | "error", ms: r.timing.totalMs, report: r,
             error: r.until.which === "error" ? await errorText(s) : null };
  } finally { s.timeouts.action = saved; }
}

/** Log in and insist it worked. */
export async function loginOk(s: Session, user: string) {
  await reachLogin(s);
  const r = await login(s, user);
  if (r.which !== "inventory") throw new Error(`${user}: expected inventory, got error ${JSON.stringify(r.error)}`);
  return r;
}

/** Log in and insist it was refused; returns the banner text. */
export async function loginRefused(s: Session, user: string, password = PASSWORD) {
  await reachLogin(s);
  const r = await login(s, user, password);
  if (r.which !== "error") throw new Error(`${user}: expected a refusal, landed on ${s.page.url()}`);
  return r.error!;
}

// ---------------------------------------------------------------- burger menu

// The sidebar is react-burger-menu: its links are in the DOM and *visible to Playwright*
// even when the menu is shut (the wrap is translated off-canvas at x≈-276, aria-hidden=true).
// So `{ selector: "[data-test='logout-sidebar-link']", visible: true }` is ALWAYS true.
// The honest open/closed anchor is the wrap's aria-hidden.
const MENU_OPEN = ".bm-menu-wrap[aria-hidden='false']";
const MENU_SHUT = ".bm-menu-wrap[aria-hidden='true']";

/** Open the burger menu. Click `#react-burger-menu-btn`, NOT `[data-test='open-menu']` —
 *  the latter is the <img> inside the button and is diagnosed `occluded` by its own parent. */
export async function openMenu(s: Session) {
  if (await s.holds({ selector: MENU_OPEN })) return;
  reached(await s.click("#react-burger-menu-btn", { until: { selector: MENU_OPEN } }), "open menu");
}

export async function closeMenu(s: Session) {
  if (await s.holds({ selector: MENU_SHUT })) return;
  reached(await s.click("#react-burger-cross-btn", { until: { selector: MENU_SHUT } }), "close menu");
}

/** Menu → Logout. Clears the session cookie (the cart survives — it is localStorage). */
export async function signOut(s: Session) {
  await openMenu(s);
  reached(await s.click("[data-test='logout-sidebar-link']", { until: { selector: anchors.login.el } }), "logout");
  return { user: await sessionUser(s), cart: await cartIds(s) };
}

/** Menu → Reset App State. Empties the cart in place; it does NOT close the menu. */
export async function resetAppState(s: Session) {
  await openMenu(s);
  reached(await s.click("[data-test='reset-sidebar-link']", { until: { gone: BADGE } }), "reset app state");
  await closeMenu(s);
  return await cartIds(s);
}

// ---------------------------------------------------------------- inventory

/** Every product card as the screen renders it right now. */
export function products(s: Session) {
  return s.evaluate(`Array.from(document.querySelectorAll("[data-test='inventory-item']")).map(e => ({
    name:  e.querySelector("[data-test='inventory-item-name']")?.textContent,
    price: e.querySelector("[data-test='inventory-item-price']")?.textContent,
    img:   (e.querySelector("img")?.getAttribute("src") || "").split("/").pop(),
    btn:   e.querySelector("button")?.getAttribute("data-test"),
  }))`) as Promise<{ name: string; price: string; img: string; btn: string }[]>;
}

export type SortValue = "az" | "za" | "lohi" | "hilo";
const SORT_LABEL: Record<SortValue, string> = {
  az: "Name (A to Z)", za: "Name (Z to A)", lohi: "Price (low to high)", hilo: "Price (high to low)",
};

/**
 * Sort the catalogue. The postcondition is the app's own `[data-test='active-option']`
 * label, not the list order — a skeleton-free list always "has rows".
 *
 * `applied: false` is a real outcome: for problem_user and error_user the <select> is a
 * controlled input that reverts (its `.value` snaps back to "az", the label never changes
 * and nothing reorders). `s.select` still reports ok — Playwright did set the value; React
 * threw it away — so ok is NOT the signal, `until.ok` is.
 */
export async function sortBy(s: Session, value: SortValue) {
  await at(s, anchors.inventory);
  const label = SORT_LABEL[value];
  const r = await s.select("[data-test='product-sort-container']", value, {
    until: { selector: `[data-test='active-option']:text-is("${label}")` },
    timeout: 1500, // measured: <60 ms when it works; the broken users never apply it at all
  });
  if (!r.ok) throw new Error(`${r.action}: sort ${value} ${r.diagnosis?.reason}`);
  return { act: r.action, applied: !!r.until?.ok, names: (await products(s)).map((p) => p.name) };
}

/**
 * Add one product to the cart from the inventory list.
 * Returns `{ added }` — false is a real outcome: problem_user and error_user silently
 * fail on the odd-numbered ids (1, 3, 5). error_user logs `Failed to add item to the cart.`
 * to the console (in `report.console`); problem_user says nothing anywhere.
 */
export async function addToCart(s: Session, id: number) {
  await at(s, anchors.inventory);
  const sl = slug(byId(id).name);
  const r = await s.click(`[data-test='add-to-cart-${sl}']`, {
    until: { selector: `[data-test='remove-${sl}']` }, timeout: 1500, // measured: <100 ms when it works
  });
  if (!r.ok) throw new Error(`${r.action}: add ${sl} ${r.diagnosis?.reason} — ${r.diagnosis?.message}`);
  return { act: r.action, added: !!r.until?.ok, cart: await cartIds(s), console: r.console ?? [] };
}

/** Open a product's detail page from its title link. `/inventory-item.html?id=<n>`. */
export async function openItem(s: Session, id: number) {
  await at(s, anchors.inventory);
  reached(await s.click(`[data-test='item-${id}-title-link']`, { until: { selector: anchors.item.el } }), "open item");
  return await s.evaluate(`({
    url: location.href,
    name: document.querySelector("[data-test='inventory-item-name']")?.textContent,
    price: document.querySelector("[data-test='inventory-item-price']")?.textContent,
    btn: document.querySelector("[data-test='add-to-cart'], [data-test='remove']")?.getAttribute("data-test"),
  })`) as Promise<{ url: string; name: string; price: string; btn: string }>;
}

/** The detail page's button has no slug: `[data-test='add-to-cart']` / `[data-test='remove']`. */
export async function addToCartFromItem(s: Session) {
  await at(s, anchors.item);
  const r = await s.click("[data-test='add-to-cart']", { until: { selector: "[data-test='remove']" }, timeout: 1500 });
  if (!r.ok) throw new Error(`${r.action}: item add ${r.diagnosis?.reason}`);
  return { act: r.action, added: !!r.until?.ok, cart: await cartIds(s) };
}

export async function backToProducts(s: Session) {
  reached(await s.click("[data-test='back-to-products']", { until: { selector: anchors.inventory.el } }), "back to products");
}

// ---------------------------------------------------------------- cart

export async function openCart(s: Session) {
  reached(await s.click("[data-test='shopping-cart-link']", { until: { selector: anchors.cart.el } }), "open cart");
  return await cartLines(s);
}

export function cartLines(s: Session) {
  return s.evaluate(`Array.from(document.querySelectorAll("[data-test='cart-list'] [data-test='inventory-item']")).map(e => ({
    qty: e.querySelector("[data-test='item-quantity']")?.textContent,
    name: e.querySelector("[data-test='inventory-item-name']")?.textContent,
    price: e.querySelector("[data-test='inventory-item-price']")?.textContent,
  }))`) as Promise<{ qty: string; name: string; price: string }[]>;
}

export async function removeFromCart(s: Session, id: number) {
  await at(s, anchors.cart);
  const sl = slug(byId(id).name);
  const r = await s.click(`[data-test='remove-${sl}']`, { until: { gone: `[data-test='remove-${sl}']` }, timeout: 1500 });
  if (!r.ok) throw new Error(`${r.action}: remove ${sl} ${r.diagnosis?.reason}`);
  return { act: r.action, removed: !!r.until?.ok, cart: await cartIds(s) };
}

export async function continueShopping(s: Session) {
  reached(await s.click("[data-test='continue-shopping']", { until: { selector: anchors.inventory.el } }), "continue shopping");
}

// ---------------------------------------------------------------- checkout

/** Cart → step one. */
export async function startCheckout(s: Session) {
  await at(s, anchors.cart);
  reached(await s.click("[data-test='checkout']", { until: { selector: anchors.stepOne.el } }), "checkout");
}

/**
 * Fill step one and continue. Returns `which: "stepTwo" | "error"` plus the values the
 * form actually holds — problem_user's Last Name box writes into First Name and leaves
 * itself empty, so `values` is the only honest record of what the app took.
 */
export async function submitCheckoutInfo(s: Session, info: { firstName: string; lastName: string; postalCode: string }) {
  await at(s, anchors.stepOne);
  await dismissError(s);
  reached(await s.fill("[data-test='firstName']", info.firstName));
  reached(await s.fill("[data-test='lastName']", info.lastName));
  reached(await s.fill("[data-test='postalCode']", info.postalCode));
  const values = await s.evaluate(`({
    firstName: document.querySelector("[data-test='firstName']").value,
    lastName:  document.querySelector("[data-test='lastName']").value,
    postalCode:document.querySelector("[data-test='postalCode']").value })`) as Record<string, string>;
  const r = await s.click("[data-test='continue']", {
    until: { any: [{ selector: anchors.stepTwo.el, label: "stepTwo" }, { selector: ERROR, label: "error" }] },
    timeout: 3000,
  });
  if (!r.ok) throw new Error(`${r.action}: continue ${r.diagnosis?.reason}`);
  if (!r.until?.ok) throw new Error(`${r.action}: continue went nowhere (${s.page.url()})`);
  return { act: r.action, which: r.until.which as "stepTwo" | "error", values,
           error: r.until.which === "error" ? await errorText(s) : null };
}

/** The overview's money, parsed. Tax is 8% of the item total, rounded to cents. */
export async function overview(s: Session) {
  await at(s, anchors.stepTwo);
  const raw = await s.evaluate(`({
    payment:  document.querySelector("[data-test='payment-info-value']")?.textContent,
    shipping: document.querySelector("[data-test='shipping-info-value']")?.textContent,
    subtotal: document.querySelector("[data-test='subtotal-label']")?.textContent,
    tax:      document.querySelector("[data-test='tax-label']")?.textContent,
    total:    document.querySelector("[data-test='total-label']")?.textContent })`) as Record<string, string>;
  const num = (t: string | undefined) => Number((t || "").replace(/[^0-9.]/g, ""));
  return { ...raw, subtotalN: num(raw.subtotal), taxN: num(raw.tax), totalN: num(raw.total) };
}

/**
 * Click Finish. Returns `{ completed }`.
 * error_user throws `ai.cesetRart is not a function` here and stays on step two with **no
 * error banner** — the console line in the report is the only evidence. That is why the
 * `until` is an `any` of the destination and a short budget, not a bare `reached`.
 */
export async function finishOrder(s: Session) {
  await at(s, anchors.stepTwo);
  const r = await s.click("[data-test='finish']", {
    until: { any: [{ selector: anchors.complete.el, label: "complete" }, { selector: ERROR, label: "error" }] },
    timeout: 2500, // measured: <200 ms when it works; error_user never gets there
  });
  if (!r.ok) throw new Error(`${r.action}: finish ${r.diagnosis?.reason}`);
  return { act: r.action, completed: r.until?.which === "complete", url: s.page.url(),
           cart: await cartIds(s), console: (r.console ?? []).map((c: any) => c.text ?? c.message ?? String(c)) };
}

/**
 * "Generate PDF order" on the completion page. It changes nothing on screen: the only
 * evidence is on the wire — two lazily-loaded chunks (`OrderReceipt-*.js`, then
 * `react-pdf.browser-*.js`, ~1.4 MB). The PDF is handed to the browser as a download.
 */
export async function generatePdf(s: Session) {
  await at(s, anchors.complete);
  const r = await s.click("[data-test='generate-pdf-order']", {
    until: { request: "react-pdf.browser", landed: true }, timeout: 15000, // measured: 1.4 MB chunk, 0.4–3 s cold
  });
  if (!r.ok) throw new Error(`${r.action}: generate pdf ${r.diagnosis?.reason}`);
  const chunks = s.store.requests({ action: r.action }).map((q) => q.path);
  return { act: r.action, fetched: !!r.until?.ok, chunks };
}

export async function backHome(s: Session) {
  reached(await s.click("[data-test='back-to-products']", { until: { selector: anchors.inventory.el } }), "back home");
}

/** login → add ids → cart → checkout → finish. The whole happy path, one call. */
export async function buy(s: Session, user: string, ids: number[],
                          info = { firstName: "Ada", lastName: "Lovelace", postalCode: "12345" }) {
  await loginOk(s, user);
  for (const id of ids) await addToCart(s, id);
  await openCart(s);
  await startCheckout(s);
  const step = await submitCheckoutInfo(s, info);
  if (step.which !== "stepTwo") throw new Error(`checkout refused: ${step.error}`);
  const money = await overview(s);
  const done = await finishOrder(s);
  return { money, done };
}

// ---------------------------------------------------------------- guards

/**
 * Every /*.html route is guarded client-side: without the cookie it bounces to `/`
 * and shows "Epic sadface: You can only access '<path>' when you are logged in."
 */
export async function deepLinkGuard(s: Session, path: string) {
  await clearSession(s);
  await s.navigate(HOME + path.replace(/^\//, ""));
  reached(await s.until({ selector: ERROR }, { timeout: 3000 }), "guard banner");
  return { url: s.page.url(), error: await errorText(s) };
}
