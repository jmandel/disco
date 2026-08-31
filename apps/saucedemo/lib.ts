// Function library for Sauce Labs "Swag Labs" (https://www.saucedemo.com) — product instance #3.
// A client-rendered React SPA with NO data API: every fact lives in the DOM, every transition is a
// pushState (the verdict is never `navigated` for in-app moves), and the only network is static assets
// plus a third-party error reporter (backtrace.io) that 401s/CORS-fails in the background.
// So this pack is DOM-first: `lib/nav` anchors + postconditions on every act, no `lib/wire` at all.
//
//   import { connect } from "../../src/client.ts";
//   import * as swag from "./lib.ts";
//   const s = await connect("saucedemo");
//   await swag.login(s, { user: "standard_user", pass: "secret_sauce" });   // idempotent; throws the app's own error text on refusal
//   await swag.addToCart(s, "Sauce Labs Backpack");                          // idempotent (already-in-cart is a no-op success)
//   await swag.openCart(s);
//   const { total } = await swag.checkout(s, { firstName: "Ada", lastName: "Lovelace", zip: "12345" });
//
// Evidence for every claim below: apps/saucedemo/nav-and-quirks.md + ledger.md (act ids from run 1).
// Write footprint: none server-side (there is no server state); client state = cookie `session-username`
// + the in-memory/localStorage cart, which `logout` / `resetAppState` clear.
import type { Session } from "../../src/client.ts";
import { assertVisible, reached, until } from "../../lib/nav.ts";

export const BASE = "https://www.saucedemo.com";
export const PASSWORD = "secret_sauce";
/** The users the login page itself advertises (act:eval on `/`). Four are characterized in ledger.md. */
export const USERS = {
  standard: "standard_user",
  locked: "locked_out_user",
  problem: "problem_user",
  glitch: "performance_glitch_user",
  error: "error_user",
  visual: "visual_user",
} as const;

// ---------------------------------------------------------------- anchors (cheap predicates, read in one eval)

export interface AppState {
  url: string;
  path: string;
  /** `session-username` cookie value, or null. Set even on a REFUSED login (act:18/60) — not proof of access. */
  user: string | null;
  loginForm: boolean;
  inventory: boolean;
  cart: boolean;
  checkoutInfo: boolean;
  checkoutOverview: boolean;
  complete: boolean;
  /** Text of the app's red error banner (`[data-test="error"]`), or null. */
  error: string | null;
  /** Cart badge count (null when the cart is empty — the badge element is absent). */
  badge: number | null;
}

/** Where are we? One in-page read; every pack function starts from this (no position is ever assumed). */
export async function state(s: Session): Promise<AppState> {
  return s.evaluate<AppState>(() => {
    const q = (sel: string) => document.querySelector(sel);
    const m = /(?:^|;\s*)session-username=([^;]*)/.exec(document.cookie);
    const badge = q(".shopping_cart_badge")?.textContent?.trim();
    return {
      url: location.href,
      path: location.pathname,
      user: m ? decodeURIComponent(m[1]) : null,
      loginForm: !!q("#login-button"),
      inventory: !!q(".inventory_list"),
      cart: !!q(".cart_list") && !!q("#checkout"),
      checkoutInfo: !!q("#first-name") && !!q("#continue"),
      checkoutOverview: !!q("#finish"),
      complete: !!q(".complete-header"),
      error: q('[data-test="error"]')?.textContent?.trim() ?? null,
      badge: badge ? Number(badge) : null,
    };
  });
}

/** Anchor: the login form (`/`). */
export async function assertLoginPage(s: Session): Promise<void> {
  await assertVisible(s, "#login-button", "saucedemo: not at the login anchor (#login-button missing)");
}
/** Anchor: the inventory (`/inventory.html`). */
export async function assertInventory(s: Session): Promise<void> {
  await assertVisible(s, ".inventory_list", "saucedemo: not at the inventory anchor (.inventory_list missing)");
}
/** Anchor: the cart (`/cart.html`). */
export async function assertCart(s: Session): Promise<void> {
  await assertVisible(s, "#checkout", "saucedemo: not at the cart anchor (#checkout missing)");
}

// ---------------------------------------------------------------- login / logout

