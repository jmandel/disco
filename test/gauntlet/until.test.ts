// act({until}) — the postcondition contract (GUIDANCE §9): the verdict says what the page did, `until`
// whether the state you need arrived; the return is gated on both, bounded. Plus the settlement paths the
// review found untested: trailing attribution, still-active → awaitSettlement ownership, digest truncation.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startEnv, type Env, sleep } from "../helpers.ts";
import { registerActions } from "../../src/act.ts";
import { Session } from "../../src/client.ts";
import { defaults } from "../../defaults.ts";

let env: Env; let s: Session;
const chartStatus = () => document.querySelector("#chart-status")?.textContent;
const isIdle = () => document.querySelector("#chart-status")?.textContent === "idle";
const setCtl = async (patch: Record<string, unknown>) => { env.gauntlet.ctl.set(patch as any); await sleep(400); }; // ctl frame renders into #ws-last; keep it out of the window

beforeAll(async () => {
  env = await startEnv();
  registerActions(env.daemon);
  await env.open("/");
  await sleep(3000); // idle observation: ambient classifiers learn the baseline
  s = await Session.connect(env.dir);
}, 60000);
afterAll(async () => { s?.close(); await env?.stop(); });

describe("act({until}): the postcondition is the readiness contract", () => {
  test("scenario 27 without until: settlement closes before the screen shows the result (the trap)", async () => {
    await setCtl({ slowMs: 100, renderDelayMs: 900 });
    const r = await s.click("#load-chart", { evaluateAfter: chartStatus });
    expect(r.verdict).toBe("settled:network");
    expect(r.settle!.ms).toBeLessThan(900);
    expect(r.evaluateAfter).toBe("loading…");                                        // settled ≠ ready
    expect((await s.watch({ fn: isIdle }, { budgetMs: 3000 })).matched).toBe(true);  // …it arrives later
  }, 15000);

  test("until matched AFTER settlement: the window stays open, the report carries both, post-state is the awaited one", async () => {
    await setCtl({ slowMs: 100, renderDelayMs: 900 });
    const r = await s.click("#load-chart", { until: { fn: isIdle, budgetMs: 4000 }, evaluateAfter: chartStatus });
    expect(r.verdict).toBe("settled:network");
    expect(r.settle!.ms).toBeLessThan(900);            // settlement happened first…
    expect(r.until!.matched).toBe(true);
    expect(r.until!.elapsedMs).toBeGreaterThan(900);   // …the postcondition later; both are reported
    expect(r.evaluateAfter).toBe("idle");
    expect(env.daemon.windows.size).toBe(0);
  }, 15000);

  test("until matched BEFORE settlement: the wait is capped to a short tail; still-active + matched is a pass", async () => {
    await setCtl({ slowMs: 6000, renderDelayMs: 0 });
    const t0 = performance.now();
    const r = await s.click("#load-chart", { until: { fn: () => document.querySelector("#chart-status")?.textContent === "loading…", tailMs: 800 } });
    const wall = performance.now() - t0;
    expect(r.until!.matched).toBe(true);
    expect(r.verdict).toBe("still-active");
    expect(r.settle!.pending!.requests.length).toBeGreaterThan(0); // /api/slow still in flight — the verdict says so
    expect(wall).toBeLessThan(2500);                                // not the 20s hung-request budget
    expect(env.daemon.windows.size).toBe(0);                        // the postcondition decided; nothing lingers
    await s.watch({ fn: isIdle }, { budgetMs: 8000 });              // let the slow request land before the next test
  }, 20000);

  test("until NOT matched: a diagnosis, and the wait costs only the until budget", async () => {
    await setCtl({ slowMs: 100, renderDelayMs: 0 });
    const t0 = performance.now();
    const r = await s.click("#noop", { until: { selector: "#never-exists", budgetMs: 800 } });
    const wall = performance.now() - t0;
    expect(r.verdict).toBe("no-effect");
    expect(r.until!.matched).toBe(false);
    expect(r.until!.diagnosis!.reason).toBe("budget-expired");
    expect(r.until!.elapsedMs).toBeGreaterThanOrEqual(750);
    expect(wall).toBeLessThan(2000);
  }, 10000);

  test("until keeps the causality window open: the delayed save-status request attributes to the action, response included", async () => {
    const r = await s.click("#save", { until: { urlLike: "/api/save/status", budgetMs: 3000 } });
    expect(r.until!.matched).toBe(true);
    const st = r.wire!.attributed.find((w) => w.p.startsWith("/api/save/status"));
    expect(st).toBeTruthy();
    expect(st!.a).toBe("window");   // not `trailing`: the window was still open when it started
    expect(st!.s).toBe(200);        // the seeded tail let the response land in the report
  }, 10000);
});

