/**
 * Server-level tests for the gauntlet (no browser). Starts on port 0 and
 * exercises every endpoint contract that later daemon tests rely on.
 * Budget: well under 15 s total (SSE is the slow one at ~2.5 s).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startGauntlet, DEFAULTS, type Gauntlet } from "../../gauntlet/server.ts";

let g: Gauntlet;
beforeAll(async () => { g = await startGauntlet({ port: 0 }); });
afterAll(async () => { await g.stop(); });

const get = (p: string, init?: RequestInit) => fetch(g.origin + p, init);
const getJson = async (p: string, init?: RequestInit) => (await get(p, init)).json();
const post = (p: string, body: unknown, method = "POST") =>
  get(p, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Minimal WS client with a "next frame matching predicate" waiter. */
function wsClient(url: string) {
  const ws = new WebSocket(url);
  const queue: any[] = [];
  const waiters: { pred: (f: any) => boolean; resolve: (f: any) => void }[] = [];
  ws.onmessage = (ev) => {
    const f = JSON.parse(String(ev.data));
    const i = waiters.findIndex((w) => w.pred(f));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(f);
    else queue.push(f);
  };
  const open = new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  const next = (pred: (f: any) => boolean, timeoutMs = 3000) =>
    new Promise<any>((resolve, reject) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return resolve(queue.splice(i, 1)[0]);
      const t = setTimeout(() => reject(new Error("timed out waiting for ws frame")), timeoutMs);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  return { ws, open, next };
}

test("startup: two distinct origins, /origins, no-store everywhere", async () => {
  expect(g.port).toBeGreaterThan(0);
  expect(g.xPort).toBeGreaterThan(0);
  expect(g.xPort).not.toBe(g.port);
  expect(await getJson("/origins")).toEqual({ origin: g.origin, xOrigin: g.xOrigin });
  const home = await get("/");
  expect(home.status).toBe(200);
  expect(home.headers.get("cache-control")).toBe("no-store");
  expect(await home.text()).toContain('id="load-chart"');
  const js = await get("/app.js");
  expect(js.headers.get("content-type")).toContain("javascript");
  expect(await js.text()).toContain("load-chart");
  for (const p of ["/iframe.html", "/child.html", "/away.html", "/login.html", "/style.css"]) {
    expect((await get(p)).status).toBe(200);
  }
  expect((await get("/nope")).status).toBe(404);
  expect((await get("/api/nope")).status).toBe(404);
});

test("/api/slow honors ms", async () => {
  const t0 = performance.now();
  const r = await get("/api/slow?ms=300");
  const body = await r.json();
  expect(performance.now() - t0).toBeGreaterThanOrEqual(295);
  expect(body.ms).toBe(300);
  expect(typeof body.at).toBe("number");
  expect(r.headers.get("content-type")).toContain("application/json");
  expect(r.headers.get("cache-control")).toBe("no-store");
});

test("/api/rows returns 10,000 rows with Zebra-Row-9741", async () => {
  const rows = await getJson("/api/rows");
  expect(rows.length).toBe(10000);
  expect(rows[9741]).toEqual({ id: 9741, name: "Zebra-Row-9741", group: "G1" });
  expect(rows[0].name).toBe("Aardvark-Row-0");
});

test("/ctl get/set/reset round-trips and broadcasts", async () => {
  expect(await getJson("/ctl")).toEqual({ ...DEFAULTS, xOrigin: g.xOrigin });
  const set = await post("/ctl", { slowMs: 50, modal: true, bogus: 1, toastMs: "nope" });
  expect(set.status).toBe(200);
  const view = await set.json();
  expect(view.slowMs).toBe(50);
  expect(view.modal).toBe(true);
  expect(view.toastMs).toBe(DEFAULTS.toastMs); // wrong type ignored
  expect("bogus" in view).toBe(false);
  expect((await getJson("/ctl")).slowMs).toBe(50);
  expect(g.ctl.get().modal).toBe(true);
  g.ctl.set({ modalDelayMs: 123 });
  expect((await getJson("/ctl")).modalDelayMs).toBe(123);
  expect((await post("/ctl", "not json" as any)).status).toBe(400);
  const reset = await (await post("/ctl/reset", {})).json();
  expect(reset).toEqual({ ...DEFAULTS, xOrigin: g.xOrigin });
  expect(g.ctl.get()).toEqual({ ...DEFAULTS });
});

test("/api/search filters case-insensitively; empty q → no hits", async () => {
  expect((await getJson("/api/search?q=ADA")).hits).toEqual(["Ada Lovelace"]);
  expect((await getJson("/api/search?q=an")).hits.length).toBeGreaterThan(3);
  expect((await getJson("/api/search?q=zzzz")).hits).toEqual([]);
  expect((await getJson("/api/search")).hits).toEqual([]);
  const meds = await getJson("/api/meds?q=met");
  expect(meds.hits).toEqual(["Metformin", "Metoprolol"]);
  expect((await getJson("/api/meds")).hits.length).toBe(30);
});

test("POST /api/save → 202 pending; status reflects saveFails", async () => {
  const r = await post("/api/save", { form: { name: "x" } });
  expect(r.status).toBe(202);
  const body = await r.json();
  expect(body.pending).toBe(true);
  expect(typeof body.id).toBe("number");
  const ok = await get(`/api/save/status?id=${body.id}`);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ id: body.id, ok: true });
  g.ctl.set({ saveFails: true });
  const fail = await get(`/api/save/status?id=${body.id}`);
  expect(fail.status).toBe(500);
  expect(await fail.json()).toEqual({ id: body.id, ok: false, error: "write failed" });
  g.ctl.reset();
  const r2 = await (await post("/api/save", {})).json();
  expect(r2.id).toBe(body.id + 1); // monotonic
});

