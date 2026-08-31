// Live drift check for the gauntlet function library. Exports check(s) so the runner can drive it
// against a fresh session; also runs standalone against the current session. NOT a *.test.ts.
//   One-command form:  bun scripts/run-check.ts gauntlet     (the app must be up: `bun gauntlet`)
//
// WRITE FOOTPRINT: this check DOES write — the target is synthetic and local (stance: writes allowed).
// It issues POST /api/save (x2), DELETE /api/item/1, POST /api/graphql (one mutation), POST /api/login,
// and POST /ctl (scenario control, restored to the boot defaults in a finally block). It never touches
// anything outside localhost:4800/4801.
import { connect, type Session } from "../../src/client.ts";
import * as g from "./lib.ts";

export const target = { url: `${g.BASE}/`, scope: "localhost:4800" };
/** The pack's first anchor — section 1's button, which exists only on the app's own shell. */
export const ready = { selector: g.SHELL, visible: true };

/** The gauntlet's boot state, read from GET /ctl on a fresh server (run 1). Restored at the end so a
 *  check run leaves the app exactly as it found it. */
const BOOT = { slowMs: 400, renderDelayMs: 0, modal: false, modalDelayMs: 400, toastMs: 2000, saveFails: false,
  ambient: false, heartbeatMs: 5000, pollHoldMs: 3000, wsPushMs: 7000, timeoutMs: 0, rerenderOnHover: true,
  requireAuth: false, notifyPollHoldMs: 25000, notify: false };