describe("kinds and predicates", () => {
  test("fill replaces the value with real key events; '' clears", async () => {
    const value = () => s.evaluate<string>(() => (document.getElementById("search") as HTMLInputElement).value);
    await s.fill("#search", "abc"); expect(await value()).toBe("abc");
    await s.fill("#search", "xy");  expect(await value()).toBe("xy");
    await s.fill("#search", "");    expect(await value()).toBe("");
  }, 15000);

  test("scroll({ target }) wheels over the target: the container scrolls, not the page", async () => {
    await s.click("#load-rows", { until: { urlLike: "/api/rows", landed: true } });
    const before = await s.evaluate<{ el: number; win: number }>(() => ({ el: document.getElementById("rows")!.scrollTop, win: window.scrollY }));
    await s.scroll({ target: "#rows", deltaY: 600 });
    const after = await s.evaluate<{ el: number; win: number }>(() => ({ el: document.getElementById("rows")!.scrollTop, win: window.scrollY }));
    expect(after.el).toBeGreaterThan(before.el);
  }, 15000);

  test("a missing frame is a diagnosis with a frame census (act) / a waited-for condition (watch), not an RPC error", async () => {
    const r = await s.click("#noop", { frame: "no-such-frame.html" });
    expect(r.verdict).toBe("diagnosis");
    expect(r.diagnosis!.reason).toBe("frame-not-found");
    expect(r.diagnosis!.candidates!.length).toBeGreaterThan(0);
    const w = await s.watch({ selector: "body" }, { frame: "no-such-frame.html", budgetMs: 400 });
    expect(w.matched).toBe(false);
    expect(w.diagnosis!.reason).toBe("frame-not-found");
    expect((await s.watch({ selector: "#if-name" }, { frame: "iframe.html", budgetMs: 2000 })).matched).toBe(true); // an existing child frame
  }, 10000);

  test("`until.frame`: a postcondition in another frame than the action (and a frame that never comes is a diagnosis)", async () => {
    const r = await s.fill("#if-name", "x", { frame: "iframe.html", until: { selector: "#load-chart", frame: "main" } });
    expect(r.until!.matched).toBe(true);
    const bad = await s.click("#noop", { until: { selector: "#anything", frame: "never.html", budgetMs: 400 } });
    expect(bad.until!.matched).toBe(false);
    expect(bad.until!.diagnosis!.reason).toBe("frame-not-found");
  }, 15000);

  test("until: { any } names the arm that held; { all } needs every arm (a wire-AND-dom postcondition)", async () => {
    await setCtl({ slowMs: 300, renderDelayMs: 0 });
    const a = await s.click("#load-chart", { until: { any: [{ selector: "#never-exists", name: "never" }, { fn: isIdle, name: "idle" }] } });
    expect(a.until!.matched).toBe(true);
    expect(a.until!.which).toBe("idle");
    const b = await s.click("#load-chart", { until: { all: [{ urlLike: "/api/slow", landed: true }, { fn: isIdle }] } });
    expect(b.until!.matched).toBe(true);
    expect(b.until!.elapsedMs).toBeGreaterThanOrEqual(280);   // the slow response had to land too
    const c = await s.click("#noop", { until: { any: [{ selector: "#never-1" }, { selector: "#never-2" }], budgetMs: 400 } });
    expect(c.until!.matched).toBe(false);
    expect(c.until!.diagnosis!.reason).toBe("budget-expired");
    await setCtl({ slowMs: 100 });
  }, 20000);

  test("combinators nest: an `any` inside an `all` is evaluated, not treated as a leaf", async () => {
    const w = await s.watch({ all: [{ fn: () => true }, { any: [{ selector: "#never-exists" }, { selector: "#load-chart", visible: true, name: "chart" }] }] }, { budgetMs: 1500 });
    expect(w.matched).toBe(true);
    expect(w.which).toBe("chart");
    const miss = await s.watch({ all: [{ fn: () => true }, { any: [{ selector: "#never-1" }] }] }, { budgetMs: 300 });
    expect(miss.matched).toBe(false);
  }, 10000);

  test("a ReferenceError inside a page function fails fast with the closure hint (not `false` until the budget)", async () => {
    const t0 = performance.now();
    const w = await s.watch({ fn: "() => !!document.querySelector(NOT_DEFINED_CONST)" }, { budgetMs: 5000 });
    expect(w.matched).toBe(false);
    expect(w.diagnosis!.reason).toBe("error");
    expect(w.diagnosis!.error).toMatch(/NOT_DEFINED_CONST[\s\S]*capture nothing/);
    expect(performance.now() - t0).toBeLessThan(1500);
    await expect(s.evaluate("() => NOT_DEFINED_CONST")).rejects.toThrow(/capture nothing/);
  }, 10000);

  test("per-app rules: a sentinel mute is recorded (muted=1) but never reported; rules list/remove round-trip", async () => {
    const rule = await s.mute("toast", { text: "Saved" }, "test");
    const ign = await s.ignore("/api/never-called", "test");
    expect((await s.rules()).map((x: any) => x.id)).toEqual(expect.arrayContaining([rule.id, ign.id]));
    const r = await s.click("#save", { until: { urlLike: "/api/save/status", landed: true } });
    await s.watch({ fn: () => !!document.getElementById("toast") }, { budgetMs: 3000 });
    await sleep(300);
    expect((r.env.sentinels ?? []).some((x) => x.name === "toast")).toBe(false);
    const row = s.store.sql<any>("SELECT muted, detail FROM sentinels WHERE name='toast' ORDER BY seq DESC LIMIT 1")[0];
    expect(row?.muted).toBe(1);
    expect(JSON.parse(row.detail).mutedBy).toBe(rule.id);
    await s.unrule(rule.id); await s.unrule(ign.id);
    expect((await s.rules()).some((x: any) => x.id === rule.id)).toBe(false);
  }, 20000);

  test("`visible` requires a laid-out box; `landed` waits for the response, not just the request start", async () => {
    expect((await s.watch({ selector: "#spinner", visible: true }, { budgetMs: 500 })).matched).toBe(true);
    await setCtl({ slowMs: 1000, renderDelayMs: 0 });
    const a = await s.click("#load-chart", { until: { urlLike: "/api/slow" } });
    expect(a.until!.matched).toBe(true);
    expect(a.until!.elapsedMs).toBeLessThan(700);                 // matched on request START
    await s.watch({ fn: isIdle }, { budgetMs: 4000 });
    const b = await s.click("#load-chart", { until: { urlLike: "/api/slow", landed: true } });
    expect(b.until!.matched).toBe(true);
    expect(b.until!.elapsedMs).toBeGreaterThanOrEqual(950);       // matched when the 1s response LANDED
    await setCtl({ slowMs: 100 });
  }, 20000);
});

