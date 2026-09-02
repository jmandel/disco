// The CLI and the pack convention, as a stranger would run them.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startGauntlet, type GauntletHandle } from "./gauntlet.ts";

const root = join(import.meta.dirname, "..");
const appsDir = mkdtempSync(join(process.env.DISCO_TEST_TMP ?? tmpdir(), "disco-cli-"));
let g: GauntletHandle;
const disco = (...args: string[]) => {
  const r = spawnSync("node", [join(root, "cli/disco.ts"), ...args], { cwd: root, env: { ...process.env, DISCO_APPS_DIR: appsDir }, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
};

before(async () => { g = await startGauntlet(); });
after(async () => { disco("close", "c"); g.stop(); });

describe("cli", () => {
  it("open → act → act --until → look → sql → close", async () => {
    const o = disco("open", "c", g.origin);
    assert.equal(o.code, 0, o.out);
    assert.match(o.out, /run 1/); assert.match(o.out, /navigated to|joined at/); assert.match(o.out, /recording: pid \d+/);
    const flag = disco("sql", "--json", "SELECT 1 n");
    assert.equal(flag.code, 0, flag.out); assert.equal(JSON.parse(flag.stdout)[0].n, 1);
    const long = disco("act", 'page.evaluate(() => "x".repeat(1000))');
    assert.match(long.out, /clipped, 1000 chars/);
    // the detached recorder captures what the page does BETWEEN commands
    const armed = disco("act", 'page.evaluate(() => { setTimeout(() => fetch("/api/chart/b"), 700); return "armed"; })', "--quiet", "50");
    assert.equal(armed.code, 0, armed.out); assert.match(armed.out, /value: armed/);
    await new Promise((r) => setTimeout(r, 1800));
    const between = disco("sql", "SELECT count(*) n FROM requests WHERE path='/api/chart/b' AND action_id IS NULL");
    assert.match(between.out, /\n1/, "between: " + between.out);
    const c = disco("act", 'page.click("#noop")', "--json");
    assert.equal(c.code, 0, c.out);
    const rep = JSON.parse(c.stdout);
    assert.equal(rep.ok, true); assert.equal(rep.returned, "quiet"); assert.match(rep.action, /^act:\d+$/);
    const t = disco("act", 'page.click("#load-chart")', "--until", 'page.waitForResponse(r => r.url().includes("/api/slow"))', "--label", "load chart");
    assert.equal(t.code, 0, t.out);
    assert.match(t.out, /"load chart"  ok/); assert.match(t.out, /until: ✓/); assert.match(t.out, /GET \/api\/chart\/a 200/); assert.match(t.out, /proposed until/);
    const stamped = disco("sql", `SELECT count(*) n FROM requests WHERE action_id='${t.out.match(/^(act:\d+)/m)![1]}' AND path LIKE '/api/chart/%'`);
    assert.match(stamped.out, /\n2/, "stamped: " + stamped.out);
    const miss = disco("act", 'page.click("#nope")', "--max", "500");
    assert.equal(miss.code, 1); assert.match(miss.out, /not-found/); assert.match(miss.out, /visible controls/);
    const already = disco("act", 'page.click("#noop")', "--until", 'page.locator("#load-chart").waitFor()');
    assert.equal(already.code, 1); assert.match(already.out, /already true/);
    const bad = disco("act", "page.click(");
    assert.equal(bad.code, 2); assert.match(bad.out, /does not parse/);
    const fnlit = disco("act", '(page) => page.click("#noop")');
    assert.equal(fnlit.code, 0, fnlit.out); assert.match(fnlit.out, /returned: quiet/); assert.doesNotMatch(fnlit.out, /value:/);
    const parsed = disco("sql", "SELECT id, report FROM actions WHERE id='act:3'", "--json");
    const row = JSON.parse(parsed.stdout)[0]; assert.equal(row.id, "act:3"); assert.equal(row.report.action, "act:3", parsed.out);
    const l = disco("look");
    assert.equal(l.code, 0, l.out); assert.match(l.out, /button "Load Chart"/); assert.match(l.out, /#load-chart/); assert.match(l.out, /shot: .*blobs/);
    const l2 = disco("look", "#load-chart");
    assert.match(l2.out, /1 match/);
    const l3 = disco("look", "#never");
    assert.match(l3.out, /0 matches/);
    const q = disco("sql", "SELECT count(*) n FROM actions");
    assert.match(q.out, /\n\d+/);
    const e = disco("sql", "SELECT nope FROM actions");
    assert.equal(e.code, 2); assert.match(e.out, /no such column: nope — actions\(/);
    const x = disco("close", "c");
    assert.match(x.out, /killed/);
    const after = disco("sql", "SELECT count(*) n FROM actions");
    assert.equal(after.code, 0, "the log outlives the browser and the app stays the default: " + after.out);
  });
  it("attach: a browser started independently with a debugging port is driven, recorded, and left running", async () => {
    const { launchChromium, killLaunched } = await import("../src/browser.ts");
    const dir = join(appsDir, "_external");
    mkdirSync(dir, { recursive: true });
    const ext = await launchChromium(dir, {});
    try {
      const o = disco("open", "att", "--attach", String(ext.port), "--url", g.origin);
      assert.equal(o.code, 0, o.out);
      const c = disco("act", 'page.click("#load-chart")', "--until", 'page.waitForResponse(r => r.url().includes("/api/slow"))');
      assert.equal(c.code, 0, c.out); assert.match(c.out, /GET \/api\/chart\/a 200/);
      const x = disco("close", "att");
      assert.match(x.out, /detached/);
      assert.equal((await fetch(ext.endpoint + "/json/version")).ok, true, "the external browser must survive close");
    } finally { killLaunched(ext); }
  });
  it("a pack's sdk.ts runs its own check when executed directly", async () => {
    mkdirSync(join(appsDir, "chk"), { recursive: true });
    writeFileSync(join(appsDir, "chk", "sdk.ts"), `
import { open, reached, type Session } from "${root}/src/index.ts";
export const URL = ${JSON.stringify(g.origin)};
export async function loadChart(s: Session) {
  reached(await s.act("load chart", (p) => p.click("#load-chart"), { until: () => s.page.waitForResponse((r) => r.url().includes("/api/slow")) }));
  return s.json<{ ms: number }>("/api/slow");
}
export async function check(s: Session) {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["chart loads", async () => { const j = await loadChart(s); if (!j || typeof j.ms !== "number") throw new Error("no /api/slow body"); }],
    ["fails on purpose", async () => reached(await s.act("nope", (p) => p.click("#nope"), { max: 500 }))],
  ];
  let failed = 0;
  for (const [name, fn] of steps) { const t = performance.now(); try { await fn(); console.log(\`PASS \${name} (\${Math.round(performance.now() - t)}ms)\`); } catch (e) { failed++; console.log(\`FAIL \${name}: \${String((e as Error).message).split("\\n")[0]}\`); } }
  return failed;
}
if (import.meta.main) {
  const s = await open("chk", { url: URL });
  let failed = 1;
  try { failed = await check(s); } finally { await s.close({ browser: true }); }
  process.exit(failed ? 1 : 0);
}
`);
    const r = spawnSync("node", [join(appsDir, "chk", "sdk.ts")], { cwd: root, env: { ...process.env, DISCO_APPS_DIR: appsDir }, encoding: "utf8", timeout: 90000 });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, out);
    assert.match(out, /PASS chart loads/); assert.match(out, /FAIL fails on purpose: nope \(act:\d+\): not-found/);
    // the pack rule is mechanical: close copies cited reports into evidence/ and names cites with nothing behind them
    const failedId = out.match(/nope \((act:\d+)\)/)![1];
    writeFileSync(join(appsDir, "chk", "README.md"), `# chk\n\nThe chart loads (act:2). A missing button is diagnosed (${failedId}). Nothing backs act:999. The slow call took 4242 ms (act:2). Six products cost 9999 in total. The check passes \`max: 15000\` to that step.\n`);
    const c = disco("close", "chk");
    assert.match(c.out, /evidence: README cites 3 acts; copied 2 new/); assert.match(c.out, /NO REPORT for act:999/);
    assert.match(c.out, /claim check: act:2 is cited for 4242 but its evidence does not contain it/);
    assert.match(c.out, /uncited numbers .*: 1 sentence, e\.g\. "Six products cost 9999 in total\."/);
    const ev = JSON.parse(readFileSync(join(appsDir, "chk", "evidence", `act-${failedId.slice(4)}.json`), "utf8"));
    assert.equal(ev.action, failedId); assert.equal(ev.diagnosis.reason, "not-found");
    assert.ok(existsSync(join(appsDir, "chk", "evidence", `act-${failedId.slice(4)}.jpg`)), "the diagnosis shot is copied too");
    const wire = JSON.parse(readFileSync(join(appsDir, "chk", "evidence", "act-2-wire.json"), "utf8"));
    assert.equal(wire.action, "act:2"); assert.ok(wire.requests.some((r: any) => r.url.includes("/api/slow")), JSON.stringify(wire.requests.map((r: any) => r.url)));
    assert.equal(typeof wire.requests[0].req_headers, "object", "request headers travel with the evidence");
  });
});