export async function check(s: Session): Promise<boolean> {
  let failed = false; let last = Date.now();
  const ok = (label: string, cond: boolean, detail?: unknown) => {
    const now = Date.now(); const ms = now - last; last = now;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}  (${ms}ms)${detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 200) : ""}`);
    if (!cond) failed = true;
  };
  try {
    await g.registerRules(s);
    await g.setScenario(s, BOOT);
    await g.home(s);
    ok("home reaches the shell anchor", true);
    await g.home(s);
    ok("home is idempotent (no navigation when already on the shell)", true);

    // 1. Load Chart — wire-first, and the render that lags the wire
    const chart = await g.loadChart(s);
    ok("loadChart returns all three responses off the wire", chart.series.length === 2 && chart.series[0].points.length === 5 && chart.slowMs > 0,
      { a: chart.series[0], slowMs: chart.slowMs, status: chart.status });
    await g.setScenario(s, { renderDelayMs: 900 });
    const lagged = await g.loadChart(s);
    ok("loadChart survives renderDelayMs=900 (settlement lies, `until` does not)", lagged.status === "idle", { status: lagged.status });
    await g.setScenario(s, { renderDelayMs: 0 });

    // 2. Records — the conditional interstitial, BOTH ways
    const r1 = await g.openRecord(s, 1);
    ok("openRecord(1) with no modal armed (absent path)", r1.name === "Ada Lovelace" && !(await g.recordModalUp(s)), r1);
    await g.setScenario(s, { modal: true, modalDelayMs: 400 });
    const r2 = await g.openRecord(s, 2, { ack: false });
    const wasUp = await g.recordModalUp(s, 1500);   // it arrives ~400ms AFTER settlement — a 0 budget is too early
    ok("openRecord(2) with the modal armed: record read, overlay observed standing", r2.name === "Alan Turing" && wasUp, { rec: r2.name, modalUp: wasUp });
    const cleared = await g.dismissBlockers(s);
    ok("dismissBlockers clears the delayed overlay", cleared.includes("record-modal") && !(await g.recordModalUp(s)), cleared);
    const r3 = await g.openRecord(s, 3);
    ok("openRecord acks the modal itself and still returns the record", r3.id === 3 && !(await g.recordModalUp(s)), r3.name);
    await g.setScenario(s, { modal: false });

    // 8. The fact the DOM never shows
    const rows = await g.loadRows(s);
    const rendered = await g.renderedRowCount(s);
    ok("loadRows: 10,000 rows on the wire, ~23 in the DOM", rows.length === 10000 && rendered > 0 && rendered < 60,
      { onWire: rows.length, inDom: rendered, last: rows[rows.length - 1] });
    const deep = await g.findRow(s, rows[9999].name);
    ok(`findRow finds row 9999 (${rows[9999].name}) — unreachable by scraping`, deep?.id === 9999, deep);

    // 7 / 17 — debounced input and the keyboard-only combobox
    const found = await g.search(s, "ad");
    ok("search reads the debounced XHR body, and the debounce coalesced (q=ad, not q=a)",
      found.q === "ad" && found.hits.includes("Ada Lovelace"), { q: found.q, hits: found.hits.slice(0, 3) });
    const med = await g.selectMedication(s, "as", 2);
    ok("selectMedication drives the keyboard-only combobox (type/ArrowDown x2/Enter)", med === "Aspirin", { med });

    // 3 — optimistic UI: the wire is the truth
    const saved = await g.save(s);
    ok("save succeeds and is verified on the wire, not the toast", saved.ok && saved.statusCode === 200, saved);
    await g.setScenario(s, { saveFails: true });
    let threw = ""; let screenLie = "";
    try { await g.save(s); } catch (e) { threw = String(e); screenLie = (String(e).match(/screen reads "([^"]+)"/) ?? [])[1] ?? ""; }
    ok("save detects the async 500 that the screen never shows", threw.includes("-> 500") && screenLie.includes("Saved"), { screenLie, threw: threw.slice(0, 120) });
    await g.setScenario(s, { saveFails: false });

    // 14 / 20 — writes and the read-over-POST
    const del = await g.deleteItem(s, 1);
    ok("deleteItem writes and returns the receipt", del.deleted === 1, del);
    const q = await g.graphqlQuery(s);
    ok("graphqlQuery is a READ over POST (operation=query, sawMutation=false)", q.operation === "query" && q.sawMutation === false, q);
    const m = await g.graphqlMutate(s);
    ok("graphqlMutate is a WRITE over the same URL", m.operation === "mutation" && m.sawMutation === true, m);

    // 16 — canvas: no DOM, but wire-available
    const grid = await g.readCanvasGrid(s);
    ok("readCanvasGrid reads the canvas contents off /api/grid", grid.rows === 4 && grid.cols === 8 && grid.cells.length === 32,
      { rows: grid.rows, cols: grid.cols, cells: grid.cells.length });

    // 23 — a result delivered on a standing channel
    const pushed = await g.waitForPush(s, "ws");
    ok("waitForPush('ws'): the result arrives on the socket, not a response", /via ws/.test(pushed), { pushed });
    await g.setScenario(s, { notify: false });

    // 21 — auth, both ways
    await g.setScenario(s, { requireAuth: true });
    const a1 = await g.openSecureArea(s, "disco", "disco");
    ok("openSecureArea logs in through the 302 interstitial", a1.loggedIn && /disco/.test(a1.welcome), a1);
    const a2 = await g.openSecureArea(s);
    ok("openSecureArea is idempotent once the cookie is set (no login form)", a2.loggedIn === false, a2);
    await g.setScenario(s, { requireAuth: false });
    await g.home(s);
    ok("home recovers the shell from /secure.html", true);

    // 12 — session expiry, and recovery from it
    await g.setScenario(s, { timeoutMs: 1500 });
    const expired = await s.watch({ selector: g.EXPIRY_MODAL, visible: true }, { budgetMs: 9000 });
    ok("session expiry raises #session-timeout on its own timer", expired.matched, { elapsedMs: expired.elapsedMs });
    await g.setScenario(s, { timeoutMs: 0 });
    const cleared2 = await g.dismissBlockers(s);
    ok("dismissBlockers recovers from the expiry overlay", cleared2.includes("session-expiry"), cleared2);
    const after = await g.loadChart(s);
    ok("the app is driveable again after recovery", after.series.length === 2);
  } catch (e) {
    console.log(`FAIL  threw: ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
  } finally {
    try { await g.setScenario(s, BOOT); } catch { /* server may be gone */ }
  }
  return !failed;
}

if (import.meta.main) {
  const s = await connect("gauntlet");
  const passed = await check(s);
  s.close();
  process.exit(passed ? 0 : 1);
}
