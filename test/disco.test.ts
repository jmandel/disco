// The wrapper against the gauntlet. One browser, one gauntlet, sequential tests. Timing assertions
// are the contract: every wait is short and named, and a diagnosis costs about nothing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGauntlet, type GauntletHandle } from "./gauntlet.ts";
import { open, openApp, reached, type Session } from "../src/index.ts";

const appsDir = mkdtempSync(join(process.env.DISCO_TEST_TMP ?? tmpdir(), "disco-apps-"));
let g: GauntletHandle; let s: Session;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

before(async () => { g = await startGauntlet(); s = await open("t", { url: g.origin, appsDir }); });
after(async () => { await s.close({ browser: true }); g.stop(); });

describe("act + report", () => {
  it("no-op click: the window is the whole cost, act overhead is small", async () => {
    const r = await s.click("#noop");
    assert.equal(r.ok, true);
    assert.equal(r.requests.length, 0);
    assert.ok(r.timing.windowMs >= 650 && r.timing.windowMs <= 1000, `window ${r.timing.windowMs}`);
    assert.ok(r.timing.actMs < 400, `act ${r.timing.actMs}`);
    assert.ok(r.timing.totalMs < 1400, `total ${r.timing.totalMs}`);
  });
  it("missing selector → not-found with candidates and a screenshot, no long wait", async () => {
    const r = await s.click("#nope");
    assert.equal(r.ok, false);
    assert.equal(r.diagnosis?.reason, "not-found");
    assert.ok(r.diagnosis!.candidates!.some((c) => c.includes("button#load-chart")), JSON.stringify(r.diagnosis!.candidates));
    assert.equal(r.diagnosis!.shot!.length, 64);
    assert.ok(r.timing.totalMs < 1700, `total ${r.timing.totalMs}`);
    assert.throws(() => reached(r), /not-found/);
  });
  it("disabled control → immediate diagnosis", async () => {
    const r = await s.click("#noop-disabled");
    assert.equal(r.diagnosis?.reason, "disabled");
    assert.ok(r.timing.totalMs < 700, `total ${r.timing.totalMs}`);
  });
  it("modal: until visible; the covered button is diagnosed as occluded with the open dialog named; ack clears it", async () => {
    await g.ctl.set({ modal: true, modalDelayMs: 50 });
    try {
      const r1 = reached(await s.click("#record-2", { until: { selector: "#record-modal", visible: true } }));
      assert.equal(r1.until?.ok, true);
      assert.ok(r1.ui.added.some((l) => l.includes("Allergy Review Required")));
      const r2 = await s.click("#record-3");
      assert.equal(r2.diagnosis?.reason, "occluded");
      assert.match(r2.diagnosis!.over!, /record-modal/);
      assert.match(r2.diagnosis!.dialogs![0], /Allergy/);
      assert.ok(r2.timing.totalMs < 700, `total ${r2.timing.totalMs}`);
      reached(await s.click("#modal-ack", { until: { gone: "#record-modal" } }));
    } finally { await g.ctl.reset(); }
  });
  it("until request landed: proportional to the server, bodies captured", async () => {
    await g.ctl.set({ slowMs: 400 });
    const r = reached(await s.click("#load-chart", { until: { request: "/api/slow", landed: true } }));
    assert.ok(r.until!.elapsedMs >= 380 && r.until!.elapsedMs <= 1500, `elapsed ${r.until!.elapsedMs}`);
    assert.deepEqual(r.requests.map((w) => w.path.split("?")[0]).sort(), ["/api/chart/a", "/api/chart/b", "/api/slow"]);
    await sleep(200);
    const slow = s.store.latestJson<{ ms: number }>("/api/slow", r.action);
    assert.equal(slow?.ms, 400);
    await g.ctl.reset();
  });
  it("a predicate that already holds is flagged", async () => {
    await s.until({ selector: "#chart-status:has-text('idle')" }, { timeout: 2000 });
    const r = await s.click("#load-chart", { until: { selector: "#chart-status:has-text('idle')" } });
    assert.equal(r.until?.ok, true);
    assert.equal(r.until?.alreadyTrue, true);
    reached(await s.until({ request: "/api/slow", landed: true }, { timeout: 3000 }).catch(() => ({ ok: true } as any)));
  });
  it("until that never comes: budget honoured, diagnosis with screenshot", async () => {
    const r = await s.until({ selector: "#never" }, { timeout: 600 });
    assert.equal(r.until?.ok, false);
    assert.ok(r.until!.elapsedMs >= 550 && r.until!.elapsedMs <= 1100, `elapsed ${r.until!.elapsedMs}`);
    assert.equal(r.until?.diagnosis?.reason, "timeout");
    assert.equal(r.until?.diagnosis?.shot?.length, 64);
    assert.throws(() => reached(r), /until failed/);
  });
  it("any-of with labels reports which arm; request bodies are captured", async () => {
    await g.ctl.set({ saveFails: true });
    try {
      const r = reached(await s.click("#save", { until: { any: [{ selector: "#toast[data-kind=ok]", label: "ok" }, { selector: "#toast[data-kind=fail]", label: "fail" }] } }));
      assert.equal(r.until?.which, "fail");
      await sleep(100);
      const post = s.store.requests({ url: "/api/save", method: "POST", action: r.action }).at(-1)!;
      assert.match(post.req_body!, /form/);
      assert.equal(post.status, 202);
      const status = s.store.requests({ url: "/api/save/status", action: r.action }).at(-1)!;
      assert.equal(status.status, 500);
    } finally { await g.ctl.reset(); }
  });
  it("debounced search: type + request landed; the aria diff shows the rows", async () => {
    const r = reached(await s.type("#search", "al", { until: { request: "/api/search", landed: true } }));
    assert.ok(r.ui.added.some((l) => l.includes("Alan Turing")), JSON.stringify(r.ui.added));
  });
  it("keyboard-only combobox: type, ArrowDown, Enter", async () => {
    reached(await s.type("#med", "as", { until: { request: "/api/meds", landed: true } }));
    reached(await s.press("ArrowDown", { target: "#med" }));
    const r = reached(await s.press("Enter", { target: "#med", until: { selector: "#med-selected:has-text('Selected:')" } }));
    assert.ok(r.ui.added.some((l) => l.includes("Selected:")));
  });
  it("shadow DOM: css pierces", async () => {
    reached(await s.click("#shadow-btn", { until: { selector: "#shadow-count:has-text('1')" } }));
  });
  it("same-origin and cross-origin iframes via frame:", async () => {
    reached(await s.fill("#if-name", "Ada", { frame: "#same-origin" }));
    reached(await s.click("#if-submit", { frame: "#same-origin", until: { request: "/api/iframe-submit", landed: true } }));
    reached(await s.fill("#xf-name", "Grace", { frame: "#cross-origin" }));
    const r = reached(await s.click("#xf-submit", { frame: "#cross-origin", until: { request: "/api/xframe-submit", landed: true } }));
    assert.ok(r.requests.some((w) => w.path.includes("/api/xframe-submit") && w.method === "POST"));
  });
  it("native dialogs are handled by policy and reported", async () => {
    const r = reached(await s.click("#confirm"));
    assert.equal(r.dialogs[0]?.type, "confirm");
    assert.equal(r.dialogs[0]?.handled, "accept");
  });
  it("child window: the new page is reported; the driven page is not throttled behind it; closeOtherPages", async () => {
    const r = reached(await s.click("#open-child"));
    assert.ok(r.pages.some((u) => u.includes("/child.html")), JSON.stringify(r.pages));
    assert.equal(r.openPages, 2);
    const r2 = reached(await s.click("#noop", { window: 0 }));
    assert.ok(r2.timing.actMs < 800, `act ${r2.timing.actMs}ms with a popup open (background throttling?)`);
    assert.equal(await s.closeOtherPages(), 1);
    assert.equal(s.context.pages().length, 1);
  });
  it("push channels: WS frames recorded; SSE marked streaming", async () => {
    const dirs = s.store.sql<{ dir: string; n: number }>("SELECT dir, count(*) n FROM ws_frames GROUP BY dir").map((x) => x.dir);
    assert.ok(dirs.includes("open") && dirs.includes("in"), dirs.join());
    assert.equal(s.store.requests({ url: "/api/notify-sse" })[0]?.body_state, "streaming");
  });
  it("login: set-cookie visible in the log; until url", async () => {
    reached(await s.navigate(g.origin + "/login.html"));
    reached(await s.fill("#user", "ada"));
    reached(await s.fill("#pass", "x"));
    const r = reached(await s.click("#login", { until: { url: "/secure.html" } }));
    assert.match(r.url, /secure\.html/);
    await sleep(100);
    const login = s.store.requests({ url: "/api/login", method: "POST" }).at(-1)!;
    assert.match(login.resp_headers!, /set-cookie/i);
    assert.match(login.resp_headers!, /gauntlet_auth=ada/);
    reached(await s.navigate(g.origin, { until: { selector: "#load-chart", visible: true } }));
  });
  it("console errors inside the window are in the report", async () => {
    await s.evaluate("setTimeout(() => { throw new Error('gauntlet-boom') }, 100)");
    const r = await s.until({ selector: "#never" }, { timeout: 400 });
    assert.ok(r.console.some((c) => c.text.includes("gauntlet-boom")), JSON.stringify(r.console));
  });
  it("evaluate returns values; the raw page is there", async () => {
    assert.equal(typeof (await s.evaluate("document.title")), "string");
    assert.equal(await s.page.locator("#noop").count(), 1);
  });
  it("note appends to NOTES.md", async () => {
    s.note("the modal is conditional (act:5)");
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(join(appsDir, "t", "NOTES.md"), "utf8"), /conditional/);
  });
});

