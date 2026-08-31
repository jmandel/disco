// Live drift check for the saucedemo pack — the same shape as the gauntlet/openemr checks, so
// `bun scripts/run-check.ts saucedemo` stands up a fresh headless browser + scoped session and runs it.
// Steps: the full purchase flow as standard_user, the refusal path as locked_out_user, and login +
// addToCart as performance_glitch_user (override with DISCO_SWAG_USER=<user>; the glitch user's login
// takes ~5s — ledger #3). Prints PASS/FAIL per step with the elapsed ms of that step.
//   bun apps/saucedemo/check.ts            # against the current `saucedemo` session (apps/.current)
//   bun scripts/run-check.ts saucedemo     # self-contained
import { connect, type Session } from "../../src/client.ts";
import * as swag from "./lib.ts";

export const target = { url: "https://www.saucedemo.com/", scope: "saucedemo.com" };

export async function check(s: Session): Promise<boolean> {
  let failed = false; let last = Date.now();
  const ok = (label: string, cond: boolean, detail?: unknown) => { const now = Date.now(); const ms = now - last; last = now; // elapsed since the previous line = this step
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}  (${ms}ms)${detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 220) : ""}`); if (!cond) failed = true; };
  const slowUser = process.env.DISCO_SWAG_USER ?? swag.USERS.glitch;
  const info = { firstName: "Ada", lastName: "Lovelace", zip: "12345" };
  try {
    // --- the full purchase flow, standard_user
    const l1 = await swag.login(s, { user: swag.USERS.standard });
    ok("login(standard_user) reaches the inventory", !l1.alreadyLoggedIn && (await swag.state(s)).inventory, l1);
    const l1b = await swag.login(s, { user: swag.USERS.standard });
    ok("login is idempotent (second call is a no-op)", l1b.alreadyLoggedIn === true, l1b);
    // The cart is global client state that survives logout AND a different user's login (ledger #10), so a
    // stale cart is optional-both-ways: clear it if present, do nothing if absent.
    const stale = (await swag.state(s)).badge;
    if (stale !== null) await swag.resetAppState(s);
    ok(`cart starts empty (stale cart ${stale === null ? "absent" : `of ${stale} reset`})`, (await swag.state(s)).badge === null);
    const products = await swag.listProducts(s);
    ok("listProducts returns the 6 catalogue items with prices", products.length === 6 && products.every((p) => p.price > 0), products.map((p) => `${p.name} $${p.price}`));
    const a1 = await swag.addToCart(s, "Sauce Labs Backpack");
    ok("addToCart(Backpack) flips the button and the badge reads 1", a1.badge === 1 && !a1.already, a1);
    const a2 = await swag.addToCart(s, "Sauce Labs Bike Light");
    ok("addToCart(Bike Light) → badge 2", a2.badge === 2, a2);
    const a3 = await swag.addToCart(s, "Sauce Labs Backpack");
    ok("addToCart is idempotent (already in cart → no click)", a3.already === true && (await swag.state(s)).badge === 2, a3);
    const cart = await swag.openCart(s);
    ok("openCart lists both lines", cart.length === 2 && cart.map((c) => c.name).sort().join("|") === "Sauce Labs Backpack|Sauce Labs Bike Light", cart);
    const subtotal = Math.round(cart.reduce((sum, c) => sum + c.price * c.qty, 0) * 100) / 100;
    const r = await swag.checkout(s, info);
    const taxOk = Math.abs(r.tax - Math.round(subtotal * 8) / 100) < 0.011; // 8% (ledger #9)
    ok("checkout reaches 'Thank you for your order!' with subtotal + 8% tax = total", /thank you/i.test(r.completeHeader) && r.subtotal === subtotal && taxOk && Math.abs(r.total - (r.subtotal + r.tax)) < 0.011, r);
    await swag.backHome(s);
    ok("backHome returns to the inventory with an empty cart", (await swag.state(s)).inventory && (await swag.state(s)).badge === null);
    await swag.logout(s);
    ok("logout clears the session cookie and shows the login form", (await swag.state(s)).user === null && (await swag.state(s)).loginForm);

    // --- the refusal path: locked_out_user must throw the app's own banner text
    let refused = "";
    try { await swag.login(s, { user: swag.USERS.locked }); } catch (e) { refused = (e as Error).message; }
    ok("login(locked_out_user) throws the app's 'locked out' text", /locked out/i.test(refused), refused.slice(0, 160));

    // --- the slow user: login + addToCart (DISCO_SWAG_USER overrides which user)
    const l2 = await swag.login(s, { user: slowUser });
    ok(`login(${slowUser}) reaches the inventory (until ${l2.untilMs}ms, verdict ${l2.verdict})`, (await swag.state(s)).inventory && (await swag.state(s)).user === slowUser, l2);
    const a4 = await swag.addToCart(s, "Sauce Labs Onesie");
    ok(`addToCart(Onesie) as ${slowUser} → badge 1`, a4.badge === 1, a4);
    await swag.logout(s);
    ok("logout after the slow user", (await swag.state(s)).loginForm);
  } catch (e) { console.log("FAIL  threw:", (e as Error).message); failed = true; }
  console.log(failed ? "\nCHECK FAILED" : "\nCHECK OK");
  return !failed;
}

if (import.meta.main) {
  const s = await connect(process.env.DISCO_APP ?? "saucedemo");
  const passed = await check(s).finally(() => s.close());
  process.exit(passed ? 0 : 1);
}
