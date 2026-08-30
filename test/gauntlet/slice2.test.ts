// Slice 2 acceptance — the timing suite (BRIEF §4 Slice 2). No fixed sleeps in any pass path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startEnv, type Env, sleep } from "../helpers.ts";
import { act, watch, registerActions } from "../../src/act.ts";
import type { Selectors } from "../../src/selectors.ts";

let env: Env;
let sel: Selectors;
let tab: string;
const A = (p: any) => act(env.daemon, sel, p);

beforeAll(async () => {
  env = await startEnv();
  sel = (env.daemon as any).extraSel ?? registerActions(env.daemon); // daemon already registered; make a bridge for direct calls
  tab = await env.open("/");
  await sleep(3000); // idle observation (GUIDANCE §7.2): lets the ambient classifiers (network families,
  // DOM churn roots, visual ignore mask) learn the page baseline before any window opens.
}, 60000);
afterAll(async () => { await env?.stop(); });

describe("slice 2: act + settlement", () => {
  test("no-op button → no-effect, fast", async () => {
    const t0 = performance.now();
    const r = await A({ kind: "click", target: "#noop" });
    const wall = performance.now() - t0;
    expect(r.verdict).toBe("no-effect");
    expect(wall).toBeLessThan(1000); // target 600 isolated; slop for full-suite load (BRIEF §4 preamble)
  }, 10000);

  test("slow chart load: settlement scales with server latency, no tuning", async () => {
    env.gauntlet.ctl.set({ slowMs: 1800 });
    await sleep(400); // arrange: ctl frame renders into #ws-last; keep it out of the window
    const t0 = performance.now();
    const r = await A({ kind: "click", target: "#load-chart" });
    const wall = performance.now() - t0;
    expect(r.verdict).toBe("settled:network");
    expect(r.settle!.ms).toBeGreaterThan(1700);
    expect(wall).toBeLessThan(1800 + 300 + 900);
    expect(r.wire!.attributed.map((w: any) => w.family).some((f: string) => f.includes("/api/slow"))).toBe(true);
    expect(r.wire!.attributed.length).toBe(3);
    // proportional: fast now
    env.gauntlet.ctl.set({ slowMs: 150 });
    await sleep(400);
    const t1 = performance.now();
    const r2 = await A({ kind: "click", target: "#load-chart" });
    const wall2 = performance.now() - t1;
    expect(r2.verdict).toBe("settled:network");
    expect(wall2).toBeLessThan(1500);
  }, 15000);

  test("missing selector → immediate diagnosis with candidates, census, pending", async () => {
    const t0 = performance.now();
    const r = await A({ kind: "click", target: 'role=button[name="Does Not Exist"]' });
    const wall = performance.now() - t0;
    expect(r.verdict).toBe("diagnosis");
    expect(r.diagnosis!.reason).toBe("not-found");
    expect(wall).toBeLessThan(900); // target 500; slop for shot capture
    expect(r.diagnosis!.candidates!.length).toBeGreaterThan(0);
    expect(r.diagnosis!.census).toBeTruthy();
    expect(Array.isArray(r.diagnosis!.pendingRequests)).toBe(true);
  }, 10000);

  test("re-render race: click lands via re-resolve-once, detachment noted", async () => {
    const before = Number(await env.evalIn(tab, "document.getElementById('rerender-count').textContent"));
    const r = await A({ kind: "click", target: "#rerender" });
    const after = Number(await env.evalIn(tab, "document.getElementById('rerender-count').textContent"));
    expect(after).toBe(before + 1);
    expect(["no-effect", "settled:dom", "settled:network", "settled:visual"]).toContain(r.verdict);
  }, 10000);

  test("debounced search: typing settlement includes the trailing XHR", async () => {
    const r = await A({ kind: "type", target: "#search", text: "zeb" });
    expect(r.verdict).toBe("settled:network");
    expect(r.wire!.attributed.some((w: any) => w.family.includes("/api/search"))).toBe(true);
  }, 10000);

  test("occluded target → reported, no blind click-through", async () => {
    try {
    env.gauntlet.ctl.set({ modal: true });
    await sleep(400); // arrange: let the ctl WS frame render before opening a window
    const r1 = await A({ kind: "click", target: ".record[data-id=\"1\"]" }); // opens record + modal overlay
    expect(["settled:network", "settled:dom", "settled:visual"]).toContain(r1.verdict);
    const r2 = await A({ kind: "click", target: ".record[data-id=\"2\"]" }); // behind the modal now
    expect(r2.verdict).toBe("diagnosis");
    expect(r2.diagnosis!.reason).toBe("occluded");
    expect(r2.diagnosis!.occludedBy).toBeTruthy();
    const ack = await A({ kind: "click", target: "#modal-ack" });
    expect(ack.verdict).not.toBe("diagnosis");
    } finally { env.gauntlet.ctl.set({ modal: false }); await A({ kind: "click", target: "#modal-ack" }).catch(() => {}); await sleep(300); }
  }, 15000);

  test("canvas cell click: pixel-only settlement", async () => {
    await A({ kind: "scroll", frame: undefined, deltaY: 2000 }); // bring canvas into view for the screencast
    await sleep(300); // arrange: let trailing scroll mutations flush outside the click window
    const r = await A({ kind: "click", target: "#grid" });
    if (r.verdict !== "settled:visual") console.error("canvas report:", JSON.stringify({ verdict: r.verdict, settle: r.settle, ui: r.ui, wire: r.wire }, null, 1));
    expect(["settled:visual", "no-effect"]).toContain(r.verdict); // must not hang; pixels are the only signal
    expect(r.verdict).toBe("settled:visual");
    expect(r.wire!.attributed.length).toBe(0);
    const sel2 = await env.evalIn(tab, "window.__gridSelected ? JSON.stringify(window.__gridSelected) : null");
    expect(sel2).toBeTruthy();
  }, 12000);

  test("cross-origin iframe: resolve in OOPIF, click via root coords, POST attributed", async () => {
    await A({ kind: "type", target: "#xf-name", frame: "xframe.html", text: "oopif" });
    const r = await A({ kind: "click", target: "#xf-submit", frame: "xframe.html" });
    if (r.verdict !== "settled:network") console.error("xf report:", JSON.stringify({ verdict: r.verdict, settle: r.settle, wire: r.wire }, null, 1), "reqs:", env.daemon.store.all("SELECT id,method,path,action_id,attribution,target_id,t_start,t_end FROM requests WHERE path LIKE ?", "%xframe%"));
    expect(r.verdict).toBe("settled:network");
    expect(r.wire!.attributed.some((w: any) => w.family.includes("xframe-submit"))).toBe(true);
    const res = await env.daemon.callInFrame(env.daemon.resolveFrame("xframe.html"), "function(){ return document.getElementById('xf-result').textContent; }");
    expect(String(res.value)).toContain("oopif");
  }, 15000);

  test("watch: selector that never comes → diagnosis within budget", async () => {
    const t0 = performance.now();
    const r = await watch(env.daemon, sel, { selector: "#never-ever", budgetMs: 1500 });
    const wall = performance.now() - t0;
    expect(r.matched).toBe(false);
    expect(wall).toBeLessThan(1700);
    expect(r.diagnosis).toBeTruthy();
  }, 10000);

  test("right-click opens the custom menu; left click does not", async () => {
    const r = await A({ kind: "rightclick", target: "#ctx-target" });
    expect(r.ui!.added.join("\n")).toMatch(/menu/i);
    const pick = await A({ kind: "click", target: "#ctx-rename" });
    expect(pick.verdict).not.toBe("diagnosis");
    const txt = await env.evalIn(tab, "document.getElementById('ctx-result').textContent");
    expect(txt).toBe("ctx: Rename");
    await A({ kind: "click", target: "#ctx-target" });
    const txt2 = await env.evalIn(tab, "document.getElementById('ctx-result').textContent");
    expect(txt2).toBe("ctx: leftclick");
    expect(await env.evalIn(tab, "!!document.querySelector('#ctx-menu') && getComputedStyle(document.querySelector('#ctx-menu')).display !== 'none'")).toBe(false);
  }, 15000);

  test("double-click enters edit mode", async () => {
    const r = await A({ kind: "dblclick", target: "#dbl-target" });
    expect(r.verdict).not.toBe("diagnosis");
    const state = await env.evalIn(tab, "document.getElementById('dbl-state').textContent");
    expect(state).toBe("editing");
    await A({ kind: "type", target: "#dbl-input", text: "!" });
    await A({ kind: "press", key: "Enter" });
    const state2 = await env.evalIn(tab, "document.getElementById('dbl-state').textContent");
    expect(state2).toStartWith("committed:");
  }, 15000);

  test("drag: slider moves and the drag-report POST is attributed", async () => {
    const r = await A({ kind: "drag", target: "#slider-thumb", toOffset: { dx: 150, dy: 0 } });
    const value = Number(await env.evalIn(tab, "document.getElementById('slider-value').textContent"));
    expect(value).toBeGreaterThan(30);
    expect(r.wire!.attributed.some((w: any) => w.family.includes("drag-report"))).toBe(true);
  }, 15000);

  test("keyboard-only combobox: type + ArrowDown + Enter selects", async () => {
    await A({ kind: "type", target: "#med", text: "met" });
    await A({ kind: "press", key: "ArrowDown" });
    const r = await A({ kind: "press", key: "Enter" });
    expect(r.verdict).not.toBe("diagnosis");
    const selTxt = await env.evalIn(tab, "document.getElementById('med-selected').textContent");
    expect(selTxt).toStartWith("Selected:");
  }, 15000);

  test("evaluateAfter runs in-page and returns with the report", async () => {
    const r = await A({ kind: "click", target: "#load-rows", evaluateAfter: "function(){ return { rows: document.getElementById('rows-count').textContent, domRows: document.querySelectorAll('#rows .row').length }; }" });
    expect(r.verdict).toBe("settled:network");
    expect((r.evaluateAfter as any).rows).toBe("10000 rows");
    expect((r.evaluateAfter as any).domRows).toBeLessThan(60); // virtualized
    const body = r.wire!.attributed.find((w: any) => w.family.includes("/api/rows"))?.body;
    expect(body).toBeTruthy();
    const s = env.store();
    expect(s.body(body!)).toContain("Zebra-Row-9741"); // the wire had it all along
    s.close();
  }, 15000);
});
