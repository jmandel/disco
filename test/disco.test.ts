// The surface against the gauntlet. One browser, one gauntlet, sequential tests. Timing assertions are the
// contract: every wait is bounded by max, a diagnosis costs about max and no more, a bare act costs quiet.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGauntlet, type GauntletHandle } from "./gauntlet.ts";
import { open, reached, type Session } from "../src/index.ts";

const appsDir = mkdtempSync(join(process.env.DISCO_TEST_TMP ?? tmpdir(), "disco-apps-"));
let g: GauntletHandle; let s: Session;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
// a navigation's postcondition: the nav event (false before, true after — even when the page was already there), then the anchor
const home = async () => reached(await s.act("home", (p) => p.goto(g.origin), { until: () => s.waitFor("nav", (e) => e.url.startsWith(g.origin)).then(() => s.page.locator("#load-chart").waitFor()), max: 8000 }));

before(async () => { g = await startGauntlet(); s = await open("t", { url: g.origin, appsDir }); });
after(async () => { await s.close({ browser: true }); g.stop(); });

describe("act + report: the promise table", () => {
  it("a bare act costs quiet and little else, and says why it returned", async () => {
    const r = await s.act("noop", (p) => p.click("#noop"));
    assert.equal(r.ok, true);
    assert.equal(r.returned, "quiet");
    assert.equal(r.requests.length, 0);
    assert.ok(r.timing.observeMs >= 480 && r.timing.observeMs <= 1000, `observe ${r.timing.observeMs}`);
    assert.ok(r.timing.runMs < 400, `run ${r.timing.runMs}`);
    assert.ok(r.timing.totalMs < 1300, `total ${r.timing.totalMs}`);
    assert.equal(typeof String(r), "string"); assert.match(String(r), /returned: quiet/);
  });
  it("missing selector → not-found within max, with candidates that paste and a shot", async () => {
    const r = await s.act("nope", (p) => p.click("#nope"), { max: 700 });
    assert.equal(r.ok, false); assert.equal(r.returned, "error");
    assert.equal(r.diagnosis?.reason, "not-found");
    assert.equal(r.diagnosis?.selector, "locator('#nope')");
    assert.ok(r.diagnosis!.candidates!.some((c) => c.startsWith("#load-chart")), JSON.stringify(r.diagnosis!.candidates));
    assert.equal(await s.page.locator(r.diagnosis!.candidates![0].split("  (")[0]).count(), 1, "the first candidate pastes as a selector");
    assert.ok(existsSync(r.diagnosis!.shot!), "diagnosis shot exists");
    assert.ok(r.timing.totalMs < 1500, `total ${r.timing.totalMs}`);
    assert.throws(() => reached(r), /not-found/);
  });
  it("disabled control → diagnosed within max", async () => {
    const r = await s.act("disabled", (p) => p.click("#noop-disabled"), { max: 700 });
    assert.equal(r.diagnosis?.reason, "disabled");
    assert.ok(r.timing.totalMs < 1500, `total ${r.timing.totalMs}`);
  });
  it("modal: until visible; the covered button is diagnosed occluded with the open dialog named; ack clears it", async () => {
    await g.ctl.set({ modal: true, modalDelayMs: 50 });
    try {
      const r1 = reached(await s.act("open record 2", (p) => p.click("#record-2"), { until: () => s.page.locator("#record-modal").waitFor() }));
      assert.equal(r1.returned, "until");
      assert.ok(r1.ui.added.some((l) => l.includes("Allergy Review Required")));
      assert.ok(r1.proposed.some((p) => p.code.includes('"dialog"') && p.code.includes("Allergy Review Required")), JSON.stringify(r1.proposed));
      const r2 = await s.act("click under the modal", (p) => p.click("#record-3"), { max: 700 });
      assert.equal(r2.diagnosis?.reason, "occluded");
      assert.match(r2.diagnosis!.over!, /record-modal/);
      assert.match(r2.diagnosis!.dialogs![0], /Allergy/);
      assert.ok(r2.timing.totalMs < 1500, `total ${r2.timing.totalMs}`);
      reached(await s.act("ack", (p) => p.click("#modal-ack"), { until: () => s.page.locator("#record-modal").waitFor({ state: "hidden" }) }));
    } finally { await g.ctl.reset(); }
  });
  it("until a response: returns when it lands, proportional to the server; json() reads the body", async () => {
    await g.ctl.set({ slowMs: 400 });
    try {
      const r = reached(await s.act("load chart", (p) => p.click("#load-chart"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/slow")) }));
      assert.equal(r.returned, "until");
      assert.ok(r.until!.elapsedMs >= 380 && r.until!.elapsedMs <= 1500, `elapsed ${r.until!.elapsedMs}`);
      assert.deepEqual(r.requests.map((w) => w.path.split("?")[0]).sort(), ["/api/chart/a", "/api/chart/b", "/api/slow"]);
      assert.ok(r.proposed.some((p) => p.kind === "response" && p.code.includes("/api/slow") && p.atMs! >= 300), JSON.stringify(r.proposed));
      const slow = await s.json<{ ms: number }>("/api/slow", { action: r.action });
      assert.equal(slow?.ms, 400);
    } finally { await g.ctl.reset(); }
  });
  it("a until that already held is flagged and refused by reached", async () => {
    const r = await s.act("already", (p) => p.click("#noop"), { until: () => s.page.locator("#load-chart").waitFor() });
    assert.equal(r.until?.ok, true); assert.equal(r.until?.alreadyTrue, true);
    assert.throws(() => reached(r), /already true/);
  });
  it("a until that never comes costs max and no more, with the Playwright error", async () => {
    const r = await s.act("wait for never", async () => {}, { until: () => s.page.locator("#never").waitFor(), max: 600 });
    assert.equal(r.ok, true); assert.equal(r.returned, "max"); assert.equal(r.until?.ok, false);
    assert.match(r.until!.error!, /Timeout/);
    assert.ok(r.timing.totalMs >= 550 && r.timing.totalMs <= 1400, `total ${r.timing.totalMs}`);
    assert.throws(() => reached(r), /until failed/);
  });
  it("Promise.race arms: until.value says which; the wire has the write and its status", async () => {
    await g.ctl.set({ saveFails: true });
    try {
      const r = reached(await s.act("save", (p) => p.click("#save"), { until: () => Promise.race([s.page.locator("#toast[data-kind=ok]").waitFor().then(() => "ok"), s.page.locator("#toast[data-kind=fail]").waitFor().then(() => "fail")]) }));
      assert.equal(r.until?.value, "fail");
      assert.ok(r.writes.some((w) => w.startsWith("POST /api/save 202")), JSON.stringify(r.writes));
      await sleep(200);
      const status = s.sql<{ status: number }>("SELECT status FROM requests WHERE url LIKE '%/api/save/status%' AND action_id=? ORDER BY t_start DESC LIMIT 1", r.action)[0];
      assert.equal(status?.status, 500);
      await s.act("toast gone", async () => {}, { until: () => s.page.locator("#toast").waitFor({ state: "hidden" }), max: 4000 });
    } finally { await g.ctl.reset(); }
  });
  it("debounced search: keystrokes + a DOM until; the diff shows the rows", async () => {
    const r = reached(await s.act("search", (p) => p.locator("#search").pressSequentially("al", { delay: 15 }), { until: () => s.page.locator("#s-7").getByText("Alan Turing").waitFor() }));
    assert.ok(r.requests.some((w) => w.path.includes("/api/search")), JSON.stringify(r.requests));
    assert.ok(r.ui.added.some((l) => l.includes("Alan Turing")), JSON.stringify(r.ui.added));
  });
  it("keyboard-only combobox: keystrokes, ArrowDown, Enter", async () => {
    reached(await s.act("type med", (p) => p.locator("#med").pressSequentially("as", { delay: 15 }), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/meds")) }));
    reached(await s.act("down", (p) => p.press("#med", "ArrowDown")));
    const r = reached(await s.act("enter", (p) => p.press("#med", "Enter"), { until: () => s.page.locator("#med-selected:has-text('Selected:')").waitFor() }));
    assert.ok(r.ui.added.some((l) => l.includes("Selected:")));
  });
  it("shadow DOM: css pierces", async () => {
    reached(await s.act("shadow", (p) => p.click("#shadow-btn"), { until: () => s.page.locator("#shadow-count:has-text('1')").waitFor() }));
  });
  it("same-origin and cross-origin iframes via frameLocator", async () => {
    reached(await s.act("if name", (p) => p.frameLocator("#same-origin").locator("#if-name").fill("Ada")));
    reached(await s.act("if submit", (p) => p.frameLocator("#same-origin").locator("#if-submit").click(), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/iframe-submit")) }));
    reached(await s.act("xf name", (p) => p.frameLocator("#cross-origin").locator("#xf-name").fill("Grace")));
    const r = reached(await s.act("xf submit", (p) => p.frameLocator("#cross-origin").locator("#xf-submit").click(), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/xframe-submit")) }));
    assert.ok(r.requests.some((w) => w.path.includes("/api/xframe-submit") && w.method === "POST"));
  });
  it("native dialogs are accepted and reported", async () => {
    const r = reached(await s.act("confirm", (p) => p.click("#confirm")));
    assert.equal(r.dialogs[0]?.type, "confirm"); assert.equal(r.dialogs[0]?.handled, "accept");
  });
  it("child window: reported, waitFor('page') works, the driven page is not throttled behind it", async () => {
    const r = reached(await s.act("open child", (p) => p.click("#open-child"), { until: () => s.waitFor("page", (e) => e.url.includes("/child.html")) }));
    assert.equal(r.openPages, 2);
    const r2 = reached(await s.act("noop with popup", (p) => p.click("#noop"), { quiet: 100 }));
    assert.ok(r2.timing.runMs < 800, `run ${r2.timing.runMs}ms with a popup open (background throttling?)`);
    for (const p of s.context.pages()) if (p !== s.page) await p.close();
    assert.equal(s.context.pages().length, 1);
  });
  it("push channels: WS frames recorded, waitFor('ws') sees a pushed frame, SSE marked streaming", async () => {
    const dirs = s.sql<{ dir: string }>("SELECT DISTINCT dir FROM ws_frames").map((x) => x.dir);
    assert.ok(dirs.includes("open") && dirs.includes("in"), dirs.join());
    const r = reached(await s.act("push", () => g.ctl.set({ wsPush: true }), { until: () => s.waitFor("ws", (f) => f.payload.includes("push")) }));
    assert.equal(r.returned, "until");
    await assert.rejects(() => s.waitFor("ws", () => false, 300), /nothing matched/);
    assert.equal(s.sql<{ body_state: string }>("SELECT body_state FROM requests WHERE url LIKE '%/api/notify-sse%' LIMIT 1")[0]?.body_state, "streaming");
  });
  it("login: HttpOnly set-cookie shows in the storage line; url until; proposals use the pathname", async () => {
    reached(await s.act("go login", (p) => p.goto(g.origin + "/login.html?next=/secure.html"), { until: () => s.page.locator("#login").waitFor(), max: 8000 }));
    reached(await s.act("user", (p) => p.fill("#user", "ada"), { quiet: 50 }));
    reached(await s.act("pass", (p) => p.fill("#pass", "x"), { quiet: 50 }));
    const r = reached(await s.act("log in", (p) => p.click("#login"), { until: () => s.page.waitForURL((u) => u.pathname.includes("/secure.html")) }));
    assert.match(r.url, /secure\.html/);
    assert.ok(r.storage.cookies.some((c) => c.startsWith("+gauntlet_auth=")), JSON.stringify(r.storage));
    assert.ok(r.proposed.some((p) => p.kind === "url" && p.code.includes("/secure.html")), JSON.stringify(r.proposed));
    await sleep(100);
    const login = s.sql<{ resp_headers: string }>("SELECT resp_headers FROM requests WHERE url LIKE '%/api/login%' AND method='POST' ORDER BY t_start DESC LIMIT 1")[0];
    assert.match(login.resp_headers, /set-cookie/i);
    await home();
  });
  it("console errors inside the window are in the report", async () => {
    await s.page.evaluate("setTimeout(() => { throw new Error('gauntlet-boom') }, 100)");
    const r = await s.act("wait", async () => {}, { until: () => s.page.locator("#never").waitFor(), max: 400 });
    assert.ok(r.console.some((c) => c.text.includes("gauntlet-boom")), JSON.stringify(r.console));
  });
  it("a page that never goes quiet returns at max and says so, with what is in flight", async () => {
    await g.ctl.set({ slowMs: 2500 });
    try {
      const r = reached(await s.act("slow chart", (p) => p.click("#load-chart"), { max: 900 }));
      assert.equal(r.returned, "max");
      assert.ok(r.pending.some((p) => p.includes("/api/slow")), JSON.stringify(r.pending));
      assert.match(String(r), /still changing/);
      await s.act("drain", async () => {}, { until: () => s.page.locator("#chart:has-text('Chart loaded')").waitFor(), max: 4000 });
    } finally { await g.ctl.reset(); }
  });
});

describe("what the real apps taught (gauntlet sections 29–33)", () => {
  it("skeleton table: structure satisfies a structural until at once; quiet-return waits for the data", async () => {
    const r1 = reached(await s.act("load people", (p) => p.click("#load-people"), { until: () => s.page.locator("#people tbody tr").nth(3).waitFor() }));
    assert.ok(r1.until!.elapsedMs < 400, `the skeleton satisfied the structural wait in ${r1.until!.elapsedMs}ms`);
    assert.equal(await s.page.locator("#people-title").textContent(), "--");
    await s.act("data", async () => {}, { until: () => s.page.locator("#people-title:has-text('People (')").waitFor(), max: 3000 });
    await home();
    const r2 = reached(await s.act("load people again", (p) => p.click("#load-people"), { max: 4000 }));
    assert.equal(r2.returned, "quiet");
    assert.ok(r2.ui.added.some((l) => l.includes("People (6)")), JSON.stringify(r2.ui.added));
    assert.ok(r2.proposed.some((p) => p.code.includes("/api/people")), JSON.stringify(r2.proposed));
  });
  it("cached revisit: the second visit issues no request; a state proposal (selected) is offered instead", async () => {
    reached(await s.act("tab a", (p) => p.click("#tab-a"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/tab/a")) }));
    reached(await s.act("tab b", (p) => p.click("#tab-b"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/tab/b")) }));
    const r = await s.act("tab a again", (p) => p.click("#tab-a"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/tab/a")), max: 800 });
    assert.equal(r.until?.ok, false); assert.equal(r.returned, "max");
    assert.ok(!r.requests.some((w) => w.path.includes("/api/tab")), "no request on a cached revisit");
    const bare = reached(await s.act("tab b again", (p) => p.click("#tab-b")));
    assert.ok(bare.proposed.some((p) => p.code.includes('"tab"') && p.code.includes("selected: true")), JSON.stringify(bare.proposed));
    assert.ok(!bare.proposed.some((p) => p.code.includes('"tab"') && !p.code.includes("selected")), "a tab that existed before is not proposed without its new state");
  });
  it("stacked panels: what you leave is the postcondition; the arriving element was already there", async () => {
    reached(await s.act("open panel", (p) => p.click("#open-panel"), { until: () => s.page.locator("#panel-next").waitFor() }));
    reached(await s.act("next", (p) => p.click("#panel-next"), { until: () => s.page.locator("#panel-2").waitFor() }));
    const wrong = await s.act("back (wrong until)", (p) => p.click("#panel-back"), { until: () => s.page.locator("#panel-next").waitFor() });
    assert.equal(wrong.until?.alreadyTrue, true);
    assert.ok(wrong.proposed.some((p) => p.kind === "gone" && p.code.includes("Panel 2")), JSON.stringify(wrong.proposed));
    reached(await s.act("next again", (p) => p.click("#panel-next"), { until: () => s.page.locator("#panel-2").waitFor() }));
    reached(await s.act("back", (p) => p.click("#panel-back"), { until: () => s.page.locator("#panel-2").waitFor({ state: "hidden" }) }));
    reached(await s.act("close panel", (p) => p.click("#panel-close"), { until: () => s.page.locator("#panel-1").waitFor({ state: "hidden" }) }));
  });
  it("styled radio: a real click on the input is diagnosed as a styled control, not a dialog; the label works", async () => {
    const r = await s.act("click hidden input", (p) => p.click("#sev-mild"), { max: 800 });
    assert.equal(r.ok, false);
    assert.equal(r.diagnosis?.reason, "occluded");
    assert.match(r.diagnosis!.message, /styled control/);
    assert.doesNotMatch(r.diagnosis!.message, /dismiss the dialog/);
    reached(await s.act("click label", (p) => p.click("label:has-text('Mild')"), { until: () => s.page.locator("#sev-value:has-text('Mild')").waitFor() }));
    const l = await s.look("#sev-severe");
    assert.match(l.matches![0].why ?? "", /styled control/);
  });
  it("blocking submit: a click whose handler holds the main thread past max still counts, and the note says so", async () => {
    const r = await s.act("slow submit", (p) => p.click("#slow-submit"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/slow-submit"), { timeout: 8000 }), max: 3000 });
    assert.equal(r.ok, true, r.diagnosis?.message);
    assert.match(r.note ?? "", /blocked the main thread/);
    assert.equal(r.returned, "max");
    await s.act("drain", async () => {}, { until: () => s.page.locator("#slow-result:has-text('Submitted')").waitFor(), max: 6000 });
    const r2 = reached(await s.act("slow submit with room", (p) => p.click("#slow-submit"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/slow-submit")), max: 6000 }));
    assert.equal(r2.until?.ok, true); assert.equal(r2.note, undefined);
  });
  it("a body the page never reads: the until on the response is fast; finished() cannot resolve and the note says why", async () => {
    const r = reached(await s.act("save", (p) => p.click("#save"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/save/status")) }));
    assert.ok(r.until!.elapsedMs < 1500);
    await s.act("toast gone", async () => {}, { until: () => s.page.locator("#toast").waitFor({ state: "hidden" }), max: 4000 });
    const r2 = await s.act("save + finished", (p) => p.click("#save"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/save/status")).then((x) => x.finished()), max: 2500 });
    assert.equal(r2.until?.ok, false);
    assert.match(r2.note ?? "", /never read its body/);
    await sleep(300);
    assert.equal(s.sql<{ body_state: string }>("SELECT body_state FROM requests WHERE url LIKE '%/api/save/status%' AND action_id=?", r2.action)[0]?.body_state, "missing");
    await s.act("toast gone", async () => {}, { until: () => s.page.locator("#toast").waitFor({ state: "hidden" }), max: 4000 });
  });
});

describe("diagnoses the wrapper used to make itself", () => {
  it("a widget re-rendered every 100 ms: detached with the dispatchEvent hint; dispatchEvent lands", async () => {
    const before = await s.page.evaluate<string>("document.getElementById('rerender-count').textContent");
    const r1 = await s.act("rerender", (p) => p.click("#rerender"), { max: 1200 });
    assert.equal(r1.ok, false);
    assert.equal(r1.diagnosis?.reason, "detached", r1.diagnosis?.message);
    assert.match(r1.diagnosis!.message, /dispatchEvent/);
    reached(await s.act("rerender js", (p) => p.locator("#rerender").dispatchEvent("click"), { until: () => s.page.waitForFunction((b) => document.getElementById("rerender-count")!.textContent !== b, before) }));
  });
  it("a fixed element outside the viewport → offscreen, with the reason", async () => {
    await s.page.evaluate("document.body.insertAdjacentHTML('beforeend', '<button id=\"fx\" style=\"position:fixed;top:5000px;left:10px\">fx</button>')");
    const r = await s.act("fx", (p) => p.click("#fx"), { max: 700 });
    assert.equal(r.diagnosis?.reason, "offscreen", r.diagnosis?.message);
    assert.match(r.diagnosis!.message, /position: fixed/);
    await s.page.evaluate("document.getElementById('fx').remove()");
  });
  it("pointer-events: none → unclickable, with the keyboard hint", async () => {
    reached(await s.act("type med", (p) => p.locator("#med").pressSequentially("as", { delay: 15 }), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/meds")) }));
    const r = await s.act("click option", (p) => p.click("#med-list li >> nth=0"), { max: 700 });
    assert.equal(r.diagnosis?.reason, "unclickable", r.diagnosis?.message);
    assert.match(r.diagnosis!.message, /keyboard/);
    reached(await s.act("esc", (p) => p.press("#med", "Escape"), { quiet: 100 }));
  });
  it("drag: the slider moves and the report is posted", async () => {
    const r = reached(await s.act("drag", (p) => p.locator("#slider-thumb").dragTo(p.locator("#slider-track")), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/drag-report")) }));
    assert.ok(r.requests.some((w) => w.path.includes("/api/drag-report") && w.method === "POST"));
  });
  it("a long-poll that answers inside the window is attributed as started earlier", async () => {
    await g.ctl.set({ ambient: true, pollHoldMs: 400, heartbeatMs: 60000 });
    try {
      await home();
      const r = reached(await s.act("poll", async () => {}, { until: () => s.waitFor("response", (e) => e.url.includes("/api/poll")), max: 4000 }));
      assert.ok(r.requests.some((w) => w.path.includes("/api/poll")), JSON.stringify(r.requests));
    } finally { await g.ctl.reset(); await home(); }
  });
  it("a probe is an act: page.evaluate(fetch) is attributed, the value comes back, json reads the write by method", async () => {
    const r = reached(await s.act("probe", (p) => p.evaluate("fetch('/api/save', { method: 'POST', body: '{}' }).then(r => r.json()).then(j => j.id)")));
    assert.equal(typeof r.value, "number");
    assert.ok(r.writes.some((w) => w.startsWith("POST /api/save")), JSON.stringify(r.writes));
    const posted = await s.json<{ id: number }>("/api/save", { action: r.action, method: "POST" });
    assert.ok(posted && typeof posted.id === "number", JSON.stringify(posted));
  });
  it("a second session joins the browser and the run, sees frames on a socket it did not open, and does not reload the page", async () => {
    await g.ctl.set({ modal: true, modalDelayMs: 0 });
    try {
      reached(await s.act("open record 5", (p) => p.click("#record-5"), { until: () => s.page.locator("#record-modal").waitFor() }));
      const s2 = await open("t", { url: g.origin, appsDir });
      try {
        assert.equal(s2.run, s.run);
        assert.equal(await s2.page.locator("#record-modal").count(), 1, "open({url}) reloaded a page that was already there");
        const r = reached(await s2.act("push", () => g.ctl.set({ wsPush: true }), { until: () => s2.waitFor("ws", (f) => f.payload.includes("push")) }));
        assert.equal(r.until?.ok, true);
      } finally { await s2.close(); }
      reached(await s.act("ack", (p) => p.click("#modal-ack"), { until: () => s.page.locator("#record-modal").waitFor({ state: "hidden" }) }));
    } finally { await g.ctl.reset(); }
  });
});

describe("look", () => {
  it("the screen: aria, numbered controls with durable selectors, a marked-up JPEG", async () => {
    const t = performance.now();
    const l = await s.look();
    const ms = performance.now() - t;
    assert.match(l.aria!, /button "Load Chart"/);
    assert.ok(l.controls!.some((c) => c.selector === "#load-chart" && c.role === "button" && c.name === "Load Chart"), JSON.stringify(l.controls!.slice(0, 5)));
    assert.ok(l.controls!.every((c) => c.box.w > 0 && c.box.h > 0));
    assert.ok(existsSync(l.shot!), "shot exists");
    const bytes = readFileSync(l.shot!); assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
    assert.ok(ms < 3000, `look took ${ms}ms`);
    assert.equal(s.context.pages().length, 1, "the scratch page is closed again");
  });
  it("a selector: matches with visibility and what is under the pointer; hidden, none, and a parse error", async () => {
    const one = await s.look("#load-chart");
    assert.equal(one.count, 1); assert.equal(one.matches![0].visible, true); assert.equal(one.matches![0].under, null);
    const hidden = await s.look("#ctx-menu");
    assert.equal(hidden.matches![0].visible, false);
    const none = await s.look("#never");
    assert.equal(none.count, 0); assert.match(none.note!, /nothing matches/);
    const bad = await s.look("role=button[name='x'] svg, #broken[");
    assert.match(bad.error!, /selector error/);
    const many = await s.look("button");
    assert.ok(many.count! > 10); assert.equal(many.matches!.length, 10); assert.match(many.note!, /several match/);
  });
  it("controls inside a frame via a Locator", async () => {
    const l = await s.look(s.page.frameLocator("#same-origin").locator("#if-name"));
    assert.equal(l.count, 1);
  });
});

describe("ceilings on a large page", () => {
  it("10,000 real rows: a bare act's report overhead stays bounded; look stays bounded", async () => {
    reached(await s.act("big", (p) => p.goto(g.origin + "/big.html"), { until: () => s.page.locator("#big-btn").waitFor(), max: 15000 }));
    const r = reached(await s.act("count", (p) => p.click("#big-btn")));
    console.log(`    big page: run ${r.timing.runMs} observe ${r.timing.observeMs} report ${r.timing.reportMs} total ${r.timing.totalMs} ms; ui +${r.ui.added.length}`);
    assert.ok(r.ui.added.some((l) => l.includes("10000")), JSON.stringify(r.ui.added));
    assert.ok(r.timing.reportMs < 2500, `report ${r.timing.reportMs}ms`);
    assert.ok(r.timing.observeMs < 2000, `observe ${r.timing.observeMs}ms`);
    const t = performance.now(); const l = await s.look(); const lookMs = performance.now() - t;
    console.log(`    big page: look ${Math.round(lookMs)} ms, ${l.controls!.length} controls`);
    assert.ok(lookMs < 6000, `look ${lookMs}ms`);
    await home();
  });
});

describe("exam A fold-backs", () => {
  it("open({url}) navigates as its own act and returns quiet; a nav until right after is not already true", async () => {
    reached(await s.act("go login", (p) => p.goto(g.origin + "/login.html"), { until: () => s.waitFor("nav", (e) => e.url.includes("/login.html")), max: 8000 }));
    const s2 = await open("t", { url: g.origin, appsDir });
    try {
      assert.equal(s2.opened, "navigated");
      const last = s2.sql<{ label: string; report: string }>("SELECT label, report FROM actions ORDER BY n DESC LIMIT 1")[0];
      assert.match(last.label, /^open /); assert.equal(JSON.parse(last.report).returned, "quiet");
      const r = reached(await s2.act("login page", (p) => p.goto(g.origin + "/login.html"), { until: () => s2.waitFor("nav", (e) => e.url.includes("/login.html")).then(() => s2.page.locator("#login").waitFor()), max: 8000 }));
      assert.notEqual(r.until?.alreadyTrue, true);
    } finally { await s2.close(); }
    await home();
  });
  it("a popup left open does not become the driven page of the next session", async () => {
    reached(await s.act("open child", (p) => p.click("#open-child"), { until: () => s.waitFor("page", (e) => e.url.includes("/child.html")) }));
    const s2 = await open("t", { appsDir });
    try { assert.equal(new URL(s2.page.url()).pathname, "/"); assert.equal(s2.opened, "joined"); } finally { await s2.close(); }
    for (const p of s.context.pages()) if (p !== s.page) await p.close();
  });
  it("until.value keeps a JSON object", async () => {
    const r = reached(await s.act("push", () => g.ctl.set({ wsPush: true }), { until: () => s.waitFor("ws", (f) => f.payload.includes("push")) }));
    assert.match((r.until!.value as any).payload, /push/);
  });
  it("code that touches document in Node is diagnosed with the page.evaluate hint", async () => {
    const r = await s.act("dom in node", async () => document.title, { max: 500 });
    assert.equal(r.ok, false); assert.match(r.diagnosis!.message, /runs in Node/);
  });
  it("an already-true until names its target's state; a failed response until lists what answered just before", async () => {
    const r = await s.act("already", (p) => p.click("#noop"), { until: () => s.page.locator("#load-chart").waitFor() });
    assert.equal(r.until?.alreadyTrue, true);
    assert.match(r.note ?? "", /the until's target locator\("#load-chart"\): 1 match now; the first is visible/);
    const ta = reached(await s.act("tab a", (p) => p.click("#tab-a"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/tab/a")) }));
    assert.ok(String(ta).indexOf("proposed until") > 0 && String(ta).indexOf("proposed until") < String(ta).indexOf("wire ("), "proposals print before the wire");
    reached(await s.act("tab b", (p) => p.click("#tab-b")));
    const again = await s.act("tab a again", (p) => p.click("#tab-a"), { until: () => s.page.waitForResponse((x) => x.url().includes("/api/tab/a")), max: 800 });
    assert.equal(again.until?.ok, false);
    assert.match(again.note ?? "", /BEFORE this act.*\/api\/tab\/a 200/);
  });
  it("a text-only change proposes a page-text until that holds; a reorder without additions is noted", async () => {
    const r = reached(await s.act("dblclick", (p) => p.dblclick("#dbl-target")));
    const p = r.proposed.find((x) => x.code.includes("waitForFunction") && x.code.includes("editing"));
    assert.ok(p, JSON.stringify(r.proposed));
    const fn = new Function("page", `return (${p!.code})`)(s.page) as () => Promise<unknown>;
    await fn();
    reached(await s.act("commit", (p) => p.press("#dbl-input", "Enter"), { until: () => s.page.locator("#dbl-state:has-text('committed')").waitFor() }));
    const swap = reached(await s.act("swap items", (p) => p.evaluate(() => { const l = document.getElementById("sort-list")!; l.appendChild(l.firstElementChild!); })));
    assert.match(swap.note ?? "", /lines moved/);
  });
  it("third-party requests are folded out of writes and do not block quiet", async () => {
    const port = new URL(g.origin).port;
    const r = reached(await s.act("telemetry", (p) => p.evaluate((u) => fetch(u, { method: "POST", mode: "no-cors", body: "{}" }).then(() => 1), `http://127.0.0.1:${port}/api/save`)));
    assert.ok(r.thirdParty.count >= 1, JSON.stringify(r.thirdParty));
    assert.deepEqual(r.writes, []);
    assert.match(String(r), /third-party \(127\.0\.0\.1/);
  });
  it("look lists anchors without href, tabindex targets and shadow-DOM buttons; an unnamed dialog is marked", async () => {
    await s.page.evaluate("document.body.insertAdjacentHTML('beforeend', '<a id=\"nohref\" onclick=\"1\">cart</a><div id=\"tabby\" tabindex=\"0\">t</div>')");
    const l = await s.look();
    const sels = l.controls!.map((c) => c.selector);
    assert.ok(sels.includes("#nohref"), sels.join(","));
    assert.ok(sels.includes("#tabby"), sels.join(","));
    assert.ok(sels.includes("#shadow-btn"), sels.join(","));
    assert.match(l.shot!, /\.jpg$/);
    assert.ok(s.sql("SELECT url FROM shots WHERE url IS NOT NULL LIMIT 1").length > 0);
    await s.page.evaluate("document.getElementById('nohref').remove(); document.getElementById('tabby').remove()");
    await g.ctl.set({ timeoutMs: 300 });
    try {
      await s.act("wait for the session dialog", async () => {}, { until: () => s.page.locator("#session-timeout").waitFor(), max: 4000 });
      const d = await s.look("#session-timeout");
      assert.match(d.dialogs[0], /session-timeout .*\(unnamed/);
      reached(await s.act("stay", (p) => p.locator("#session-timeout button").first().click(), { until: () => s.page.locator("#session-timeout").waitFor({ state: "hidden" }) }));
    } finally { await g.ctl.reset(); }
  });
  it("json prefers a path-boundary match over a longer sibling", async () => {
    reached(await s.act("record 1", (p) => p.evaluate(() => fetch("/api/record/1").then((r) => r.json()))));
    reached(await s.act("record 12", (p) => p.evaluate(() => fetch("/api/record/12").then((r) => r.json()))));
    const j = await s.json<{ id: number }>("/api/record/1");
    assert.equal(j?.id, 1, JSON.stringify(j));
  });
});

describe("the log", () => {
  it("sql errors name the columns; body returns a blob by prefix", async () => {
    assert.throws(() => s.sql("SELECT id FROM ws_frames"), /no such column: id — ws_frames\(run, seq, t, url, dir, payload, action_id\)/);
    const row = s.sql<{ body_hash: string }>("SELECT body_hash FROM requests WHERE url LIKE '%/api/record/5%' AND body_hash IS NOT NULL LIMIT 1")[0];
    assert.match(s.body(row.body_hash.slice(0, 16)), /Grace|Alan|Ada|name/);
    assert.ok(s.sql<{ n: number }>("SELECT count(*) n FROM actions WHERE code LIKE '%click%'")[0].n > 5, "the code of each act is stored");
  });
});