export interface LoginOpts { user: string; pass?: string; /** login budget; the glitch user needs ~5.1s (n=4) */ budgetMs?: number }
export interface LoginResult { user: string; alreadyLoggedIn: boolean; action?: string; verdict?: string; untilMs?: number }

/** Log in as `user`. Idempotent: if the inventory is already showing for this user, nothing happens.
 *  Otherwise reaches the login form (navigating to `/` always renders it, whatever the cookie says —
 *  act:13), submits, and waits for EITHER the inventory OR the app's error banner (the postcondition is
 *  the disjunction: the `performance_glitch_user` click reports `no-effect` at 500ms and shows the
 *  inventory ~5s later — acts 22/26/69; the `locked_out_user` shows the banner at ~8ms while a
 *  CORS-blocked telemetry POST holds settlement 3.5s — acts 18/60/65). Throws with the app's own
 *  error text on refusal. */
export async function login(s: Session, opts: LoginOpts): Promise<LoginResult> {
  const { user, pass = PASSWORD, budgetMs = 20000 } = opts;
  const st = await state(s);
  if (st.inventory && st.user === user) return { user, alreadyLoggedIn: true };
  if (!st.loginForm) {
    // Logged in as someone else, mid-flow, or on the complete page: `/` always shows the form (act:13).
    reached(await s.navigate(`${BASE}/`, { until: { selector: "#login-button", visible: true, budgetMs: 15000 } }), "login: reach the login form");
  }
  reached(await s.fill("#user-name", user), "login: fill username");
  reached(await s.fill("#password", pass), "login: fill password");
  const r = reached(await s.click("#login-button", {
    until: { fn: () => !!document.querySelector(".inventory_list") || !!document.querySelector('[data-test="error"]'), budgetMs },
    evaluateAfter: () => ({ error: document.querySelector('[data-test="error"]')?.textContent?.trim() ?? null, inventory: !!document.querySelector(".inventory_list"), url: location.href }),
  }), `login(${user})`);
  const post = r.evaluateAfter as { error: string | null; inventory: boolean; url: string };
  if (post.error) throw new Error(`login(${user}) refused: ${post.error} (${r.action}, verdict ${r.verdict}, until ${r.until?.elapsedMs}ms)`);
  if (!post.inventory) throw new Error(`login(${user}): neither inventory nor error banner after submit (${r.action}, verdict ${r.verdict}, url ${post.url})`);
  await assertInventory(s);
  return { user, alreadyLoggedIn: false, action: r.action, verdict: r.verdict, untilMs: r.until?.elapsedMs };
}

/** Open the burger menu (a ~500ms slide-in animation; the links exist immediately but are `visible`
 *  only once laid out — `until` handles that, acts 47/56/73) and return once the named link is clickable. */
async function openMenu(s: Session, link: string): Promise<void> {
  const st = await state(s);
  if (st.loginForm) throw new Error(`openMenu: no menu on the login page (${st.url})`);
  const already = await s.watch({ selector: link, visible: true }, { budgetMs: 300 });
  if (already.matched) return;
  reached(await s.click("#react-burger-menu-btn", { until: { selector: link, visible: true, budgetMs: 5000 } }), "openMenu");
}

/** Log out via the menu (clears the `session-username` cookie — act:49/57/74). No-op on the login page. */
export async function logout(s: Session): Promise<void> {
  if ((await state(s)).loginForm) return;
  await openMenu(s, "#logout_sidebar_link");
  reached(await s.click("#logout_sidebar_link", { until: { selector: "#login-button", visible: true, budgetMs: 5000 } }), "logout");
  await assertLoginPage(s);
}

/** Menu → "Reset App State": empties the cart (badge disappears — act:48) but does NOT navigate or clear
 *  form fields. Closes the menu afterwards so the page is actionable again. */
export async function resetAppState(s: Session): Promise<void> {
  await openMenu(s, "#reset_sidebar_link");
  reached(await s.click("#reset_sidebar_link", { until: { fn: () => !document.querySelector(".shopping_cart_badge"), budgetMs: 5000 } }), "resetAppState");
  reached(await s.click("#react-burger-cross-btn", { until: { fn: () => document.querySelector(".bm-menu-wrap")?.getAttribute("aria-hidden") === "true", budgetMs: 5000 } }), "resetAppState: close menu");
}

// ---------------------------------------------------------------- inventory

export interface Product { name: string; price: number; description: string; image: string; inCart: boolean; /** the id/data-test slug, e.g. `sauce-labs-backpack` */ slug: string }

