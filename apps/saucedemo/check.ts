// Live drift check for the Sauce Labs demo library. Exports check(s); standalone via DISCO_SESSION.
//   bun scripts/run-check.ts saucedemo
import { connect, type Session } from "../../src/client.ts";
import * as swag from "./lib.ts";

/** Where run-check points the browser and what host it scopes the session to. */
export const target = { url: swag.BASE, scope: "saucedemo.com" };

export async function check(s: Session): Promise<boolean> {
  let failed = false; let last = Date.now();
  const ok = (label: string, cond: boolean, detail?: unknown) => { const now = Date.now(); const ms = now - last; last = now; // elapsed since the previous line = this step
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}  (${ms}ms)${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); if (!cond) failed = true; };
  try {
    await swag.login(s);
    ok("login reaches inventory", true);
    const products = await swag.listProducts(s);
    ok("catalog reads from the DOM", products.length === 6, { count: products.length });
    const c = await swag.addToCart(s, "Sauce Labs Backpack");
    ok("addToCart bumps the badge", c >= 1, { cart: c });
    const cart = await swag.openCart(s);
    ok("cart contains the item", cart.includes("Sauce Labs Backpack"), cart);
    const order = await swag.checkout(s, { firstName: "Ada", lastName: "Lovelace", zip: "90210" });
    ok("checkout completes with a total", /^\$/.test(order.total), order);
  } catch (e) {
    console.log("FAIL  threw:", (e as Error).message); failed = true;
  }
  console.log(failed ? "\nCHECK FAILED" : "\nCHECK OK");
  return !failed;
}

if (import.meta.main) {
  const s = await connect(process.env.DISCO_APP ?? "saucedemo");
  const passed = await check(s).finally(() => s.close());
  process.exit(passed ? 0 : 1);
}
