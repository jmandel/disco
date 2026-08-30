// Function library for Sauce Labs "Swag Labs" demo (product instance #3). Chosen to be UNLIKE OpenEMR:
// a client-rendered React SPA with **no data API** (the catalog lives in the JS bundle; the only XHR is
// analytics telemetry that 401s) — so this pack is DOM-first, exercising the anchor + defensive pattern
// and lib/nav *without* the wire-first crutch. That contrast is the point: it proves the Layer-1 reusable
// layer generalizes past wire-rich apps. Validated against https://www.saucedemo.com.
//
//   import { connect } from "../../src/client.ts";
//   import * as swag from "./lib.ts";
//   const s = await connect("sauce");
//   await swag.login(s);
//   await swag.addToCart(s, "Sauce Labs Backpack");
//   const order = await swag.checkout(s, { firstName: "Ada", lastName: "Lovelace", zip: "90210" });
//
import type { Session } from "../../src/client.ts";
import { assertVisible } from "../../lib/nav.ts";

export const BASE = "https://www.saucedemo.com/";
export const USERS = { standard: "standard_user", problem: "problem_user", glitch: "performance_glitch_user", locked: "locked_out_user" };
export const PASSWORD = "secret_sauce";
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dt = (t: string) => `[data-test="${t}"]`; // bare CSS: works for the selector engine AND assertVisible.s raw querySelector
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await s.navigate(BASE, { budgetMs: 12000 });
    // fields are controlled inputs; clear then type (type appends)
    await s.evaluate(() => { for (const id of ["user-name", "password"]) { const el = document.getElementById(id) as HTMLInputElement | null; if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } } });
    await s.type("#user-name", user);
    await s.type("#password", pass);
    await s.click("#login-button");
    const err = await s.evaluate<string | null>(() => document.querySelector('[data-test="error"]')?.textContent ?? null).catch(() => null);
    if (err) throw new Error(`login failed: ${err}`);
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
 *  already added (button flipped to Remove), leaves it and returns the count. */
export async function addToCart(s: Session, name: string): Promise<number> {
  await assertInventory(s);
  const before = await cartCount(s);
  const add = dt(`add-to-cart-${slug(name)}`);
  const present = (await s.watch({ selector: add }, { budgetMs: 800 })).matched;
  if (present) {
    const r = await s.click(add);
    if (r.verdict === "diagnosis") throw new Error(`addToCart(${name}): could not click add`);
  } // else: already in cart (button is now Remove) — treat as done
  return cartCount(s).then((c) => (c === before && present ? before : c));
}

/** Go to the cart anchor and return the item names in it. */
export async function openCart(s: Session): Promise<string[]> {
  await s.click(".shopping_cart_link");
  await assertVisible(s, ".cart_list", "swag: cart anchor not reached");
  return s.evaluate<string[]>(() => [...document.querySelectorAll(".cart_item .inventory_item_name")].map((e) => (e.textContent ?? "").trim()));
}

export interface Order { total: string }

/** Complete checkout from the cart: checkout → fill info → continue → finish → order-complete anchor.
 *  Returns the order total (read off the summary). Assumes items are already in the cart. */
export async function checkout(s: Session, info: { firstName: string; lastName: string; zip: string }): Promise<Order> {
  // ensure we're in the cart
  if (!(await s.evaluate<boolean>(() => location.pathname.includes("/cart.html")).catch(() => false))) await openCart(s);
  await s.click(dt("checkout"));
  await assertVisible(s, dt("firstName"), "swag: checkout step-one not reached");
  await s.type(dt("firstName"), info.firstName);
  await s.type(dt("lastName"), info.lastName);
  await s.type(dt("postalCode"), info.zip);
  await s.click(dt("continue"));
  await assertVisible(s, ".summary_total_label", "swag: checkout step-two not reached");
  const total = await s.evaluate<string>(() => (document.querySelector(".summary_total_label")?.textContent ?? "").replace(/^Total:\s*/, "").trim());
  await s.click(dt("finish"));
  await assertComplete(s);
  return { total };
}