/** The product list, off the DOM (there is no API; the DOM holds all 6 — nothing is virtualized). */
export async function listProducts(s: Session): Promise<Product[]> {
  await assertInventory(s);
  return s.evaluate<Product[]>(() => [...document.querySelectorAll(".inventory_item")].map((it) => {
    const btn = it.querySelector("button");
    const dt = btn?.getAttribute("data-test") ?? "";
    return {
      name: it.querySelector(".inventory_item_name")?.textContent?.trim() ?? "",
      price: Number((it.querySelector(".inventory_item_price")?.textContent ?? "").replace(/[^0-9.]/g, "")),
      description: it.querySelector(".inventory_item_desc")?.textContent?.trim() ?? "",
      image: it.querySelector("img")?.getAttribute("src") ?? "",
      inCart: dt.startsWith("remove-"),
      slug: dt.replace(/^(add-to-cart|remove)-/, ""),
    };
  }));
}

export interface AddResult { name: string; slug: string; already: boolean; badge: number | null; action?: string; verdict?: string }

/** Put a product in the cart by its displayed name. Idempotent: if the item is already in the cart (its
 *  button reads "Remove") this is a success no-op — clicking the add selector then would be a `not-found`
 *  diagnosis (act:54). Postcondition: the button flips to `[data-test="remove-<slug>"]`. When the app
 *  swallows the click (problem_user on 3 of 6 items: acts 37/38/40, verdict `no-effect`) this throws with
 *  the verdict rather than pretending. */
export async function addToCart(s: Session, name: string, opts: { budgetMs?: number } = {}): Promise<AddResult> {
  const products = await listProducts(s);
  const p = products.find((x) => x.name === name);
  if (!p) throw new Error(`addToCart: no product named ${JSON.stringify(name)}; have: ${products.map((x) => x.name).join(" | ")}`);
  if (p.inCart) return { name, slug: p.slug, already: true, badge: (await state(s)).badge };
  const r = await s.click(`[data-test="add-to-cart-${p.slug}"]`, {
    until: { selector: `[data-test="remove-${p.slug}"]`, visible: true, budgetMs: opts.budgetMs ?? 4000 },
    evaluateAfter: () => document.querySelector(".shopping_cart_badge")?.textContent ?? null,
  });
  if (r.verdict === "diagnosis" || (r.until && !r.until.matched)) {
    throw new Error(`addToCart(${name}): the app did not take the click — verdict ${r.verdict}, until ${r.until?.matched ? "matched" : "NOT matched"} in ${r.until?.elapsedMs ?? "?"}ms (${r.action}); this is the problem_user signature on some items`);
  }
  const badge = r.evaluateAfter == null ? null : Number(r.evaluateAfter);
  return { name, slug: p.slug, already: false, badge, action: r.action, verdict: r.verdict };
}

// ---------------------------------------------------------------- cart + checkout

export interface CartLine { name: string; qty: number; price: number }

/** Go to the cart (from anywhere logged-in with a cart link) and return its lines. Postcondition: `#checkout`. */
export async function openCart(s: Session): Promise<CartLine[]> {
  const st = await state(s);
  if (st.loginForm) throw new Error("openCart: not logged in (login form showing)");
  if (!st.cart) reached(await s.click('[data-test="shopping-cart-link"]', { until: { selector: "#checkout", visible: true, budgetMs: 5000 } }), "openCart");
  await assertCart(s);
  return s.evaluate<CartLine[]>(() => [...document.querySelectorAll(".cart_item")].map((it) => ({
    name: it.querySelector(".inventory_item_name")?.textContent?.trim() ?? "",
    qty: Number(it.querySelector(".cart_quantity")?.textContent ?? "0"),
    price: Number((it.querySelector(".inventory_item_price")?.textContent ?? "").replace(/[^0-9.]/g, "")),
  })));
}

export interface CheckoutInfo { firstName: string; lastName: string; zip: string }
export interface CheckoutResult { items: string[]; subtotal: number; tax: number; total: number; completeHeader: string; actions: string[] }

const money = (label: string | null | undefined): number => Number((label ?? "").replace(/^[^$]*\$/, "").replace(/[^0-9.]/g, ""));