test("/api/poll holds ~pollHoldMs (read at request time) with monotonic n", async () => {
  g.ctl.set({ pollHoldMs: 400 });
  const t0 = performance.now();
  const a = await getJson("/api/poll");
  const dt = performance.now() - t0;
  expect(dt).toBeGreaterThanOrEqual(390);
  expect(dt).toBeLessThan(1500);
  expect(a.heldMs).toBe(400);
  g.ctl.set({ pollHoldMs: 10 });
  const b = await getJson("/api/poll");
  expect(b.n).toBe(a.n + 1);
  expect(b.heldMs).toBe(10);
  g.ctl.reset();
});

test("/api/sse streams 5 data events then closes", async () => {
  const r = await get("/api/sse");
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  const body = await r.text(); // resolves only when the server closes the stream
  const events = body.split("\n\n").filter((chunk) => chunk.includes("data:"));
  expect(events.length).toBe(5);
  expect(events[4]).toContain('"i":5');
});

test("/api/graphql distinguishes query vs mutation", async () => {
  const q = await (await post("/api/graphql", { query: "query { patient { name } }" })).json();
  expect(q.sawMutation).toBe(false);
  expect(q.operation).toBe("query");
  expect(q.data.patient.name).toBe("Ada Lovelace");
  const m = await (await post("/api/graphql", { query: 'mutation { rename(name: "Renamed") { name } }' })).json();
  expect(m.sawMutation).toBe(true);
  expect(m.operation).toBe("mutation");
  expect(m.data.rename.name).toBe("Renamed");
});

test("/api/login sets cookie; /secure.html 302s without it; requireAuth gates /", async () => {
  const anon = await get("/secure.html", { redirect: "manual" });
  expect(anon.status).toBe(302);
  expect(anon.headers.get("location")).toBe("/login.html?next=/secure.html");

  expect((await post("/api/login", { user: "alice", pass: "" })).status).toBe(401);
  const login = await post("/api/login", { user: "alice", pass: "pw" });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("gauntlet_auth=alice");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("HttpOnly");

  const secure = await get("/secure.html", { headers: { cookie: "gauntlet_auth=alice" } });
  expect(secure.status).toBe(200);
  const html = await secure.text();
  expect(html).toContain("<h1>Secure area</h1>");
  expect(html).toContain('<p id="who">Welcome, alice</p>');

  g.ctl.set({ requireAuth: true });
  const gated = await get("/", { redirect: "manual" });
  expect(gated.status).toBe(302);
  expect(gated.headers.get("location")).toBe("/login.html?next=/");
  expect((await get("/", { headers: { cookie: "gauntlet_auth=alice" } })).status).toBe(200);
  g.ctl.reset();
  expect((await get("/", { redirect: "manual" })).status).toBe(200);
});

test("WebSocket: hello, action echo, ctl broadcast, wsPush trigger", async () => {
  const c = wsClient(`ws://localhost:${g.port}/ws`);
  await c.open;
  const hello = await c.next((f) => f.type === "hello");
  expect(hello.state.slowMs).toBe(DEFAULTS.slowMs);

  c.ws.send(JSON.stringify({ type: "action", id: "save", t: 1 }));
  const echo = await c.next((f) => f.type === "echo");
  expect(echo.id).toBe("save");
  expect(echo.t).toBe(1);
  expect(typeof echo.seq).toBe("number");

  await post("/ctl", { slowMs: 77 });
  const ctl = await c.next((f) => f.type === "ctl");
  expect(ctl.state.slowMs).toBe(77);
  expect(ctl.state.xOrigin).toBe(g.xOrigin);

  await post("/ctl", { wsPush: true });
  const push = await c.next((f) => f.type === "push");
  expect(push.n).toBe(1);
  expect((await getJson("/ctl")).wsPush).toBeUndefined(); // write-only, not persisted

  g.ctl.set({ wsPush: true });
  expect((await c.next((f) => f.type === "push")).n).toBe(2);

  g.ctl.reset();
  await c.next((f) => f.type === "ctl" && f.state.slowMs === DEFAULTS.slowMs);
  c.ws.close();
});