describe("responsiveness is a contract, not a hope", () => {
  test("a no-op act reports at ~noEffectMs and spends < 400ms outside the wait (resolve + 2 snapshots + report)", async () => {
    const r = await s.click("#noop");
    expect(r.verdict).toBe("no-effect");
    const t = r.timing!;
    expect(t.reportedMs).toBeLessThan(defaults.noEffectMs + 120);   // the no-effect tier is measured from dispatch, not from entry (would catch pointToRoot-after-t0 again)
    expect(t.overheadMs).toBeLessThan(400);                          // daemon work per act, under full-suite load
    expect(t.totalMs).toBeGreaterThanOrEqual(t.waitMs + t.overheadMs - 5);
  }, 10000);

  test("watch is event-driven: a DOM change is noticed within ~Q of happening, not on the next interval tick", async () => {
    await s.evaluate(() => { setTimeout(() => { const el = document.createElement("div"); el.id = "late-div"; el.textContent = "late"; document.body.appendChild(el); }, 300); });
    const w = await s.watch({ selector: "#late-div" }, { budgetMs: 2000 });
    expect(w.matched).toBe(true);
    expect(w.elapsedMs).toBeGreaterThanOrEqual(280);
    expect(w.elapsedMs).toBeLessThan(300 + 160);                     // mutation batch (40ms) + one check — not +250ms
    await s.evaluate(() => document.getElementById("late-div")?.remove());
  }, 10000);

  test("until matched at once costs at most the quiet tail, never the until budget", async () => {
    const r = await s.click("#noop", { until: { selector: "#load-chart", budgetMs: 5000 } }); // already true post-dispatch
    expect(r.until!.matched).toBe(true);
    expect(r.until!.elapsedMs).toBeLessThan(150);
    expect(r.timing!.waitMs).toBeLessThan(defaults.noEffectMs + 200);
  }, 10000);
});

