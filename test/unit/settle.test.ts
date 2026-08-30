import { describe, expect, test } from "bun:test";
import { Settler, type Clock, type SettleResult } from "../../src/settle.ts";

/** Deterministic fake clock: manual time, ordered timers. */
class FakeClock implements Clock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private n = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.timers.push({ at: this.t + ms, fn, id }); return id; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x.id !== h); }
  async advance(to: number) {
    while (true) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > to) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await Promise.resolve(); // let promise chains run
    }
    this.t = to;
    await Promise.resolve();
  }
}
const cfg = { quietMs: 300, noEffectMs: 500, budgetMs: 3000, maxBudgetMs: 20000 };

async function resultOf(p: Promise<SettleResult>): Promise<SettleResult | null> {
  let r: SettleResult | null = null; void p.then((x) => (r = x)); await Promise.resolve(); return r;
}

describe("settler", () => {
  test("no-effect fires at exactly noEffectMs when nothing happens", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    await c.advance(499); expect(await resultOf(s.result)).toBeNull();
    await c.advance(500);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("no-effect");
  });

  test("network keeps settlement open while attributed requests fly; closes ~Q after last", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    s.feed({ kind: "request-start", t: 50, id: "a" });
    s.feed({ kind: "request-start", t: 60, id: "b" });
    c.t = 60;
    s.feed({ kind: "request-end", t: 400, id: "b" }); c.t = 400;
    await c.advance(2900); expect(await resultOf(s.result)).toBeNull(); // "a" still in flight past naive quiet
    s.feed({ kind: "request-end", t: 2950, id: "a" }); c.t = 2950;
    await c.advance(3249); expect(await resultOf(s.result)).toBeNull();
    await c.advance(3251);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("settled:network");
    expect(r.tSettled).toBe(2950);
    expect(r.tReported).toBeGreaterThanOrEqual(3250);
  });

  test("proportional: fast request settles fast (no fixed sleeps)", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    s.feed({ kind: "request-start", t: 20, id: "a" });
    s.feed({ kind: "mutation", t: 30 });
    s.feed({ kind: "request-end", t: 200, id: "a" }); c.t = 200;
    await c.advance(600);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("settled:network");
    expect(r.tReported).toBeLessThanOrEqual(510);
  });

  test("still-active at plain budget when dom churns forever with no pending requests", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    for (let t2 = 100; t2 <= 3000; t2 += 100) { s.feed({ kind: "mutation", t: t2 }); c.t = t2; await c.advance(t2); }
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("still-active");
    expect(r.pending!.channels).toContain("dom");
  });

  test("dom-only change settles on dom", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    s.feed({ kind: "mutation", t: 100 }); c.t = 100;
    s.feed({ kind: "mutation", t: 250 }); c.t = 250;
    await c.advance(560);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("settled:dom");
    expect(r.tSettled).toBe(250);
  });

  test("pixels-only (canvas) settles on visual", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    s.feed({ kind: "visual", t: 120 }); c.t = 120;
    await c.advance(430);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("settled:visual");
  });

  test("still-active: in-flight attributed request suspends the budget but hits maxBudget", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, maxBudgetMs: 5000, t0: 0 }, c);
    s.feed({ kind: "request-start", t: 100, id: "poll" }); c.t = 100;
    await c.advance(3200); expect(await resultOf(s.result)).toBeNull(); // budget suspended: request in flight
    await c.advance(5000);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("still-active");
    expect(r.pending!.requests).toEqual(["poll"]);
    expect(r.pending!.channels).toContain("network");
  });

  test("dialog settles immediately", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    s.feed({ kind: "mutation", t: 50 });
    s.feed({ kind: "dialog", t: 80, detail: "confirm" });
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("dialog");
    expect(r.tReported).toBe(80);
  });

  test("navigation keeps the race open and yields verdict navigated at quiet", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    s.feed({ kind: "navigated", t: 100, url: "http://x/2" }); c.t = 100;
    s.feed({ kind: "request-start", t: 150, id: "doc" }); c.t = 150;
    s.feed({ kind: "request-end", t: 900, id: "doc" }); c.t = 900;
    s.feed({ kind: "mutation", t: 950 }); c.t = 950;
    await c.advance(1300);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("navigated");
    expect(r.navigated).toBe("http://x/2");
    expect(r.tSettled).toBe(950);
  });

  test("extend() pushes the budget out", async () => {
    const c = new FakeClock();
    const s = new Settler({ ...cfg, t0: 0 }, c);
    s.feed({ kind: "request-start", t: 50, id: "slow" }); c.t = 50;
    await c.advance(2500);
    s.extend(3000); // now budget = 2500+3000
    await c.advance(3100); expect(await resultOf(s.result)).toBeNull();
    s.feed({ kind: "request-end", t: 4000, id: "slow" }); c.t = 4000;
    await c.advance(4400);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("settled:network");
  });

  test("seed() carries in-flight requests into a re-armed settler", async () => {
    const c = new FakeClock(); c.t = 1000;
    const s = new Settler({ ...cfg, t0: 1000 }, c);
    s.seed(["carried"]);
    await c.advance(1600); expect(await resultOf(s.result)).toBeNull(); // no no-effect: seeded activity
    s.feed({ kind: "request-end", t: 1700, id: "carried" }); c.t = 1700;
    await c.advance(2100);
    const r = (await resultOf(s.result))!;
    expect(r.verdict).toBe("settled:network");
  });
});
