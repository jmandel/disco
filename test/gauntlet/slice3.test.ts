// Slice 3 acceptance (BRIEF §4): attribution + ambient classifier under LIVE ambient traffic, and
// backend→frontend content over every standing channel (behaviors 5, 22, 23; GUIDANCE §4.4, §10).
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
  // fast ambient cadences so the classifier can learn within a test-sized idle window
  env.gauntlet.ctl.set({ ambient: true, notify: true, heartbeatMs: 900, pollHoldMs: 1100, notifyPollHoldMs: 1100 });
  tab = await env.open("/");
  await sleep(8000); // idle observation: heartbeat ≥3 occurrences, chained polls ≥3 links
}, 60000);
afterAll(async () => { await env?.stop(); });

describe("slice 3: attribution + ambient", () => {
  test("classifier learned the ambient families with evidence", async () => {
    const fams = env.daemon.store.all<any>("SELECT family, ambient, ambient_reason, evidence FROM families WHERE ambient=1");
    const names = fams.map((f) => f.family);
    expect(names.some((f: string) => f.includes("/api/heartbeat"))).toBe(true);
    expect(names.some((f: string) => f.includes("/api/poll") || f.includes("/api/notify-poll"))).toBe(true);
    for (const f of fams) {
      const ev = JSON.parse(f.evidence);
      expect(ev.count).toBeGreaterThanOrEqual(3);
      expect(["periodic", "chained"]).toContain(f.ambient_reason);
    }
  });

  test("heartbeat + reissuing long-polls never hold settlement open", async () => {
    env.gauntlet.ctl.set({ slowMs: 1800 });
    await sleep(400);
    const t0 = performance.now();
    const r = await A({ kind: "click", target: "#load-chart" });
    const wall = performance.now() - t0;
    // Non-interference is the claim here (heartbeat/poll don't hold settlement open) — carried by the
    // timing + attribution assertions below. The verdict LABEL may be network or dom: with ambient
    // traffic on, a poll/notify render can land in the DOM during the settle tail and retag it (the
    // dedicated network-label assertion lives in slice2's ambient-free chart test). DECISIONS #30.
    expect(["settled:network", "settled:dom"]).toContain(r.verdict);
    expect(r.settle!.ms).toBeGreaterThan(1700);
    expect(wall).toBeLessThan(1800 + 300 + 1200); // polls reissue inside this window and must not extend it
    const attributed = r.wire!.attributed;
    expect(attributed.length).toBe(3);
    for (const w of attributed) expect(["task", "window", "dependency"]).toContain(w.a);
    // ambient traffic really did fire inside the window (heartbeat ~0.9s cadence in a ~2.1s window)
    const amb = env.daemon.store.all<any>("SELECT id, family, attribution FROM requests WHERE action_id=? AND attribution='ambient'", r.action);
    expect(amb.length + r.wire!.ambientInWindow).toBeGreaterThan(0);
  }, 20000);

  test("spontaneous WS push during an action is visible but not attributed", async () => {
    env.gauntlet.ctl.set({ slowMs: 1200 });
    await sleep(400);
    const p = A({ kind: "click", target: "#load-chart" });
    await sleep(300);
    env.gauntlet.ctl.set({ wsPush: true } as any); // arrives mid-window
    const r = await p;
    expect(r.wire!.ws).toBeGreaterThan(0); // frames counted in the window
    const push = env.daemon.store.all<any>("SELECT payload FROM ws_frames WHERE dir='in' AND payload LIKE '%\"push\"%'");
    expect(push.length).toBeGreaterThan(0);
  }, 20000);

  test("GraphQL: query carries no write-flag; mutation does", async () => {
    const q = await A({ kind: "click", target: "#gql-query" });
    expect(q.env.writeFlag ?? []).toHaveLength(0);
    const m = await A({ kind: "click", target: "#gql-mutate" });
    expect((m.env.writeFlag ?? []).join(" ")).toContain("graphql");
    const rows = env.daemon.store.all<any>("SELECT write_kind, req_body FROM requests WHERE path LIKE '%graphql%' ORDER BY t_start");
    expect(rows.at(-2)?.write_kind).toBe("read");
    expect(rows.at(-1)?.write_kind).toBe("write");
  }, 20000);

  test("SSE: stream flagged, every message captured, settlement not held by the open stream", async () => {
    const r = await A({ kind: "click", target: "#start-sse", maxBudgetMs: 6000 });
    expect(r.verdict).not.toBe("still-active"); // the never-finishing EventSource request must not hold it
    await sleep(3200); // let all 5 messages arrive (500ms apart)
    const req = env.daemon.store.get<any>("SELECT id, body_state FROM requests WHERE path LIKE '%/api/sse%' ORDER BY t_start DESC");
    expect(req).toBeTruthy(); // the on-demand SSE request is captured; its exact body_state (ok/streaming/
    // error) is timing-dependent — getResponseBody racing the stream close — so what matters is the
    // messages (below) and that the PERSISTENT notify-sse stays flagged streaming.
    const persistent = env.daemon.store.get<any>("SELECT body_state FROM requests WHERE path LIKE '%notify-sse%' ORDER BY t_start DESC");
    expect(persistent.body_state).toBe("streaming");
    const msgs = env.daemon.store.all<any>("SELECT data FROM sse_events WHERE request_id=?", req.id);
    expect(msgs.length).toBe(5);
  }, 20000);

  test("push channels: content arrives via WS, SSE, and long-poll — on the wire AND on the screen", async () => {
    for (const via of ["ws", "sse", "poll"] as const) {
      env.gauntlet.ctl.set({ push: via } as any);
      await sleep(700);
    }
    const listText = await env.evalIn(tab, "[...document.querySelectorAll('#notif-list li')].map(l => l.textContent).join('|')");
    expect(listText).toMatch(/via ws/);
    expect(listText).toMatch(/via sse/);
    expect(listText).toMatch(/via poll/);
    // wire evidence, channel by channel:
    expect(env.daemon.store.all<any>("SELECT payload FROM ws_frames WHERE payload LIKE '%via ws%' AND dir='in'").length).toBeGreaterThan(0);
    expect(env.daemon.store.all<any>("SELECT data FROM sse_events WHERE data LIKE '%via sse%'").length).toBeGreaterThan(0);
    const pollBodies = env.daemon.store.all<any>("SELECT b.text FROM requests r JOIN bodies b ON b.hash=r.body_hash WHERE r.path LIKE '%notify-poll%' AND b.text LIKE '%via poll%'");
    expect(pollBodies.length).toBeGreaterThan(0);
    // and FTS finds them retroactively without knowing the channel:
    const s = env.store();
    const app = s.appearances("via poll");
    expect(app.bodies.length).toBeGreaterThan(0);
    s.close();
  }, 25000);

  test("between-action WS/SSE deliveries land in the event stream with timestamps", async () => {
    const evs = env.daemon.store.all<any>("SELECT kind, COUNT(*) n FROM events WHERE kind IN ('ws_frame','sse') GROUP BY kind");
    const byKind = Object.fromEntries(evs.map((e) => [e.kind, e.n]));
    expect(byKind.ws_frame).toBeGreaterThan(0);
    expect(byKind.sse).toBeGreaterThan(0);
  });
});