/** Run the whole checkout from the cart: info form → overview → finish. Every step gates on its own
 *  postcondition (or the app's error banner, which becomes the thrown message). Verifies the typed values
 *  actually landed in the fields before continuing (problem_user's last-name field drops input and its
 *  first-name field keeps one stray char — act:43-46) so the failure names the field, not "Continue did
 *  nothing". Returns the totals read off the overview (tax is 8% of the subtotal, ledger #9). */
export async function checkout(s: Session, info: CheckoutInfo): Promise<CheckoutResult> {
  const actions: string[] = [];
  const st = await state(s);
  if (!st.cart && !st.checkoutInfo) await openCart(s);
  if (!(await state(s)).checkoutInfo) {
    actions.push(reached(await s.click("#checkout", { until: { selector: "#continue", visible: true, budgetMs: 5000 } }), "checkout: open info form").action);
  }
  actions.push(reached(await s.fill("#first-name", info.firstName), "checkout: fill first name").action);
  actions.push(reached(await s.fill("#last-name", info.lastName), "checkout: fill last name").action);
  actions.push(reached(await s.fill("#postal-code", info.zip), "checkout: fill zip").action);
  const typed = await s.evaluate<{ first: string; last: string; zip: string }>(() => ({
    first: (document.querySelector("#first-name") as HTMLInputElement)?.value, last: (document.querySelector("#last-name") as HTMLInputElement)?.value, zip: (document.querySelector("#postal-code") as HTMLInputElement)?.value,
  }));
  const bad = ([["first name", typed.first, info.firstName], ["last name", typed.last, info.lastName], ["zip", typed.zip, info.zip]] as const).filter(([, got, want]) => got !== want);
  if (bad.length) throw new Error(`checkout: the form did not keep what was typed — ${bad.map(([f, got, want]) => `${f}: wanted ${JSON.stringify(want)}, field holds ${JSON.stringify(got)}`).join("; ")} (problem_user signature; acts ${actions.join(",")})`);

  const cont = reached(await s.click("#continue", {
    until: { fn: () => !!document.querySelector("#finish") || !!document.querySelector('[data-test="error"]'), budgetMs: 8000 },
    evaluateAfter: () => document.querySelector('[data-test="error"]')?.textContent?.trim() ?? null,
  }), "checkout: continue");
  actions.push(cont.action);
  if (cont.evaluateAfter) throw new Error(`checkout: continue refused: ${cont.evaluateAfter} (${cont.action}, verdict ${cont.verdict})`);
  await assertVisible(s, "#finish", "checkout: overview anchor (#finish) not reached");

  const overview = await s.evaluate<{ items: string[]; subtotal: string | null; tax: string | null; total: string | null }>(() => ({
    items: [...document.querySelectorAll(".cart_item .inventory_item_name")].map((e) => e.textContent?.trim() ?? ""),
    subtotal: document.querySelector('[data-test="subtotal-label"]')?.textContent ?? null,
    tax: document.querySelector('[data-test="tax-label"]')?.textContent ?? null,
    total: document.querySelector('[data-test="total-label"]')?.textContent ?? null,
  }));
  const fin = reached(await s.click("#finish", {
    until: { selector: ".complete-header", visible: true, budgetMs: 8000 },
    evaluateAfter: () => document.querySelector(".complete-header")?.textContent?.trim() ?? "",
  }), "checkout: finish");
  actions.push(fin.action);
  const completeHeader = String(fin.evaluateAfter ?? "");
  if (!/thank you for your order/i.test(completeHeader)) throw new Error(`checkout: finished but the completion header reads ${JSON.stringify(completeHeader)} (${fin.action}, verdict ${fin.verdict})`);
  return { items: overview.items, subtotal: money(overview.subtotal), tax: money(overview.tax), total: money(overview.total), completeHeader, actions };
}

/** From the completion page, "Back Home" → inventory. */
export async function backHome(s: Session): Promise<void> {
  reached(await s.click("#back-to-products", { until: { selector: ".inventory_list", visible: true, budgetMs: 5000 } }), "backHome");
}

/** Wait for a named anchor from outside (e.g. after a manual navigation). Thin alias so callers don't import lib/nav for this. */
export async function reach(s: Session, selector: string, budgetMs = 5000): Promise<void> {
  await until(s, { selector, visible: true }, { budgetMs, msg: `saucedemo: ${selector} not reached` });
}