describe("round-1 friction", () => {
  it("url predicate ignores the query string: '?next=/secure.html' on the login page is not alreadyTrue", async () => {
    reached(await s.navigate(g.origin + "/login.html?next=/secure.html"));
    reached(await s.fill("#user", "ada"));
    reached(await s.fill("#pass", "x"));
    const r = reached(await s.click("#login", { until: { url: "/secure.html" } }));
    assert.notEqual(r.until?.alreadyTrue, true);
    assert.match(r.url, /\/secure\.html$/);
    reached(await s.navigate(g.origin, { until: { selector: "#load-chart", visible: true } }));
  });
  it("landed on a body the page never reads: bounded at ~1 s, status known, body marked missing", async () => {
    const r = reached(await s.click("#save", { until: { request: "/api/save/status", landed: true } }));
    assert.ok(r.until!.elapsedMs >= 500 && r.until!.elapsedMs <= 2200, `elapsed ${r.until!.elapsedMs}`);
    const w = r.requests.find((x) => x.path.includes("/api/save/status"))!;
    assert.equal(w.status, 200);
    await sleep(1700);
    assert.equal(s.store.requests({ url: "/api/save/status", action: r.action })[0]?.body_state, "missing");
    reached(await s.until({ gone: "#toast" }, { timeout: 4000 }));
  });
  it("a widget the app re-renders every 100 ms: mouse click → detached diagnosis with the hint; js: true lands", async () => {
    const before = await s.evaluate<string>("document.getElementById('rerender-count').textContent");
    const r1 = await s.click("#rerender");
    assert.equal(r1.ok, false);
    assert.equal(r1.diagnosis?.reason, "detached", r1.diagnosis?.message);
    assert.match(r1.diagnosis!.message, /js: true/);
    const r2 = reached(await s.click("#rerender", { js: true, until: { fn: `document.getElementById('rerender-count').textContent !== ${JSON.stringify(before)}` } }));
    assert.equal(r2.until?.ok, true);
  });
  it("a fixed element outside the viewport → offscreen, fast", async () => {
    await s.evaluate("document.body.insertAdjacentHTML('beforeend', '<button id=\"fx\" style=\"position:fixed;top:5000px;left:10px\">fx</button>')");
    const r = await s.click("#fx");
    assert.equal(r.diagnosis?.reason, "offscreen", r.diagnosis?.message);
    assert.match(r.diagnosis!.message, /position: fixed/);
    assert.ok(r.timing.totalMs < 900, `total ${r.timing.totalMs}`);
    await s.evaluate("document.getElementById('fx').remove()");
  });
  it("an element with pointer-events: none → unclickable, fast, with the keyboard hint", async () => {
    reached(await s.type("#med", "as", { until: { request: "/api/meds" } }));
    const r = await s.click("#med-list li >> nth=0");
    assert.equal(r.diagnosis?.reason, "unclickable", r.diagnosis?.message);
    assert.match(r.diagnosis!.message, /keyboard/);
    assert.ok(r.timing.totalMs < 900, `total ${r.timing.totalMs}`);
    reached(await s.press("Escape", { target: "#med" }));
  });
  it("drag: the slider thumb moves and the drag report is posted", async () => {
    const r = reached(await s.drag("#slider-thumb", "#slider-track", { until: { request: "/api/drag-report" } }));
    assert.ok(r.requests.some((w) => w.path.includes("/api/drag-report") && w.method === "POST"));
  });
});

describe("the log without a browser", () => {
  it("openApp reads what was recorded", async () => {
    const st = openApp("t", appsDir);
    assert.ok(st.requests({ url: "/api/record/2" }).length >= 1);
    assert.equal(st.latestJson<{ name: string }>("/api/record/2")?.name, "Alan Turing");
    assert.ok(st.action("act:1")?.report);
    st.close();
  });
});
