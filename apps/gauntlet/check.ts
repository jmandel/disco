// apps/gauntlet/check.ts
// Proves lib.ts still drives the gauntlet. Run from the repo root:
//   node scripts/run-check.ts gauntlet         (add --headed to watch, --close to kill the browser)
import { reached, type Session } from "../../src/index.ts";
import type { Step } from "../../scripts/run-check.ts";
import {
  resetCtl,
  gotoShell,
  loadChart,
  openRecord,
  save,
  setCtl,
  search,
  loadRows,
  clickRerender,
  submitIframe,
  submitNestedIframe,
  submitCrossIframe,
  selectGridCell,
  pickMed,
  clickShadowButton,
  runSse,
  gqlQuery,
  gqlMutate,
  login,
  pushNotification,
  contextMenuAction,
  editInline,
  dragSlider,
  reorder,
  deleteItem,
} from "./lib.ts";

export const target = { url: "http://localhost:4800" };

export async function check(s: Session, step: Step) {
  // Deterministic starting point: default knobs + a fresh page (so the WS opens
  // inside our recording window).
  await step("reset ctl + reach shell", async () => {
    await resetCtl(s);
    await gotoShell(s);
  });

  await step("load chart (slow race)", async () => {
    const { slowMs } = await loadChart(s);
    if (slowMs <= 0) throw new Error("no slow response on the wire");
  });

  await step("open record 3 (no modal)", async () => {
    const r = await openRecord(s, 3);
    if (!r?.name) throw new Error("record has no name");
  });

  await step("open record 2 WITH conditional modal", async () => {
    await setCtl(s, { modal: true, modalDelayMs: 0 });
    const r = await openRecord(s, 2); // openRecord dismisses the modal
    await setCtl(s, { modal: false });
    if (!Array.isArray(r.allergies) || r.allergies.length === 0)
      throw new Error("expected allergies on record 2");
  });

  await step("save: async success", async () => {
    await setCtl(s, { saveFails: false });
    const { ok, status } = await save(s);
    if (!ok) throw new Error(`expected 200, got ${status}`);
  });

  await step("save: async failure toast", async () => {
    await setCtl(s, { saveFails: true });
    const { ok, status } = await save(s);
    await setCtl(s, { saveFails: false });
    if (ok || status !== 500) throw new Error(`expected 500, got ${status}`);
  });

  await step("debounced search", async () => {
    const hits = await search(s, "ada");
    if (!hits.some((h) => /Ada/i.test(h))) throw new Error("Ada not in hits: " + JSON.stringify(hits));
  });

  await step("virtualized rows (wire vs DOM)", async () => {
    const { total, mounted } = await loadRows(s);
    if (total !== 10000) throw new Error(`expected 10000 rows, got ${total}`);
    if (mounted >= 100) throw new Error(`expected a windowed DOM, got ${mounted} nodes`);
  });

  await step("re-render race", async () => {
    const n = await clickRerender(s);
    if (n < 1) throw new Error("rerender not counted");
  });

  await step("iframes: same / nested / cross", async () => {
    const a = await submitIframe(s, "Ada");
    if (a?.name !== "Ada") throw new Error("same-origin submit failed");
    const b = await submitNestedIframe(s, "Deep");
    if (b?.name !== "Deep") throw new Error("nested submit failed");
    const c = await submitCrossIframe(s, "Cross");
    if (c?.name !== "Cross") throw new Error("cross-origin submit failed");
  });

  await step("canvas grid select", async () => {
    const cell = await selectGridCell(s);
    if (!cell || typeof cell.r !== "number") throw new Error("no grid cell selected");
  });

  await step("keyboard combobox", async () => {
    const med = await pickMed(s, "as", 0);
    if (!med) throw new Error("no med selected");
  });

  await step("shadow DOM click", async () => {
    const n = await clickShadowButton(s);
    if (n < 1) throw new Error("shadow click not counted");
  });

  await step("SSE stream (5 events)", async () => {
    const events = await runSse(s);
    if (events.length !== 5) throw new Error(`expected 5 SSE events, got ${events.length}`);
  });

  await step("GraphQL query + mutation", async () => {
    const q = await gqlQuery(s);
    if (q?.data?.patient?.name !== "Ada Lovelace") throw new Error("gql query wrong");
    const m = await gqlMutate(s);
    if (m?.sawMutation !== true) throw new Error("gql mutation not recognised");
  });

  await step("push channels ws/sse/poll", async () => {
    for (const ch of ["ws", "sse", "poll"] as const) {
      const text = await pushNotification(s, ch);
      if (!text.includes(ch)) throw new Error(`push ${ch} not delivered (got "${text}")`);
    }
  });

  await step("context menu", async () => {
    const r = await contextMenuAction(s, "Rename");
    if (!/Rename/.test(r)) throw new Error("ctx result wrong: " + r);
  });

  await step("double-click to edit", async () => {
    const st = await editInline(s, "New value");
    if (!st.includes("New value")) throw new Error("inline edit not committed: " + st);
  });

  await step("drag slider + reorder", async () => {
    const v = await dragSlider(s);
    if (v <= 0) throw new Error("slider did not move");
    const order = await reorder(s, "#sort-a", "#sort-c");
    if (order === "a,b,c") throw new Error("order unchanged");
  });

  await step("delete (write endpoint)", async () => {
    const n = await deleteItem(s);
    if (n !== 1) throw new Error("delete result wrong: " + n);
  });

  await step("auth: login sets cookie + secure area", async () => {
    await login(s, "ada", "whatever", "/secure.html");
    const who = String(await s.evaluate(`document.getElementById('who')?.textContent`));
    if (!/ada/.test(who)) throw new Error("secure area not reached: " + who);
    const cookies = await s.context.cookies();
    if (!cookies.some((c) => c.name === "gauntlet_auth")) throw new Error("no auth cookie");
    // back to the shell for a clean exit
    reached(await s.navigate("http://localhost:4800/", { until: { selector: "#load-chart" } }), "home");
  });
}
