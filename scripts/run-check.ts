// One-command live drift check for a product pack: launch a headless browser, attach a scoped session,
// open the target, run apps/<target>/check.ts's check(s), tear down, exit with its status. Suitable
// for a scheduled regression loop. Hits the live app, so it is a script — never a *.test.ts.
//   bun scripts/run-check.ts openemr
// Each pack's check.ts exports `target = { url, scope }` (where to point the browser, what host to scope
// to) next to `check(s)`, so adding a pack never touches this file.
import { rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launchChromium } from "../src/launch.ts";
import { Daemon } from "../src/daemon.ts";
import { Session } from "../src/client.ts";
import { until } from "../lib/nav.ts";

const appsDir = join(import.meta.dir, "..", "apps");
const packs = readdirSync(appsDir).filter((p) => existsSync(join(appsDir, p, "check.ts")));
const name = process.argv[2];
if (!name || !packs.includes(name)) { console.error(`usage: bun scripts/run-check.ts <pack>   (packs with a check.ts: ${packs.join(", ")})`); process.exit(2); }
const mod = await import(join(appsDir, name, "check.ts"));
const cfg = mod.target as { url: string; scope: string } | undefined;
if (!cfg?.url || !cfg?.scope) { console.error(`apps/${name}/check.ts must export \`target = { url, scope }\``); process.exit(2); }

const base = join(import.meta.dir, "..", ".scratch", "checks", `${name}-${Date.now().toString(36)}`);
rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true });

const browser = await launchChromium({ headless: true, userDataDir: join(base, "profile") });
const daemon = await Daemon.start({ dir: join(base, "session"), name: `check-${name}`, product: name, mode: "attach", port: browser.port, scope: cfg.scope });
let code = 1;
try {
  await daemon.cdp.send("Target.createTarget", { url: cfg.url });
  const s = await Session.connect(join(base, "session"));
  await until(s, { selector: "body", visible: true }, { budgetMs: 20000, msg: `run-check: ${cfg.url} did not load` }); // the scoped page attached + rendered
  const passed = await mod.check(s);
  s.close();
  code = passed ? 0 : 1;
} catch (e) {
  console.error("run-check threw:", (e as Error).message);
} finally {
  await daemon.stop().catch(() => {});
  await browser.kill();
  if (!process.env.DISCO_KEEP_SCRATCH) rmSync(base, { recursive: true, force: true });
}
console.log(`\n${name}: ${code === 0 ? "OK" : "DRIFT/FAIL"}`);
process.exit(code);
