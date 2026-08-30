// Slice 5 acceptance (BRIEF §4): the client library + CLI + same-script reduction, helpers verbatim,
// diffTrace, and store-only access with the daemon down.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startEnv, type Env, sleep } from "../helpers.ts";
import { registerActions } from "../../src/act.ts";
import { Session } from "../../src/client.ts";
import { openStore } from "../../src/store.ts";

let env: Env;
let s: Session;
let tab: string;

beforeAll(async () => {
  env = await startEnv();
  registerActions(env.daemon);
  tab = await env.open("/");
  await sleep(3000);
  s = await Session.connect(env.dir);
}, 60000);
afterAll(async () => { s?.close(); await env?.stop(); });

describe("slice 5: client library + CLI + reduction", () => {
  test("one script: act() then reduce the captured body in the same process", async () => {
    const r = await s.click('role=button[name="Load Rows"]');
    expect(r.verdict).toBe("settled:network");
    const body = r.wire!.attributed.find((w) => w.family.includes("/api/rows"))!.body!;
    const rows = s.store.json<Array<{ name: string }>>(body);
    expect(rows.length).toBe(10000);
    expect(rows[9741].name).toBe("Zebra-Row-9741");
    await s.note("full row set is wire-available on /api/rows", { kind: "ledger", action: r.action });
    expect(s.store.sql("SELECT text FROM notes WHERE action_id=?", r.action).length).toBe(1);
  }, 20000);

  test("evaluate runs in the main world with args", async () => {
    const v = await s.evaluate<number>("function(a, b){ return a + b + (window.__gridSelected ? 100 : 0); }", { args: [2, 3] });
    expect([5, 105]).toContain(v);
  });

  test("diffTrace: record-open with vs without the modal shows the dialog as the difference", async () => {
    env.gauntlet.ctl.set({ modal: true, modalDelayMs: 0 });
    await sleep(400);
    const a = await s.click('.record[data-id="1"]');
    await s.click("#modal-ack");
    env.gauntlet.ctl.set({ modal: false });
    await sleep(400);
    const b = await s.click('.record[data-id="2"]');
    const diff = s.store.diffTrace(a.action, b.action);
    const onlyA = [...diff.ui.onlyA, ...diff.sentinels.onlyA].join("\n");
    expect(onlyA).toMatch(/Allergy Review|dialog/i);
    expect(diff.families.onlyA.join()).toBe(diff.families.onlyB.join()); // same wire shape modulo the dialog
  }, 25000);

  test("helpers run verbatim as documented", async () => {
    const st = s.store;
    const reqs = st.requests({ urlLike: "%/api/rows%" });
    expect(reqs.length).toBeGreaterThan(0);
    const app = st.appearances("Zebra-Row-9741");
    expect(app.bodies.length).toBeGreaterThan(0);
    const shot = st.screenshotAt(env.daemon.now());
    expect(shot?.hash).toBeTruthy();
    const tl = st.timeline(0, env.daemon.now());
    expect(tl.some((e) => e.kind.startsWith("note:"))).toBe(true);
    const act1 = st.action(reqs[0].action_id!);
    expect(act1?.report?.verdict).toBeTruthy();
    expect(st.frames(0, env.daemon.now()).length).toBeGreaterThan(0);
  });

  test("the real CLI works against the same session (sql + act, --json)", async () => {
    // NB: must be async spawn — the daemon serving the CLI socket runs in THIS process; spawnSync
    // would block the event loop and deadlock the RPC.
    const cli = join(import.meta.dir, "..", "..", "cli", "disco.ts");
    const run = async (args: string[]) => {
      const p = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out;
    };
    const sql = await run(["sql", "SELECT COUNT(*) n FROM requests", "--session", env.dir, "--json"]);
    expect(JSON.parse(sql)[0].n).toBeGreaterThan(3);
    const rep = JSON.parse(await run(["act", "click", "#noop", "--session", env.dir, "--json"]));
    expect(rep.verdict).toBe("no-effect");
  }, 30000);

  test("a store-only script runs with the daemon down", async () => {
    await s.end().catch(() => {});
    await sleep(500);
    const st = openStore(env.dir);
    expect(st.sql("SELECT COUNT(*) n FROM events")[0].n).toBeGreaterThan(50);
    expect(st.manifest.endedWall).toBeTruthy();
    const app = st.appearances("Zebra-Row-9741");
    expect(app.bodies.length).toBeGreaterThan(0);
    st.close();
  }, 15000);
});
