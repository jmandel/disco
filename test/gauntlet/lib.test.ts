// The gauntlet function library, tested against the live (local) gauntlet — the pattern for a per-product
// "automated test loop over the function library" (PLATFORM.md plan #4). Runs in `bun test` because the
// gauntlet is local + deterministic; a real product's live check lives in its pack as a plain script.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startEnv, type Env, sleep } from "../helpers.ts";
import { registerActions } from "../../src/act.ts";
import { Session } from "../../src/client.ts";
import * as g from "../../artifacts/gauntlet/lib.ts";

let env: Env; let s: Session;
beforeAll(async () => {
  env = await startEnv();
  registerActions(env.daemon);
  await env.open("/");
  await sleep(2500);
  s = await Session.connect(env.dir);
}, 60000);
afterAll(async () => { s?.close(); await env?.stop(); });

describe("gauntlet function library", () => {
  test("openRecord handles the interstitial whether present or absent", async () => {
    env.gauntlet.ctl.set({ modal: true, modalDelayMs: 300 });
    await sleep(400);
    const rec2 = await g.openRecord(s, 2);            // modal present → dismissed
    expect(rec2.id).toBe(2);
    expect(typeof rec2.name).toBe("string");

    env.gauntlet.ctl.set({ modal: false });
    await sleep(400);
    const rec3 = await g.openRecord(s, 3);            // modal absent → proceeds, same code
    expect(rec3.id).toBe(3);
  }, 30000);

  test("extractRowNames returns the full 10k off the wire", async () => {
    const names = await g.extractRowNames(s);
    expect(names.length).toBe(10000);
    expect(names).toContain("Zebra-Row-9741");        // never rendered in the DOM
  }, 20000);

  test("search returns the debounced hits", async () => {
    const hits = await g.search(s, "ada"); // matches "Ada Lovelace" in the gauntlet name list
    expect(hits.length).toBeGreaterThan(0);
  }, 15000);

  test("assertHome throws off-anchor (robustness: functions verify where they are)", async () => {
    await env.open("/away.html");                     // navigate somewhere without #load-chart
    await sleep(300);
    const s2 = await Session.connect(env.dir);
    try {
      // point the session's primary target at the away tab
      const targets = await s2.targets();
      const away = targets.find((t: any) => t.url.includes("away.html"));
      if (away) await s2.focusTarget(away.targetId);
      await expect(g.assertHome(s2)).rejects.toThrow(/anchor/);
    } finally { s2.close(); }
  }, 20000);
});
