// apps/gauntlet/check.ts — proves apps/gauntlet/lib.ts still drives the app.
// Run from the repo root:  node scripts/run-check.ts gauntlet
// Requires the gauntlet on :4800  (bun gauntlet/server.ts --port 4800)
import * as g from "./lib.ts";

export const target = { url: "http://localhost:4800" };

export async function check(s: any, step: any) {
  await step("reset knobs + reach the shell", async () => {
    await g.resetCtl(s);
    await g.logout(s);
    await g.atShell(s, { reload: true });
  });

  await step("1. load chart (3 concurrent, one slow)", async () => {
    const c = await g.loadChart(s);
    if (c.responses !== 3) throw new Error("expected 3 responses, got " + c.responses);
    if (c.a.length !== 5 || c.b.length !== 5) throw new Error("chart series are not 5 points");
  });

  await step("2. open a record (wire-first)", async () => {
    const r = await g.openRecord(s, 2);
    if (r.name !== "Alan Turing" || r.mrn !== "MRN-0002") throw new Error("wrong record: " + JSON.stringify(r));
  });

  await step("2b. the allergy modal, delayed", async () => {
    await g.ctl(s, { modal: true, modalDelayMs: 400 });
    const r = await g.openRecord(s, 4);          // sweeps the late modal
    if (r.name !== "Edsger Dijkstra") throw new Error("wrong record: " + JSON.stringify(r));
    if (await s.evaluate("document.querySelectorAll('#record-modal').length")) throw new Error("modal still up");
    await g.ctl(s, { modal: false, modalDelayMs: 0 });
  });

  await step("3. save succeeds (truth from the wire, not the screen)", async () => {
    const ok = await g.save(s);
    if (!ok.ok || ok.status !== 200) throw new Error("expected 200, got " + ok.status);
    if (String(await s.evaluate("document.getElementById('save-state').textContent")) !== "Saved ✓")
      throw new Error("optimistic state missing");
  });

  await step("3b. save fails, screen still says Saved ✓", async () => {
    await g.ctl(s, { saveFails: true });
    const bad = await g.save(s);
    await g.ctl(s, { saveFails: false });
    if (bad.ok || bad.status !== 500) throw new Error("expected 500, got " + bad.status);
    if (!bad.toast.includes("Save failed")) throw new Error("no failure toast: " + bad.toast);
    if (String(await s.evaluate("document.getElementById('save-state').textContent")) !== "Saved ✓")
      throw new Error("the optimistic lie changed — re-characterise section 3");
  });

  await step("4. the spinner never resolves", async () => {
    if (!(await g.spinnerNeverResolves(s, 900))) throw new Error("#spinner disappeared — it used not to");
  });

  await step("6. a click sends a WebSocket action frame", async () => {
    const f = await g.wsActionFrame(s, "delete", "/api/item/");
    if (!f || f.type !== "action" || f.id !== "delete") throw new Error("no action frame: " + JSON.stringify(f));
  });

  await step("7. debounced search", async () => {
    const hits = await g.search(s, "ada");
    if (hits.join() !== "Ada Lovelace") throw new Error("hits: " + hits.join());
  });

  await step("8. virtualised rows (10 000, read off the wire)", async () => {
    const { total } = await g.loadRows(s);
    if (total !== 10000) throw new Error("expected 10000 rows, got " + total);
    const t = await g.scrollRowsTo(s, 5000);
    if (t !== "Cheetah-Row-5000") throw new Error("row 5000 is " + t);
  });

  await step("9. re-render race needs js:true", async () => {
    const n = await g.clickRerender(s);
    if (n < 1) throw new Error("no click counted");
  });

  await step("10. same-origin, nested and cross-origin frames", async () => {
    if ((await g.iframeSubmit(s, "Grace")) !== "Grace") throw new Error("same-origin submit failed");
    if ((await g.deepIframeSubmit(s, "Depth")) !== "Depth") throw new Error("depth-2 submit failed");
    const x = await g.xframeSubmit(s, "Kate");
    if (x.origin !== "x") throw new Error("cross-origin submit did not reach :4801: " + JSON.stringify(x));
  });

  await step("11. native dialogs (alert, confirm, beforeunload)", async () => {
    await g.nativeAlert(s);
    const c = await g.nativeConfirm(s);
    if (c !== "confirmed") throw new Error("confirm was " + c + " (session is dialogs:accept)");
    const which = await g.armAndNavigateAway(s);
    if (which !== "left") throw new Error("beforeunload did not let us leave: " + which);
  });

  await step("12. session timeout dialog + stay signed in", async () => {
    const ms = await g.sessionTimeoutAndStay(s, 1200);
    if (ms < 0) throw new Error("dialog never appeared");
  });

  await step("14. delete (write endpoint)", async () => {
    if ((await g.deleteItem(s, 1)) !== 1) throw new Error("delete did not report id 1");
  });

  await step("15. child window (opens, fetches, closes)", async () => {
    if ((await g.openChildAndPing(s)) !== "pong") throw new Error("child fetch did not return pong");
  });

  await step("16. canvas cell (pixels only)", async () => {
    const c = await g.selectGridCell(s, 1, 2);
    if (c.pixel.slice(0, 3).join() !== "255,213,79") throw new Error("cell not highlighted: " + c.pixel.join());
  });

  await step("17. keyboard-only combobox", async () => {
    const sel = await g.pickMedication(s, "as", "Aspirin");
    if (!sel.includes("Aspirin")) throw new Error("selected: " + sel);
  });

  await step("18. shadow DOM", async () => {
    if ((await g.clickShadowButton(s)) < 1) throw new Error("shadow click not counted");
  });

  await step("19. SSE: 5 events then done", async () => {
    const ev = await g.runSse(s);
    if (ev.length !== 5) throw new Error("expected 5 SSE events, got " + ev.length);
  });

  await step("20. GraphQL query and mutation over one POST path", async () => {
    const q = await g.graphql(s, "query");
    if (q.sawMutation !== false || q.data.patient.name !== "Ada Lovelace") throw new Error(JSON.stringify(q));
    const m = await g.graphql(s, "mutation");
    if (m.sawMutation !== true || m.data.rename.name !== "Renamed") throw new Error(JSON.stringify(m));
  });

  await step("21. auth: every page 302s to login, any credentials work", async () => {
    await g.ctl(s, { requireAuth: true });
    await g.logout(s);
    const who = await g.reachSecureArea(s, "demo", "s3cret");
    if (who !== "Welcome, demo") throw new Error("secure page says " + who);
    const cookie = (await s.context.cookies()).find((c: any) => c.name === "gauntlet_auth");
    if (!cookie || cookie.value !== "demo") throw new Error("no gauntlet_auth cookie");
    await g.ctl(s, { requireAuth: false });
    await g.atShell(s, { reload: true });
  });

  await step("23. push over ws and sse", async () => {
    const a = await g.push(s, "ws");
    if (!a.includes("via ws")) throw new Error("ws push: " + a);
    const b = await g.push(s, "sse");
    if (!b.includes("via sse")) throw new Error("sse push: " + b);
  });

  await step("23b. push over the long-poll channel (needs ctl.notify)", async () => {
    await g.enablePollChannel(s, 4000);
    const c = await g.push(s, "poll", 10000);
    if (!c.includes("via poll")) throw new Error("poll push: " + c);
    await g.ctlAndReload(s, { notify: false });
  });

  await step("24. context menu", async () => {
    const r = await g.contextMenuPick(s, "rename");
    if (r !== "ctx: Rename") throw new Error("ctx-result: " + r);
  });

  await step("25. double-click to edit", async () => {
    const v = await g.editValue(s, "Edited by disco");
    if (v !== "Edited by disco") throw new Error("committed value: " + v);
  });

  await step("26. slider and list reorder (raw mouse)", async () => {
    const v = await g.setSlider(s, 0.75);
    if (v < 60 || v > 90) throw new Error("slider landed on " + v);
    const order = await g.moveItemToEnd(s, "sort-a");
    if (!order.endsWith("a")) throw new Error("order: " + order);
  });

  await step("28. fake stream (event-stream mime, ordinary body)", async () => {
    const f = await g.loadFakeStream(s);
    if (f.chars !== 97 || !f.body.includes("<envelope>")) throw new Error("fake stream: " + JSON.stringify(f));
  });

  await step("5/22. ambient traffic (heartbeat + long poll)", async () => {
    const a = await g.runAmbient(s);
    if (a.heartbeats < 2 || a.polls < 2) throw new Error("ambient counters: " + JSON.stringify(a));
  });

  await step("reset", async () => {
    await g.resetCtl(s);
    await g.atShell(s, { reload: true });
  });
}
