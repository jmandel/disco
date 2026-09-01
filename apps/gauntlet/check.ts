// apps/gauntlet/check.ts
// Proves lib.ts still drives the gauntlet. Run from the repo root:
//   node scripts/run-check.ts gauntlet   (add --headed to watch, --close to kill the browser)
//
// Each step resets the relevant ctl knobs first so the check is order-independent
// and leaves the app at defaults.

import { reached } from "../../src/index.ts";
import {
  HOME,
  resetCtl,
  setCtl,
  goHome,
  loadChart,
  openRecord,
  ackModalIfPresent,
  save,
  search,
  loadRows,
  scrollRowsTo,
  pickMed,
  gqlQuery,
  gqlMutate,
  enterSecure,
  clickRerender,
  deleteItem,
  notifyVia,
} from "./lib.ts";

export const target = { url: HOME };

export async function check(s: any, step: any) {
  await step("shell reachable", async () => {
    await goHome(s);
    await resetCtl(s);
  });

  await step("load chart (3 concurrent, one slow)", async () => {
    const { slow } = await loadChart(s);
    if (!slow || typeof slow.ms !== "number") throw new Error("no slow-fetch body on the wire");
  });

  await step("open record 1 (wire body)", async () => {
    const { record } = await openRecord(s, 1);
    if (!record || record.name !== "Ada Lovelace") throw new Error(`record 1 wrong: ${JSON.stringify(record)}`);
  });

  await step("conditional allergy modal", async () => {
    await setCtl(s, { modal: true });
    const { hasModal } = await openRecord(s, 3);
    if (!hasModal) throw new Error("expected allergy modal with ctl.modal=true");
    if (!(await ackModalIfPresent(s))) throw new Error("modal did not acknowledge");
    await setCtl(s, { modal: false });
  });

  await step("save: async success toast", async () => {
    await setCtl(s, { saveFails: false });
    const { outcome } = await save(s);
    if (outcome !== "ok") throw new Error(`expected ok toast, got ${outcome}`);
  });

  await step("save: async failure toast", async () => {
    await setCtl(s, { saveFails: true });
    const { outcome } = await save(s);
    if (outcome !== "fail") throw new Error(`expected fail toast, got ${outcome}`);
    await setCtl(s, { saveFails: false });
  });

  await step("debounced search", async () => {
    const { hits } = await search(s, "ali");
    if (!hits.includes("Silvio Micali")) throw new Error(`search hits wrong: ${JSON.stringify(hits)}`);
  });

  await step("virtualized rows (10000 total, few mounted)", async () => {
    const { total, mounted } = await loadRows(s);
    if (total !== 10000) throw new Error(`expected 10000 rows, got ${total}`);
    if (mounted < 1 || mounted > 60) throw new Error(`expected a small mounted window, got ${mounted}`);
    const { firstId } = await scrollRowsTo(s, 5000);
    if (Number(firstId) < 100) throw new Error(`scroll did not re-virtualize (firstId ${firstId})`);
  });

  await step("keyboard-only combobox", async () => {
    const { selected } = await pickMed(s, "as");
    if (!/Atorvastatin/.test(selected)) throw new Error(`combobox selection wrong: ${selected}`);
  });

  await step("graphql query + mutation", async () => {
    const q = (await gqlQuery(s)).body as any;
    if (q?.operation !== "query" || q?.data?.patient?.name !== "Ada Lovelace") throw new Error(`gql query wrong: ${JSON.stringify(q)}`);
    const m = (await gqlMutate(s)).body as any;
    if (m?.operation !== "mutation" || m?.sawMutation !== true) throw new Error(`gql mutation wrong: ${JSON.stringify(m)}`);
  });

  await step("re-render race (programmatic click lands)", async () => {
    await setCtl(s, { rerenderOnHover: true });
    const count = await clickRerender(s);
    if (count < 1) throw new Error("rerender click not counted");
  });

  await step("delete (write endpoint)", async () => {
    const { body } = await deleteItem(s);
    if ((body as any)?.deleted !== 1) throw new Error(`delete wrong: ${JSON.stringify(body)}`);
  });

  await step("push channels ws/sse/poll", async () => {
    for (const via of ["ws", "sse", "poll"] as const) {
      const { last } = await notifyVia(s, via);
      if (!last || !last.includes(`via ${via}`)) throw new Error(`notify ${via} wrong: ${last}`);
    }
    await setCtl(s, { notify: false });
  });

  await step("auth: login lands on secure area", async () => {
    await setCtl(s, { requireAuth: true });
    await s.context.clearCookies();
    const greeting = await enterSecure(s, "admin", "hunter2");
    if (!/Welcome, admin/.test(greeting)) throw new Error(`secure greeting wrong: ${greeting}`);
    await setCtl(s, { requireAuth: false });
    reached(await goHome(s));
  });

  await step("leave app at defaults", async () => {
    await resetCtl(s);
  });
}
