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

describe("settlement paths the review found untested", () => {
  test("trailing: without until, the delayed save-status request is tagged trailing on this action", async () => {
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
