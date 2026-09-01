// apps/saucedemo/check.ts — proves apps/saucedemo/lib.ts still drives Swag Labs.
// Run from the repo root:  node scripts/run-check.ts saucedemo
import { type Session } from "../../src/index.ts";
import * as sd from "./lib.ts";

export const target = { url: "https://www.saucedemo.com/" };

const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const ok = (cond: unknown, what: string) => { if (!cond) throw new Error(what); };

export async function check(s: Session, step: (name: string, fn: () => unknown) => Promise<unknown>) {

  await step("login page lists the six accounts", async () => {
    await sd.reachLogin(s);
    const shown = await s.evaluate(`document.querySelector("[data-test='login-credentials']").textContent`) as string;
    for (const u of sd.USERS) ok(shown.includes(u), `login page does not advertise ${u}`);
    eq(await sd.sessionUser(s), null, "logged out");
  });

  await step("standard_user: login is client-side, cookie only, zero API calls", async () => {
    const r = await sd.loginOk(s, "standard_user");
    eq(await sd.sessionUser(s), "standard_user", "session cookie");
    const app = s.store.requests({ action: r.act }).filter((q) => q.host === "www.saucedemo.com" && ["xhr", "fetch"].includes(q.resource_type));
    eq(app.length, 0, "first-party XHR/fetch during login");
  });

  await step("catalogue: 6 products, canonical names and prices", async () => {
    const p = await sd.products(s);
    eq(p.map((x) => x.name).sort(), sd.CATALOG.map((c) => c.name).sort(), "product names");
    const priced = Object.fromEntries(p.map((x) => [x.name, x.price]));
    for (const c of sd.CATALOG) eq(priced[c.name], `$${c.price}`, `${c.name} price`);
    ok(p.every((x) => !x.img.startsWith("sl-404")), "standard_user images are real");
  });

  await step("sorting reorders the list (all four options)", async () => {
    const hilo = await sd.sortBy(s, "hilo");
    eq(hilo.applied, true, "hilo applied");
    eq(hilo.names[0], "Sauce Labs Fleece Jacket", "hilo first");
    eq((await sd.sortBy(s, "lohi")).names[0], "Sauce Labs Onesie", "lohi first");
    eq((await sd.sortBy(s, "za")).names[0], "Test.allTheThings() T-Shirt (Red)", "za first");
    eq((await sd.sortBy(s, "az")).names[0], "Sauce Labs Backpack", "az first");
  });

  await step("item detail page: /inventory-item.html?id=4 and its slug-less add button", async () => {
    const it = await sd.openItem(s, 4);
    ok(it.url.endsWith("/inventory-item.html?id=4"), `item url ${it.url}`);
    eq(it.name, "Sauce Labs Backpack", "item name");
    eq(it.price, "$29.99", "item price");
    eq(it.btn, "add-to-cart", "detail button data-test");
    eq((await sd.addToCartFromItem(s)).cart, [4], "cart after add from detail page");
    await sd.backToProducts(s);
  });

  await step("cart holds what the inventory added; remove takes it back out", async () => {
    eq((await sd.addToCart(s, 2)).cart, [4, 2], "cart after adding the onesie");
    const lines = await sd.openCart(s);
    eq(lines.map((l) => l.name), ["Sauce Labs Backpack", "Sauce Labs Onesie"], "cart lines");
    eq(lines.map((l) => l.qty), ["1", "1"], "quantities are always 1");
    eq((await sd.removeFromCart(s, 2)).cart, [4], "cart after remove");
  });

  await step("checkout: validation, 8% tax, completion clears the cart", async () => {
    await sd.startCheckout(s);
    const blank = await sd.submitCheckoutInfo(s, { firstName: "", lastName: "", postalCode: "" });
    eq(blank.which, "error", "empty form is refused");
    eq(blank.error, "Error: First Name is required", "first error");
    const good = await sd.submitCheckoutInfo(s, { firstName: "Ada", lastName: "Lovelace", postalCode: "12345" });
    eq(good.which, "stepTwo", "step two reached");
    const m = await sd.overview(s);
    eq(m.payment, "SauceCard #31337", "payment line");
    eq(m.shipping, "Free Pony Express Delivery!", "shipping line");
    eq([m.subtotalN, m.taxN, m.totalN], [29.99, 2.40, 32.39], "subtotal/tax/total");
    eq(Math.round(m.subtotalN * 0.08 * 100) / 100, m.taxN, "tax is 8% of the item total");
    const done = await sd.finishOrder(s);
    ok(done.completed, `finish did not complete (${done.url}) ${JSON.stringify(done.console)}`);
    eq(done.cart, [], "cart cleared by the order");
  });

  await step("Generate PDF order: the only evidence is the lazy chunk on the wire", async () => {
    const r = await sd.generatePdf(s);
    ok(r.fetched, "react-pdf chunk never landed");
    ok(r.chunks.some((p) => p.includes("OrderReceipt")), `no OrderReceipt chunk: ${JSON.stringify(r.chunks)}`);
    await sd.backHome(s);
  });

  await step("Reset App State empties the cart; Logout keeps it", async () => {
    await sd.addToCart(s, 0);
    eq(await sd.resetAppState(s), [], "cart after reset");
    eq((await sd.addToCart(s, 1)).cart, [1], "cart refilled");
    const out = await sd.signOut(s);
    eq(out.user, null, "cookie cleared by logout");
    eq(out.cart, [1], "cart SURVIVES logout (it is localStorage, not the session)");
  });

  await step("deep links are guarded client-side", async () => {
    const g = await sd.deepLinkGuard(s, "/inventory.html");
    eq(g.url, "https://www.saucedemo.com/", "bounced to the login page");
    eq(g.error, "Epic sadface: You can only access '/inventory.html' when you are logged in.", "guard banner");
    const c = await sd.deepLinkGuard(s, "/cart.html");
    eq(c.error, "Epic sadface: You can only access '/cart.html' when you are logged in.", "cart guard banner");
  });

  await step("locked_out_user is refused, and the refusal is reported to Backtrace", async () => {
    const msg = await sd.loginRefused(s, "locked_out_user");
    eq(msg, "Epic sadface: Sorry, this user has been locked out.", "lockout banner");
    const crash = s.store.requests({ url: "submit.backtrace.io" }).at(-1);
    ok(crash, "no Backtrace crash report was sent");
    ok((crash!.req_body || "").includes("Locked out user tried to log in."),
       "crash report does not carry the locked-out message");
  });

  await step("a wrong password is refused", async () => {
    eq(await sd.loginRefused(s, "standard_user", "nope"),
       "Epic sadface: Username and password do not match any user in this service", "bad password banner");
  });

  await step("performance_glitch_user: login blocks the main thread >3 s", async () => {
    await sd.reachLogin(s);
    const r = await sd.login(s, "performance_glitch_user");
    eq(r.which, "inventory", "slow login still lands");
    ok(r.ms > 3000, `expected the documented ~5 s stall, got ${r.ms} ms`);
    eq((await sd.products(s)).length, 6, "catalogue renders normally afterwards");
  });

  await step("problem_user: 404 images, dead sort, odd ids never reach the cart", async () => {
    await sd.loginOk(s, "problem_user");
    const p = await sd.products(s);
    ok(p.every((x) => x.img.startsWith("sl-404")), "every image should be the 404 placeholder");
    const dead = await sd.sortBy(s, "za");
    eq(dead.applied, false, "the sort <select> reverts: nothing is applied");
    eq(dead.names[0], "Sauce Labs Backpack", "and the list never reorders");
    eq((await sd.addToCart(s, 0)).added, true, "even id 0 adds");
    eq((await sd.addToCart(s, 1)).added, false, "odd id 1 silently fails");
    eq((await sd.addToCart(s, 3)).added, false, "odd id 3 silently fails");
    eq(await sd.cartIds(s), [0], "only the even id made it");
  });

  await step("problem_user: Last Name types into First Name, so checkout is impossible", async () => {
    await sd.openCart(s);
    await sd.startCheckout(s);
    const r = await sd.submitCheckoutInfo(s, { firstName: "Ada", lastName: "Lovelace", postalCode: "12345" });
    eq(r.values, { firstName: "Lovelace", lastName: "", postalCode: "12345" }, "Last Name writes into First Name");
    eq(r.which, "error", "step one is refused");
    eq(r.error, "Error: Last Name is required", "and it blames the field it stole from");
  });

  await step("error_user: add fails loudly, Finish throws and shows nothing", async () => {
    await sd.loginOk(s, "error_user");
    const bad = await sd.addToCart(s, 1);
    eq(bad.added, false, "odd id fails for error_user too");
    ok(JSON.stringify(bad.console).includes("Failed to add item to the cart"),
       `expected a console exception, got ${JSON.stringify(bad.console)}`);
    eq((await sd.addToCart(s, 4)).added, true, "even id still works");
    await sd.openCart(s);
    await sd.startCheckout(s);
    const step1 = await sd.submitCheckoutInfo(s, { firstName: "Ada", lastName: "Lovelace", postalCode: "12345" });
    eq(step1.values.lastName, "", "the Last Name box never shows what it holds");
    eq(step1.which, "stepTwo", "…but the state behind it is set, so step two is reached");
    const done = await sd.finishOrder(s);
    eq(done.completed, false, "Finish must NOT complete for error_user");
    ok(s.page.url().includes("checkout-step-two"), `still on step two, got ${s.page.url()}`);
    eq(await sd.errorText(s), null, "and the screen says nothing at all");
    ok(JSON.stringify(done.console).includes("is not a function"),
       `the only evidence is the console exception, got ${JSON.stringify(done.console)}`);
  });

  await step("visual_user: 404 backpack image and prices randomised per render", async () => {
    await sd.loginOk(s, "visual_user");
    const a = await sd.products(s);
    eq(a.find((x) => x.name === "Sauce Labs Backpack")!.img.startsWith("sl-404"), true, "backpack image is the 404 placeholder");
    eq(a.filter((x) => x.img.startsWith("sl-404")).length, 1, "only the backpack image is swapped");
    const canonical = Object.fromEntries(sd.CATALOG.map((c) => [c.name, `$${c.price}`]));
    ok(a.some((x) => x.price !== canonical[x.name]), `prices should not be canonical: ${JSON.stringify(a.map((x) => x.price))}`);
    await sd.loginOk(s, "visual_user");
    const b = await sd.products(s);
    ok(JSON.stringify(a.map((x) => x.price)) !== JSON.stringify(b.map((x) => x.price)),
       `prices should differ between renders: ${JSON.stringify(b.map((x) => x.price))}`);
    await sd.reachLogin(s);
  });
}
