// Slice 7 acceptance (BRIEF §4): the vendored selector engine across frames and shadow roots.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startEnv, type Env, sleep } from "../helpers.ts";
import { act, registerActions } from "../../src/act.ts";
import type { Selectors } from "../../src/selectors.ts";

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

describe("slice 7: selector engine everywhere", () => {
  test("role= with accessible name resolves in the main frame", async () => {
    const r = await A({ kind: "click", target: 'role=button[name="Do nothing"]' });
    expect(r.verdict).toBe("no-effect");
    expect(r.target!.generated).toBeTruthy();
  }, 10000);

  test("text= resolves", async () => {
    const f = env.daemon.resolveFrame(undefined, tab);
    const r = await sel.resolve(f, 'text="Load Chart"');
    expect("objectId" in r).toBe(true);
  });

  test("label-based targeting via placeholder/aria works through internal engines", async () => {
    const f = env.daemon.resolveFrame(undefined, tab);
    const r = await sel.resolve(f, 'css=input[placeholder="Search…"]');
    expect("objectId" in r).toBe(true);
  });

  test("same-origin iframe: role= resolves with a frame spec and the submit round-trips", async () => {
    await A({ kind: "type", target: "#if-name", frame: "iframe.html", text: "inner" });
    const r = await A({ kind: "click", target: 'role=button[name="Submit"]', frame: "iframe.html" });
    expect(r.verdict).toBe("settled:network");
    expect(r.wire!.attributed.some((w: any) => w.family.includes("iframe-submit"))).toBe(true);
    const res = await env.daemon.callInFrame(env.daemon.resolveFrame("iframe.html"), "function(){ return document.getElementById('if-result').textContent; }");
    expect(String(res.value)).toContain("inner");
  }, 15000);

  test("depth-2 nested iframe: coordinates translate once per hop-to-main, not per frame (review F1)", async () => {
    await A({ kind: "type", target: "#deep-name", frame: "iframe2.html", text: "deep" });
    const r = await A({ kind: "click", target: "role=button[name=\"Deep Submit\"]", frame: "iframe2.html" });
    expect(r.verdict).toBe("settled:network");
    expect(r.wire!.attributed.some((w: any) => w.family.includes("iframe-submit"))).toBe(true);
    const res = await env.daemon.callInFrame(env.daemon.resolveFrame("iframe2.html"), "function(){ return document.getElementById('deep-result').textContent; }");
    expect(String(res.value)).toContain("deep");
  }, 15000);

  test("cross-origin iframe: role= resolves in the OOPIF", async () => {
    const r = await A({ kind: "click", target: 'role=button[name="Submit"]', frame: "xframe.html" });
    expect(["settled:network", "settled:dom"]).toContain(r.verdict);
  }, 15000);

  test("shadow DOM pierces: the shadow button clicks and its in-shadow counter increments", async () => {
    const before = await env.evalIn(tab, "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-count').textContent");
    const r = await A({ kind: "click", target: 'role=button[name="Shadow button"]' });
    expect(r.verdict).not.toBe("diagnosis");
    const after = await env.evalIn(tab, "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-count').textContent");
    expect(Number(after)).toBe(Number(before) + 1);
  }, 10000);

  test("re-navigating a tab does not strand child frames (DECISIONS #31)", async () => {
    // resolve inside the same-origin iframe
    const r1 = await sel.resolve(env.daemon.resolveFrame("iframe.html"), "#if-submit");
    expect("objectId" in r1).toBe(true);
    // navigate the SAME top tab again (full reload) — rebuilds the frame tree; the old iframe frame must
    // be pruned so it can't shadow the new one and break createIsolatedWorld.
    await A({ kind: "navigate", url: env.gauntlet.origin + "/" });
    await sleep(1200);
    const r2 = await sel.resolve(env.daemon.resolveFrame("iframe.html"), "#if-submit");
    expect("objectId" in r2).toBe(true);
  }, 20000);

  test("chained selector with >> works", async () => {
    const f = env.daemon.resolveFrame(undefined, tab);
    const r = await sel.resolve(f, '#s-8 >> role=button');
    expect("objectId" in r).toBe(true);
  });

  test("strict-ish info: count reported for multi-matches", async () => {
    const f = env.daemon.resolveFrame(undefined, tab);
    const r = await sel.resolve(f, "css=button.record");
    expect("objectId" in r && (r as any).count).toBe(5);
  });
});