describe("settlement paths the review found untested", () => {
  test("trailing: without until, the delayed save-status request is tagged trailing on this action", async () => {
    // Earlier tests in this file saved twice; a third /api/save/status at a similar interval, arriving outside any
    // window, can classify the family `periodic` (the heuristic working as designed) — which would suppress
    // `trailing`. Start from a clean classifier (also exercises the RPC behind `disco families --forget`).
    await s.rpc.call("families.forget");
    const r = await s.click("#save");
    expect(String(r.verdict).startsWith("settled:")).toBe(true);
    expect((await s.watch({ urlLike: "/api/save/status" }, { budgetMs: 3000 })).matched).toBe(true);
    await sleep(300); // let the response row land
    const row = s.store.requests({ urlLike: "%/api/save/status%" }).at(-1)!;
    expect(row.attribution).toBe("trailing");
    expect(row.action_id).toBe(r.action);
  }, 10000);

  test("still-active → awaitSettlement takes the window over from the background settler and extends the SAME action", async () => {
    await setCtl({ slowMs: 4000 });
    const r = await s.click("#load-chart", { maxBudgetMs: 1200 });
    expect(r.verdict).toBe("still-active");
    const w = [...env.daemon.windows.values()][0];
    expect(w?.actionId).toBe(r.action);
    expect(typeof w.bg).toBe("function");                  // background settler owns the still-active window
    const pending = s.awaitSettlement({ action: r.action, budgetMs: 10000 });
    await sleep(300);
    expect(w.bg).toBeUndefined();                          // …until awaitSettlement takes it over
    const ext = await pending;
    expect(ext.action).toBe(r.action);
    expect(ext.extended).toBe(true);
    expect(ext.verdict).toBe("settled:network");
    expect(env.daemon.windows.size).toBe(0);
    expect(s.store.action(r.action)!.verdict).toBe("settled:network"); // not settled:late
    await setCtl({ slowMs: 100 });
  }, 20000);

  test("digest truncation invariant: shown ≤ digestMaxRequests and shown + more = attributed", async () => {
    const r = await s.navigate(env.gauntlet.origin + "/");
    expect(r.verdict).toBe("navigated");
    const total = s.store.sql<{ n: number }>("SELECT COUNT(*) n FROM requests WHERE action_id=? AND attribution IS NOT NULL AND attribution NOT IN ('ambient','none')", r.action)[0].n;
    expect(r.wire!.attributed.length).toBeLessThanOrEqual(defaults.digestMaxRequests);
    expect(r.wire!.attributed.length + r.wire!.more).toBe(total);
  }, 20000);
});
