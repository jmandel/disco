// The export: a pack's check passes on disco and, unchanged, on the Playwright-only runtime beside the exported pack.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startGauntlet, type GauntletHandle } from "./gauntlet.ts";

const root = join(import.meta.dirname, "..");
const appsDir = mkdtempSync(join(process.env.DISCO_TEST_TMP ?? tmpdir(), "disco-export-apps-"));
const outDir = mkdtempSync(join(process.env.DISCO_TEST_TMP ?? tmpdir(), "disco-export-out-"));
let g: GauntletHandle;
const run = (args: string[], cwd = root) => { const r = spawnSync("node", args, { cwd, env: { ...process.env, DISCO_APPS_DIR: appsDir }, encoding: "utf8", timeout: 120000 }); return { code: r.status, out: (r.stdout + r.stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n|\(Use `node[^\n]*\n/g, "") }; };

before(async () => {
  g = await startGauntlet();
  // a pack as a folder: the portable subset only — act with untils, json, body for a non-JSON response, look(anchor), waitFor("nav")
  mkdirSync(join(appsDir, "xp", "sdk"), { recursive: true });
  writeFileSync(join(appsDir, "xp", "README.md"), "# xp\n\nA pack for the export test.\n");
  writeFileSync(join(appsDir, "xp", "sdk", "index.ts"), `
import { open, reached, type Session } from ${JSON.stringify(root + "/src/index.ts")};
export { readPatientXml } from "./records.ts";
import { readPatientXml } from "./records.ts";
export const URL = ${JSON.stringify(g.origin + "/")};
export const anchors = { chart: "#load-chart", loaded: "#chart:has-text('Chart loaded')" };
/** Load the chart. Precondition: home. Postcondition: the chart text is visible and /api/slow answered. */
export async function loadChart(s: Session) {
  if (!(await s.look(anchors.chart)).count) reached(await s.act("home", (p) => p.goto(URL), { until: () => s.waitFor("nav", (e) => e.url.startsWith(URL)).then(() => s.page.locator(anchors.chart).waitFor()) }));
  reached(await s.act("load chart", (p) => p.click(anchors.chart), { until: () => s.page.waitForResponse((r) => r.url().includes("/api/slow")).then(() => s.page.locator(anchors.loaded).waitFor()) }));
  return s.json<{ ms: number }>("/api/slow");
}
export async function check(s: Session): Promise<number> {
  let failed = 0;
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["chart loads", async () => { const j = await loadChart(s); if (typeof j.ms !== "number") throw new Error("no ms in " + JSON.stringify(j)); }],
    ["patient xml", async () => { const xml = await readPatientXml(s); if (!xml.includes("<Patient")) throw new Error("not a Patient: " + xml.slice(0, 80)); }],
  ];
  for (const [name, fn] of steps) { try { await fn(); console.log("PASS " + name); } catch (e) { failed++; console.log("FAIL " + name + ": " + (e as Error).message); break; } }
  return failed;
}
if (import.meta.main) { const s = await open("xp", { url: URL }); let f = 1; try { f = await check(s); } finally { await s.close({ browser: true }); } process.exit(f ? 1 : 0); }
`);
  writeFileSync(join(appsDir, "xp", "sdk", "records.ts"), `
import { reached, type Session } from ${JSON.stringify(root + "/src/index.ts")};
/** The patient as the server sent it (XML): the response the click caused, read by its hash from the act's own wire. */
export async function readPatientXml(s: Session): Promise<string> {
  const r = reached(await s.act("load xml", (p) => p.click("#load-xml"), { until: () => s.page.locator("#xml-out:has-text('MRN')").waitFor() }));
  const row = r.requests.findLast((w) => w.path.endsWith("/api/patient.xml"));
  if (!row?.body) throw new Error("no body on the wire row: " + JSON.stringify(r.requests));
  return s.body(row.body);
}
`);
  // a flat pack whose workflow reads the log: fine under disco, named at close, and it cannot leave
  mkdirSync(join(appsDir, "xl"), { recursive: true });
  writeFileSync(join(appsDir, "xl", "README.md"), "# xl\n\nReads the log.\n");
  writeFileSync(join(appsDir, "xl", "sdk.ts"), `
import { open, reached, type Session } from ${JSON.stringify(root + "/src/index.ts")};
export const URL = ${JSON.stringify(g.origin + "/")};
export async function slowCalls(s: Session) {
  reached(await s.act("load chart", (p) => p.click("#load-chart"), { until: () => s.page.waitForResponse((r) => r.url().includes("/api/slow")) }));
  return s.sql<{ n: number }>("SELECT count(*) n FROM requests WHERE path LIKE '/api/slow%'")[0].n;
}
export async function check(s: Session): Promise<number> { try { const n = await slowCalls(s); console.log("PASS slow calls " + n); return 0; } catch (e) { console.log("FAIL slow calls: " + (e as Error).message); return 1; } }
if (import.meta.main) { const s = await open("xl", { url: URL }); let f = 1; try { f = await check(s); } finally { await s.close({ browser: true }); } process.exit(f ? 1 : 0); }
`);
});
after(() => { g.stop(); });

describe("export", () => {
  it("the same check passes under disco and, exported, on disco-lite; the export carries no store", () => {
    const d = run([join(appsDir, "xp", "sdk", "index.ts")]);
    assert.equal(d.code, 0, d.out); assert.match(d.out, /PASS chart loads/); assert.match(d.out, /PASS patient xml/);
    const out = join(outDir, "xp");
    const x = run([join(root, "scripts", "export.ts"), "xp", out]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /PASS chart loads/); assert.match(x.out, /PASS patient xml/); assert.match(x.out, /check passed on disco-lite/);
    for (const f of ["sdk/index.ts", "sdk/records.ts", "disco-lite.ts", "README.md", "package.json"]) assert.ok(existsSync(join(out, f)), `${f} exported`);
    assert.ok(!existsSync(join(out, "store")) && !existsSync(join(out, "node_modules")), "no store, no borrowed node_modules left behind");
    assert.match(readFileSync(join(out, "sdk", "index.ts"), "utf8"), /from "\.\.\/disco-lite\.ts"/);
    assert.match(readFileSync(join(out, "sdk", "records.ts"), "utf8"), /from "\.\.\/disco-lite\.ts"/);
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    assert.equal(pkg.scripts.check, "node sdk/index.ts"); assert.ok(pkg.dependencies.playwright);
  });
  it("a workflow that reads the log passes under disco, is named at close, and fails the export by name", () => {
    const d = run([join(appsDir, "xl", "sdk.ts")]);
    assert.equal(d.code, 0, d.out); assert.match(d.out, /PASS slow calls \d+/);
    const c = run([join(root, "cli", "disco.ts"), "close", "xl"]);
    assert.match(c.out, /the sdk reads the log[^\n]*sdk\.ts:6/, c.out);
    const x = run([join(root, "scripts", "export.ts"), "xl", join(outDir, "xl")]);
    assert.notEqual(x.code, 0);
    assert.match(x.out, /reads the log \(sql throws outside disco\): sdk\.ts:6/); assert.match(x.out, /sql reads disco's discovery log/); assert.match(x.out, /check FAILED on disco-lite/);
  });
});
