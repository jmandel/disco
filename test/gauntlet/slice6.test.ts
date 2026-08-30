// Slice 6 acceptance (BRIEF §4): storage-state save/restore across browsers, daemon restart against a
// still-running browser (same session, same clock), blob dedup sanity.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { startEnv, type Env, sleep, SCRATCH } from "../helpers.ts";
import { act, registerActions } from "../../src/act.ts";
import type { Selectors } from "../../src/selectors.ts";
import { Daemon } from "../../src/daemon.ts";
import { launchChromium } from "../../src/launch.ts";
import { RpcClient } from "../../src/rpc.ts";

let env: Env;
let sel: Selectors;
let tab: string;
const A = (p: any) => act(env.daemon, sel, p);

beforeAll(async () => {
  env = await startEnv();
  sel = registerActions(env.daemon);
  tab = await env.open("/");
  await sleep(2500);
}, 60000);
afterAll(async () => { await env?.stop(); });

describe("slice 6: launch-mode hardening", () => {
  test("storage state: log in, save, restore into a FRESH browser, land authenticated", async () => {
    const login = await env.open("/login.html");
    await A({ kind: "type", target: "#user", text: "josh", targetId: login });
    await A({ kind: "type", target: "#pass", text: "pw", targetId: login });
    const r = await A({ kind: "click", target: "#login", targetId: login });
    expect(["navigated", "settled:network", "settled:dom"]).toContain(r.verdict);
    await sleep(400);
    const who = await env.daemon.callInFrame(env.daemon.resolveFrame(undefined, login), "function(){ return document.getElementById('who') ? document.getElementById('who').textContent : location.pathname; }", [], "main");
    expect(String(who.value)).toContain("josh");

    const c = await RpcClient.connect(join(env.dir, "daemon.sock"));
    const state = await c.call("state.save");
    expect((state.cookies as any[]).some((k) => k.name === "gauntlet_auth")).toBe(true);

    const base = join(SCRATCH, "test", `restore-${Date.now().toString(36)}`);
    mkdirSync(base, { recursive: true });
    const b2 = await launchChromium({ headless: true, userDataDir: join(base, "profile") });
    const d2 = await Daemon.start({ dir: join(base, "session"), name: "restore", mode: "attach", port: b2.port, scope: `localhost:${env.gauntlet.port}` });
    try {
      const c2 = await RpcClient.connect(join(base, "session", "daemon.sock"));
      await c2.call("state.restore", { state });
      const { targetId } = await d2.cdp.send("Target.createTarget", { url: `${env.gauntlet.origin}/secure.html` });
      await sleep(1200);
      const t2 = d2.targets.get(targetId)!;
      expect(t2.url).toContain("/secure.html"); // no redirect to login
      const fr = d2.frames.get(t2.mainFrameId!)!;
      const who2 = await d2.callInFrame(fr, "function(){ return document.getElementById('who')?.textContent ?? location.pathname; }", [], "main");
      expect(String(who2.value)).toContain("Welcome, josh");
      c2.close();
    } finally {
      c.close();
      await d2.stop().catch(() => {});
      await b2.kill();
    }
  }, 45000);

  test("blob dedup: the same body stored once across repeated loads", async () => {
    await A({ kind: "click", target: "#load-rows", targetId: tab });
    await A({ kind: "click", target: "#load-rows", targetId: tab });
    const rows = env.daemon.store.all<any>("SELECT body_hash FROM requests WHERE path='/api/rows' AND body_hash IS NOT NULL");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.body_hash)).size).toBe(1);
    const bodies = env.daemon.store.all<any>("SELECT COUNT(*) n FROM bodies WHERE hash=?", rows[0].body_hash);
    expect(bodies[0].n).toBe(1);
  }, 25000);

  test("daemon restart against the still-running browser: same session, same clock, still acting", async () => {
    const tBefore = env.daemon.now();
    const seqBefore = env.daemon.store.lastSeq();
    await env.daemon.stop();
    await sleep(300);
    const d2 = await Daemon.start({ dir: env.dir, name: "whatever", mode: "attach", port: env.browser.port, scope: `localhost:${env.gauntlet.port}` });
    const sel2 = registerActions(d2);
    try {
      expect(d2.resumed).toBe(true);
      expect(d2.manifest.name).not.toBe("whatever"); // prior manifest wins
      expect(d2.now()).toBeGreaterThan(tBefore);      // anchor preserved → clock continues
      await sleep(2500);                              // re-learn ambient DOM churn on the live page
      const t = [...d2.targets.values()].find((x) => x.scoped && x.isPage && !x.detached && x.url === env.gauntlet.origin + "/");
      expect(t).toBeTruthy();
      expect(t!.late).toBe(true);                     // unobserved prefix honestly recorded
      const r = await act(d2, sel2, { kind: "click", target: "#load-chart", targetId: t!.targetId } as any);
      expect(r.verdict).toBe("settled:network");
      expect(d2.store.lastSeq()).toBeGreaterThan(seqBefore);
      (env as any).daemon = d2; // hand the resumed daemon to afterAll for cleanup
    } catch (e) {
      await d2.stop().catch(() => {});
      throw e;
    }
  }, 45000);
});
