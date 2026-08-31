// Function library for Sauce Labs "Swag Labs" demo (product instance #3). Chosen to be UNLIKE OpenEMR:
// a client-rendered React SPA with **no data API** (the catalog lives in the JS bundle; the only XHR is
// analytics telemetry that 401s) — so this pack is DOM-first, exercising the anchor + postcondition pattern
// and lib/nav *without* the wire-first crutch. That contrast is the point: it proves the Layer-1 reusable
// layer generalizes past wire-rich apps. Validated against https://www.saucedemo.com — including
// `performance_glitch_user`, whose login click settles `no-effect` (nothing observable for seconds) and is
// only safe because the step waits on its postcondition, not the verdict (DECISIONS #35).
//
//   import { connect } from "../../src/client.ts";
//   import * as swag from "./lib.ts";
//   const s = await connect("saucedemo");
//   await swag.login(s);
//   await swag.addToCart(s, "Sauce Labs Backpack");
//   const order = await swag.checkout(s, { firstName: "Ada", lastName: "Lovelace", zip: "90210" });
//
import type { Session } from "../../src/client.ts";
import { assertVisible, reached } from "../../lib/nav.ts";

export const BASE = "https://www.saucedemo.com/";
export const USERS = { standard: "standard_user", problem: "problem_user", glitch: "performance_glitch_user", locked: "locked_out_user" };
export const PASSWORD = "secret_sauce";
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dt = (t: string) => `[data-test="${t}"]`;

// ---- anchors ----
export async function assertInventory(s: Session): Promise<void> {
  await assertVisible(s, ".inventory_list", "swag: not on the inventory anchor");
}
export async function assertComplete(s: Session): Promise<void> {
  await assertVisible(s, ".complete-header", "swag: order-complete anchor not reached");
}

// ---- steps ----

/** Log in and reach the inventory anchor. Idempotent: skips if already on inventory. Throws with the
 *  app's own error text on bad creds (e.g. locked_out_user). */
export async function login(s: Session, opts: { user?: string; pass?: string } = {}): Promise<void> {
  const user = opts.user ?? USERS.standard;
  const pass = opts.pass ?? PASSWORD;
  const onInventory = await s.evaluate<boolean>(() => location.pathname.includes("/inventory.html")).catch(() => false);
  if (!onInventory) {
    reached(await s.navigate(BASE, { budgetMs: 12000, until: { selector: "#login-button", visible: true } }), "swag: login page");
    await s.fill("#user-name", user);   // fill replaces (controlled inputs); type would append
    await s.fill("#password", pass);
    // The click ends in ONE of two states — the inventory, or the app's own error banner — so the
    // postcondition waits for either. As performance_glitch_user nothing is observable for seconds
    // (verdict `no-effect`); the predicate, not the verdict, is what decides.
    const r = await s.click("#login-button", { until: { fn: () => !!document.querySelector(".inventory_list") || !!document.querySelector('[data-test="error"]'), budgetMs: 15000 } });
    const err = await s.evaluate<string | null>(() => document.querySelector('[data-test="error"]')?.textContent ?? null).catch(() => null);
    if (err) throw new Error(`login failed: ${err}`);
    reached(r, "swag: login");
  }
  await assertInventory(s);
}

export interface Product { name: string; price: string; slug: string }

/** The catalog, read from the DOM (there is no API for it). */
export async function listProducts(s: Session): Promise<Product[]> {
  await assertInventory(s);
  return s.evaluate<Product[]>(() => [...document.querySelectorAll(".inventory_item")].map((it) => ({
    name: (it.querySelector(".inventory_item_name")?.textContent ?? "").trim(),
    price: (it.querySelector(".inventory_item_price")?.textContent ?? "").trim(),
    slug: (it.querySelector("button")?.getAttribute("data-test") ?? "").replace(/^add-to-cart-/, ""),
  })));
}

/** Current cart badge count (0 when empty/absent). */
export async function cartCount(s: Session): Promise<number> {
  return s.evaluate<number>(() => Number(document.querySelector(".shopping_cart_badge")?.textContent || "0"));
}

/** Add an item to the cart by product name; returns the new cart count. Idempotent-aware: if the item is
 *  already added (button flipped to Remove), leaves it and returns the count. The postcondition is the badge
 *  growing past the count we read — the baseline travels into the page as `fnArg`. */
export async function addToCart(s: Session, name: string): Promise<number> {
  await assertInventory(s);
  const before = await cartCount(s);
  const add = dt(`add-to-cart-${slug(name)}`);
  if (!(await s.watch({ selector: add }, { budgetMs: 800 })).matched) return before; // already in cart
  reached(await s.click(add, { until: { fn: (b: number) => Number(document.querySelector(".shopping_cart_badge")?.textContent || "0") > b, fnArg: before } }), `addToCart(${name})`);
  return cartCount(s);
}

/** Go to the cart anchor and return the item names in it. */
export async function openCart(s: Session): Promise<string[]> {
  reached(await s.click(".shopping_cart_link", { until: { selector: ".cart_list", visible: true } }), "swag: cart anchor");
  return s.evaluate<string[]>(() => [...document.querySelectorAll(".cart_item .inventory_item_name")].map((e) => (e.textContent ?? "").trim()));
}

export interface Order { total: string }

/** Complete checkout from the cart: checkout → fill info → continue → finish → order-complete anchor.
 *  Returns the order total (read off the summary). Assumes items are already in the cart. */
export async function checkout(s: Session, info: { firstName: string; lastName: string; zip: string }): Promise<Order> {
  if (!(await s.evaluate<boolean>(() => location.pathname.includes("/cart.html")).catch(() => false))) await openCart(s);
  reached(await s.click(dt("checkout"), { until: { selector: dt("firstName"), visible: true } }), "swag: checkout step-one");
  await s.fill(dt("firstName"), info.firstName);
  await s.fill(dt("lastName"), info.lastName);
  await s.fill(dt("postalCode"), info.zip);
  reached(await s.click(dt("continue"), { until: { selector: ".summary_total_label", visible: true } }), "swag: checkout step-two");
  const total = await s.evaluate<string>(() => (document.querySelector(".summary_total_label")?.textContent ?? "").replace(/^Total:\s*/, "").trim());
  reached(await s.click(dt("finish"), { until: { selector: ".complete-header", visible: true } }), "swag: order complete");
  return { total };
}
