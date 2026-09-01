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
    const c = disco("click", "#noop", "--json");
    assert.equal(c.code, 0, c.out);
    const rep = JSON.parse(c.stdout);
    assert.equal(rep.ok, true); assert.equal(rep.action, "act:2");
    const u = disco("until", "--until-selector", "#never", "--timeout", "300", "--json");
    assert.equal(u.code, 1);
    assert.equal(JSON.parse(u.stdout).until.ok, false);
    const t = disco("click", "#load-chart", "--until-request", "/api/slow", "--landed");
    assert.equal(t.code, 0, t.out);
    assert.match(t.out, /until: ✓ request \/api\/slow landed/);
    assert.match(t.out, /GET \/api\/chart\/a 200/);
    const q = disco("sql", "SELECT count(*) n FROM actions");
    assert.match(q.out, /\n4/);
    const n = disco("note", "hello from the cli");
    assert.equal(n.code, 0, n.out);
    assert.ok(existsSync(join(appsDir, "c", "NOTES.md")));
    const x = disco("close", "c");
    assert.match(x.out, /killed/);
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