test("cross-origin server serves /xframe.html and its submit endpoint only", async () => {
  const x = await fetch(`${g.xOrigin}/xframe.html`);
  expect(x.status).toBe(200);
  expect(x.headers.get("cache-control")).toBe("no-store");
  expect(await x.text()).toContain('id="xf-submit"');
  const sub = await fetch(`${g.xOrigin}/api/xframe-submit`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "zed" }),
  });
  expect(await sub.json()).toEqual({ ok: true, name: "zed", origin: "x" });
  expect((await fetch(`${g.xOrigin}/`)).status).toBe(404);
  expect((await fetch(`${g.xOrigin}/api/slow`)).status).toBe(404);
});

test("remaining JSON endpoints: record, chart, delete, child-ping, grid, heartbeat, iframe-submit", async () => {
  expect((await getJson("/api/record/3")).name).toBe("Grace Hopper");
  expect((await get("/api/record/9")).status).toBe(404);
  expect((await getJson("/api/chart/a")).series).toBe("a");
  expect((await getJson("/api/chart/b")).series).toBe("b");
  expect(await getJson("/api/item/1", { method: "DELETE" })).toEqual({ deleted: 1 });
  expect((await get("/api/item/1")).status).toBe(404); // GET is not a write
  expect(await getJson("/api/child-ping")).toEqual({ pong: true });
  const grid = await getJson("/api/grid");
  expect(grid.cells.length).toBe(32);
  expect(grid.cells[31]).toEqual({ r: 3, c: 7, label: "3,7" });
  const hb1 = await getJson("/api/heartbeat");
  const hb2 = await getJson("/api/heartbeat");
  expect(hb2.n).toBe(hb1.n + 1);
  expect(await (await post("/api/iframe-submit", { name: "bob" })).json()).toEqual({ ok: true, name: "bob" });
});

/** Poll a predicate with a deadline (for buffers filled by background readers). */
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > timeoutMs) throw new Error("until(): condition not met in time");
    await Bun.sleep(10);
  }
}

test("notify push triggers: channel-exclusive delivery, shared n, notifyPollHoldMs", async () => {
  // stand up all three channels first, like the page does at load
  const c = wsClient(`ws://localhost:${g.port}/ws`);
  await c.open;
  await c.next((f) => f.type === "hello");

  const sseRes = await get("/api/notify-sse");
  expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
  const reader = sseRes.body!.getReader();
  const dec = new TextDecoder();
  let sseBuf = "";
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += dec.decode(value);
    }
  })().catch(() => {});
  await until(() => sseBuf.includes(": connected"));

  let pollResult: any = null;
  const pollPromise = getJson("/api/notify-poll").then((j) => { pollResult = j; return j; });
  await Bun.sleep(20); // let the poll request register server-side

  // ws trigger: only the socket hears it
  await post("/ctl", { push: "ws" });
  const wsNotif = await c.next((f) => f.type === "notify");
  expect(wsNotif.via).toBe("ws");
  expect(wsNotif.text).toBe(`Result ${wsNotif.n} via ws`);
  await Bun.sleep(100);
  expect(sseBuf).not.toContain("via ws");
  expect(pollResult).toBeNull();

  // sse trigger: only the EventSource stream hears it
  await post("/ctl", { push: "sse" });
  await until(() => sseBuf.includes("via sse"));
  const sseNotif = JSON.parse(sseBuf.split("data: ").pop()!.split("\n")[0]!);
  expect(sseNotif.via).toBe("sse");
  expect(sseNotif.n).toBe(wsNotif.n + 1); // one monotonic counter across channels
  expect(sseNotif.text).toBe(`Result ${sseNotif.n} via sse`);
  expect(pollResult).toBeNull();

  // poll trigger: resolves the pending long-poll
  await post("/ctl", { push: "poll" });
  const pollNotif = await pollPromise;
  expect(pollNotif.via).toBe("poll");
  expect(pollNotif.n).toBe(sseNotif.n + 1);
  expect(pollNotif.text).toBe(`Result ${pollNotif.n} via poll`);

  // cross-checks: ws got exactly one notify; sse stream saw no ws/poll deliveries
  await expect(c.next((f) => f.type === "notify", 150)).rejects.toThrow();
  expect(sseBuf).not.toContain("via poll");
  // push is write-only: not persisted, and (like wsPush) no ctl broadcast
  expect((await getJson("/ctl")).push).toBeUndefined();
  await expect(c.next((f) => f.type === "ctl", 100)).rejects.toThrow();

  // notifyPollHoldMs (read at request time): short hold -> {n:null}
  g.ctl.set({ notifyPollHoldMs: 200 });
  const t0 = performance.now();
  expect(await getJson("/api/notify-poll")).toEqual({ n: null });
  expect(performance.now() - t0).toBeGreaterThanOrEqual(190);
  g.ctl.reset();

  await reader.cancel().catch(() => {});
  c.ws.close();
});

test("/api/drag-report echoes body + ok", async () => {
  expect(await (await post("/api/drag-report", { widget: "slider", value: 42 })).json())
    .toEqual({ ok: true, widget: "slider", value: 42 });
  expect(await (await post("/api/drag-report", { widget: "sort", order: "b,a,c" })).json())
    .toEqual({ ok: true, widget: "sort", order: "b,a,c" });
});
