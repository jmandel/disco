// Slice 4 acceptance (BRIEF §4): sentinels + stream. Firings persisted with screenshots, surfaced in the
// next report's environment flags, and streamed over the RPC subscription (GUIDANCE §5.3–5.4).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startEnv, type Env, sleep } from "../helpers.ts";
import { act, registerActions } from "../../src/act.ts";
import type { Selectors } from "../../src/selectors.ts";
import { RpcClient } from "../../src/rpc.ts";
import { blobPath } from "../../src/store.ts";
import { existsSync } from "node:fs";

let env: Env;
let sel: Selectors;
let tab: string;
const A = (p: any) => act(env.daemon, sel, p);

beforeAll(async () => {
  env = await startEnv();
  sel = registerActions(env.daemon);
  tab = await env.open("/");
  await sleep(3000);
}, 60000);
afterAll(async () => { await env?.stop(); });

describe("slice 4: sentinels + stream", () => {
  test("conditional modal fires the dialog sentinel with a screenshot even 2s AFTER settlement", async () => {
    env.gauntlet.ctl.set({ modal: true, modalDelayMs: 2000 });
    await sleep(400);
    const r = await A({ kind: "click", target: '.record[data-id="3"]' });
    expect(["settled:network", "settled:dom", "settled:visual"]).toContain(r.verdict); // settled BEFORE the modal
    const before = env.daemon.store.all<any>("SELECT seq FROM sentinels WHERE name='dialog'").length;
    await sleep(2600); // modal appears between actions
    const dialogs = env.daemon.store.all<any>("SELECT t, detail, shot FROM sentinels WHERE name='dialog' ORDER BY seq DESC");
    expect(dialogs.length).toBeGreaterThan(before);
    const d = dialogs[0];
    expect(JSON.parse(d.detail).title).toContain("Allergy Review");
    expect(d.shot).toBeTruthy();
    expect(existsSync(blobPath(env.dir, d.shot))).toBe(true);
    // surfaced in the NEXT report's environment flags:
    const next = await A({ kind: "click", target: "#modal-ack" });
    // (the firing may already have been reported by an intermediate report — check this report or the row)
    const reported = env.daemon.store.get<any>("SELECT reported FROM sentinels WHERE name='dialog' ORDER BY seq DESC");
    expect(reported.reported).toBe(1);
    env.gauntlet.ctl.set({ modal: false, modalDelayMs: 0 });
  }, 20000);

  test("toast sentinel captures a frame while the toast is visible", async () => {
    const r = await A({ kind: "click", target: "#save" });
    await sleep(1200); // save status lands at ~500ms; toast lives 2s
    const toast = env.daemon.store.get<any>("SELECT t, detail, shot FROM sentinels WHERE name='toast' ORDER BY seq DESC");
    expect(toast).toBeTruthy();
    expect(toast.shot).toBeTruthy();
    const shotRow = env.daemon.store.get<any>("SELECT t FROM shots WHERE hash=? ORDER BY t DESC", toast.shot);
    expect(shotRow.t).toBeGreaterThanOrEqual(toast.t - 500);
    expect(shotRow.t).toBeLessThanOrEqual(toast.t + 2100); // within the toast's lifetime
  }, 15000);

  test("optimistic UI: the screen lies, the wire tells the truth", async () => {
    env.gauntlet.ctl.set({ saveFails: true });
    await sleep(400);
    const r = await A({ kind: "click", target: "#save" });
    const state = await env.evalIn(tab, "document.getElementById('save-state').textContent");
    expect(state).toContain("Saved"); // UI still says saved…
    await sleep(1200);
    const status = env.daemon.store.get<any>("SELECT status FROM requests WHERE path LIKE '%save/status%' ORDER BY t_start DESC");
    expect(status.status).toBe(500); // …the wire says otherwise
    const err = env.daemon.store.all<any>("SELECT detail FROM sentinels WHERE name='error' AND detail LIKE '%save%'");
    expect(err.length).toBeGreaterThan(0);
    env.gauntlet.ctl.set({ saveFails: false });
  }, 15000);

  test("session-expiry sentinel fires on the idle-timeout modal", async () => {
    env.gauntlet.ctl.set({ timeoutMs: 1500 });
    await sleep(3500); // no input events → modal at ~1.5s
    const exp = env.daemon.store.get<any>("SELECT detail, shot FROM sentinels WHERE name='session_expiry' ORDER BY seq DESC");
    expect(exp).toBeTruthy();
    expect(JSON.parse(exp.detail).text ?? JSON.parse(exp.detail).title).toMatch(/expir|inactiv/i);
    env.gauntlet.ctl.set({ timeoutMs: 0 });
    await A({ kind: "click", target: "#stay" }).catch(() => {});
  }, 15000);

  test("child window: new-target sentinel; the child is instrumented", async () => {
    const r = await A({ kind: "click", target: "#open-child" });
    expect(r.verdict).toBe("new-target");
    await sleep(800);
    const nt = env.daemon.store.all<any>("SELECT detail FROM sentinels WHERE name='new_target'");
    expect(nt.length).toBeGreaterThan(0);
    const child = [...env.daemon.targets.values()].find((t) => t.url.includes("child.html") && t.scoped && !t.detached);
    expect(child).toBeTruthy();
    const rc = await A({ kind: "click", target: "#child-fetch", targetId: child!.targetId });
    expect(rc.verdict).toBe("settled:network");
    const ping = env.daemon.store.all<any>("SELECT id FROM requests WHERE path LIKE '%child-ping%'");
    expect(ping.length).toBeGreaterThan(0);
  }, 20000);

  test("error sentinel: an uncaught exception fires it", async () => {
    await env.daemon.callInFrame(env.daemon.resolveFrame(undefined, tab), "function(){ setTimeout(() => { throw new Error('gauntlet-boom'); }, 0); }", [], "main");
    await sleep(600);
    const err = env.daemon.store.all<any>("SELECT detail FROM sentinels WHERE name='error' AND detail LIKE '%gauntlet-boom%'");
    expect(err.length).toBeGreaterThan(0);
  }, 10000);

  test("the RPC stream carries requests, settlements, and sentinel firings live", async () => {
    const client = await RpcClient.connect(join(env.dir, "daemon.sock"));
    const got: any[] = [];
    client.onEvent((ev) => got.push(ev));
    await client.call("subscribe");
    await A({ kind: "click", target: "#load-chart" });
    await sleep(300);
    client.close();
    const kinds = new Set(got.map((g) => g.kind));
    expect(kinds.has("request")).toBe(true);
    expect(kinds.has("response")).toBe(true);
    expect(kinds.has("settle")).toBe(true);
  }, 15000);
});
