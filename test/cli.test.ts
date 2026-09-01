// The CLI and the check runner, as a stranger would run them.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
  it("open → click --json → until (exit 1) → sql → note → close", async () => {
    const o = disco("open", "c", g.origin);
    assert.equal(o.code, 0, o.out);
    assert.match(o.out, /launch http:\/\/127\.0\.0\.1:\d+ run 1/);
    assert.match(o.out, /recording: pid \d+/);
    // the recorder captures what the page does BETWEEN commands
    const e = disco("eval", "setTimeout(() => fetch('/api/chart/b'), 700); 'armed'");
    assert.equal(e.code, 0, e.out);
    await new Promise((r) => setTimeout(r, 1800));
    const between = disco("sql", "SELECT count(*) n FROM requests WHERE path='/api/chart/b' AND action_id IS NULL");
    assert.match(between.out, /\n1/, "between: " + between.out);
    const c = disco("click", "#noop", "--json");
    assert.equal(c.code, 0, c.out);
    const rep = JSON.parse(c.stdout);
    assert.equal(rep.ok, true); assert.equal(rep.action, "act:3");
    const u = disco("until", "--until-selector", "#never", "--timeout", "300", "--json");
    assert.equal(u.code, 1);
    assert.equal(JSON.parse(u.stdout).until.ok, false);
    const t = disco("click", "#load-chart", "--until-request", "/api/slow", "--landed");
    assert.equal(t.code, 0, t.out);
    assert.match(t.out, /until: ✓ request \/api\/slow landed/);
    assert.match(t.out, /GET \/api\/chart\/a 200/);
    const stamped = disco("sql", "SELECT count(*) n FROM requests WHERE action_id='act:5' AND path LIKE '/api/chart/%'");
    assert.match(stamped.out, /\n2/, "stamped: " + stamped.out);
    assert.match(disco("ls").out, /c\t.*alive recording/);
    const a = disco("aria", "#s-13");
    assert.match(a.out, /button "Do nothing"/);
    const ev = disco("eval", "fetch('/api/chart/a').then(r => r.status)");
    assert.equal(ev.code, 0, ev.out); assert.match(ev.out, /^200\n/); assert.match(ev.out, /act:\d+ evaluate/); assert.match(ev.out, /GET \/api\/chart\/a 200/);
    const wide = disco("sql", "SELECT body_hash || body_hash || body_hash || body_hash h FROM requests WHERE body_hash IS NOT NULL LIMIT 1", "--wide");
    assert.ok(wide.stdout.trim().split("\n").at(-1)!.length >= 256, wide.out);
    const q = disco("sql", "SELECT count(*) n FROM actions");
    assert.match(q.out, /\n6/);
    const n = disco("note", "hello from the cli");
    assert.equal(n.code, 0, n.out);
    assert.ok(existsSync(join(appsDir, "c", "NOTES.md")));
    const x = disco("close", "c");
    assert.match(x.out, /killed/);
    assert.doesNotMatch(disco("ls").out, /recording/);
  });
  it("run-check runs a pack's check.ts", async () => {
    mkdirSync(join(appsDir, "chk"), { recursive: true });
    writeFileSync(join(appsDir, "chk", "check.ts"), `
import { reached } from "${root}/src/index.ts";
export const target = { url: "${g.origin}" };
export async function check(s, step) {
  await step("no-op", async () => reached(await s.click("#noop")));
  await step("chart loads", async () => reached(await s.click("#load-chart", { until: { request: "/api/slow", landed: true } })));
  await step("fails on purpose", async () => reached(await s.click("#nope")));
}
`);
    const r = spawnSync("node", [join(root, "scripts/run-check.ts"), "chk", "--close"], { cwd: root, env: { ...process.env, DISCO_APPS_DIR: appsDir }, encoding: "utf8", timeout: 90000 });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, out);
    assert.match(out, /PASS no-op/); assert.match(out, /PASS chart loads/); assert.match(out, /FAIL fails on purpose .*not-found/);
    assert.match(out, /2\/3 passed/);
  });
});
