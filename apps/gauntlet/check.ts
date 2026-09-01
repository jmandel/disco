// apps/gauntlet/check.ts — proves apps/gauntlet/lib.ts still drives the app.
// Run from the repo root:  node scripts/run-check.ts gauntlet
import { type Session } from "../../src/index.ts";
import * as g from "./lib.ts";

export const target = { url: "http://localhost:4800" };

const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

export async function check(s: Session, step: (name: string, fn: () => unknown) => Promise<unknown>) {
  await step("reset knobs and reach the shell", async () => {
    await g.goHome(s);
    const c = await g.ctlReset(s);
    eq(c.modal, false, "ctl.modal after reset");
    await g.goHome(s);
  });

  await step("1 chart: 3 concurrent fetches, status lies", async () => {
    const r = await g.loadChart(s);
    if (!r.text.includes("Chart loaded (3 responses)")) throw new Error(`chart text ${r.text}`);
    eq(r.series.map((x: any) => x.series), ["a", "b"], "series");
    const status = await s.evaluate("document.querySelector('#chart-status').textContent");
    eq(status, "idle", "#chart-status still lies");
  });

  await step("2 record without the modal (ctl.modal=false)", async () => {
    const r = await g.openRecord(s, 1, { modalGraceMs: 400 });
    eq(r.sawModal, false, "no modal");
    eq(r.record.name, "Ada Lovelace", "record 1 name from the wire");
  });

  await step("2 record WITH a delayed modal (modal=true, modalDelayMs=600)", async () => {
    await g.ctl(s, { modal: true, modalDelayMs: 600 });
    const r = await g.openRecord(s, 2);
    eq(r.sawModal, true, "modal seen and acknowledged");
    eq(r.record.allergies, ["Penicillin", "Latex"], "record 2 allergies");
    await g.ctl(s, { modal: false, modalDelayMs: 0 });
  });

  await step("3 optimistic save: success on the wire", async () => {
    const r = await g.save(s);
    eq(r.status, 200, "save status");
    eq(r.uiSays, "Saved ✓", "UI is optimistic");
  });

  await step("3 optimistic save: FAILURE only visible on the wire", async () => {
    await g.ctl(s, { saveFails: true });
    const r = await g.save(s);
    eq(r.status, 500, "failed save status");
    eq(r.uiSays, "Saved ✓", "UI still claims success");
    await g.ctl(s, { saveFails: false });
  });

  await step("4 spinner is perpetual", async () => {
    if (!(await g.spinnerStillSpinning(s, 700))) throw new Error("spinner disappeared?!");
  });

  await step("7 debounced search: one XHR per word", async () => {
    const r = await g.search(s, "ada");
    eq(r.hits, ["Ada Lovelace"], "search hits");
    const n = s.store.requests({ url: "/api/search", action: r.act }).length;
    if (n !== 1) throw new Error(`debounce broke: ${n} requests`);
  });

  await step("17 keyboard-only combobox", async () => {
    const r = await g.pickMed(s, "asp");
    eq(r.selected, "Aspirin", "med selected");
  });

  await step("8 virtualised rows: 10000 on the wire, ~24 in the DOM", async () => {
    const r = await g.loadRows(s);
    eq(r.total, 10000, "rows on the wire");
    if (r.domCount > 60) throw new Error(`not virtualised: ${r.domCount} nodes`);
    const sc = await g.scrollRowsTo(s, 5000);
    if (Number(sc.firstId) < 4900) throw new Error(`scroll did not move: ${sc.firstId}`);
  });

  await step("9 re-render race needs js:true", async () => {
    const r = await g.clickRerender(s);
    if (r.count < 1) throw new Error("click did not count");
  });

  await step("10 iframes: same-origin, cross-origin, depth 2", async () => {
    eq((await g.submitSameFrame(s, "Ada")).text, "Submitted: Ada", "same-origin");
    eq((await g.submitCrossFrame(s, "Grace")).body.origin, "x", "cross-origin body");
    if (!(await g.submitDeepFrame(s, "Deep")).text) throw new Error("depth-2 frame silent");
  });

  await step("11 native dialogs are handled and logged", async () => {
    eq((await g.nativeDialog(s, "alert")).dialog.message, "Hello from gauntlet", "alert message");
    eq((await g.nativeDialog(s, "confirm")).dialog.type, "confirm", "confirm type");
  });

  await step("11 beforeunload on the way out, and back", async () => {
    const r = await g.armUnloadAndNavigateAway(s);
    eq(r.dialog.type, "beforeunload", "beforeunload logged");
  });

  await step("14 delete (the only DELETE)", async () => {
    eq((await g.deleteItem(s)).body, { deleted: 1 }, "delete body");
  });

  await step("15 child window opens and is cleaned up", async () => {
    const r = await g.openChildWindow(s);
    if (!r.text.includes("Child window")) throw new Error(r.text);
    if (s.context.pages().length !== 1) throw new Error("popup left open");
  });

  await step("16 canvas cell paints (pixels only)", async () => {
    const r = await g.pickCanvasCell(s, 2, 5);
    eq(r.after, "255,213,79,255", "picked cell colour");
    eq(r.label, "2,5", "cell label from /api/grid");
  });

  await step("24 context menu", async () => {
    eq((await g.contextMenuPick(s, "rename")).result, "ctx: Rename", "ctx result");
  });

  await step("25 double-click to edit", async () => {
    if (!(await g.doubleClickToEdit(s)).editable) throw new Error("no input appeared");
  });

  await step("26 slider drag", async () => {
    const r = await g.setSlider(s, 120);
    if (r.value < 35 || r.value > 50) throw new Error(`slider value ${r.value}`);
    if (!String(r.reported).includes('"widget":"slider"')) throw new Error(`drag-report ${r.reported}`);
  });

  await step("26 reorder by one slot (drop two slots away)", async () => {
    const r = await g.moveItemDownOneSlot(s);
    eq(r.before, "a,b,c", "start order");
    eq(r.after, "b,a,c", "after one slot");
  });

  await step("18 shadow DOM (open root, CSS pierces)", async () => {
    eq((await g.clickShadowButton(s)).count, 1, "shadow count");
  });

  await step("20 GraphQL over POST", async () => {
    eq((await g.graphql(s, "query")).body.operation, "query", "query op");
    const m = await g.graphql(s, "mutate");
    eq(m.body.sawMutation, true, "mutation seen by the server");
  });

  await step("28 fake stream: event-stream mime, finite body, captured", async () => {
    const r = await g.loadFakeStream(s);
    eq(r.mime, "text/event-stream", "mime");
    eq(r.bodyState, "ok", "body captured despite the mime");
    if (!r.body.includes("<envelope>")) throw new Error(r.body);
  });

  await step("23 push over WebSocket (frame + DOM)", async () => {
    await g.goHome(s);                       // the socket must open inside THIS session
    const r = await g.pushNotification(s, "ws");
    if (!r.latest.endsWith("via ws")) throw new Error(r.latest);
  });

  await step("23 push over SSE (DOM only — the stream is never captured)", async () => {
    const r = await g.pushNotification(s, "sse");
    if (!r.latest.endsWith("via sse")) throw new Error(r.latest);
  });

  await step("23 push over long-poll (needs ctl.notify)", async () => {
    await g.ctl(s, { notify: true });
    await g.goHome(s);
    const r = await g.pushNotification(s, "poll");
    if (!r.latest.endsWith("via poll")) throw new Error(r.latest);
    await g.ctl(s, { notify: false });
  });

  await step("5/22 ambient traffic: heartbeat + reissuing long-poll", async () => {
    const r = await g.observeAmbient(s, 1, 12000);
    if (r.heartbeats < 1) throw new Error("no heartbeat");
    if (r.polls < 1) throw new Error("no ambient poll");
  });

  await step("12 session timeout dialog and recovery", async () => {
    const r = await g.sessionTimeoutAndRecover(s, 2000);
    if (!r.text.includes("Session expiring")) throw new Error(r.text);
    eq(r.state, "off", "timer reset after 'Stay signed in'");
  });

  await step("21 auth: the shell itself is guarded", async () => {
    await g.ctl(s, { requireAuth: true });
    await g.logout(s);
    const home = await g.goHome(s, { allowLogin: true });
    eq(home.which, "login", "GET / 302s to /login.html?next=/");
  });

  await step("21 auth: empty credentials refused, any non-empty pair accepted", async () => {
    const bad = await g.login(s, "", "");
    eq(bad.which, "error", "an empty field is the only refusal (401)");
    const ok = await g.login(s, "admin", "admin");
    eq(ok.which, "home", "?next=/ lands back on the shell");
    eq(ok.cookie, "admin", "gauntlet_auth cookie");
  });

  await step("21 auth: the secure area, then a refusal in milliseconds", async () => {
    const ok = await g.gotoSecure(s);
    eq(ok.which, "secure", "cookie opens /secure.html");
    eq(await s.evaluate("document.querySelector('#who').textContent"), "Welcome, admin", "#who");
    await g.goHome(s);
    await g.logout(s);
    const refused = await g.gotoSecure(s);
    eq(refused.which, "login", "no cookie -> 302 to login");
    await g.ctl(s, { requireAuth: false });
    await g.goHome(s);
  });

  await step("leave the app as we found it", async () => { await g.ctlReset(s); await g.goHome(s); });
}
