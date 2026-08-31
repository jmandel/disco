// One-command live drift check for a product pack: launch a headless browser, attach a scoped session,
// open the target, run apps/<target>/check.ts's check(s), tear down, exit with its status. Suitable
// for a scheduled regression loop. Hits the live app, so it is a script — never a *.test.ts.
//   bun scripts/run-check.ts openemr
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchChromium } from "../src/launch.ts";
import { Daemon } from "../src/daemon.ts";
import { Session } from "../src/client.ts";

// Per-target setup: where to point the browser, and what host to scope to. Add a line per pack.
const TARGETS: Record<string, { url: string; scope: string }> = {
  openemr: { url: "https://demo.openemr.io/a/openemr/index.php", scope: "demo.openemr.io" },
  saucedemo: { url: "https://www.saucedemo.com/", scope: "saucedemo.com" },
};

const name = process.argv[2];
const cfg = TARGETS[name];
if (!cfg) { console.error(`unknown target ${JSON.stringify(name)}; known: ${Object.keys(TARGETS).join(", ")}`); process.exit(2); }

const base = join(import.meta.dir, "..", ".scratch", "checks", `${name}-${Date.now().toString(36)}`);
rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true });

const browser = await launchChromium({ headless: true, userDataDir: join(base, "profile") });
const daemon = await Daemon.start({ dir: join(base, "session"), name: `check-${name}`, product: name, mode: "attach", port: browser.port, scope: cfg.scope });
let code = 1;
try {
  await daemon.cdp.send("Target.createTarget", { url: cfg.url });
  await new Promise((r) => setTimeout(r, 4000)); // let the scoped page attach + load
  const s = await Session.connect(join(base, "session"));
  const { check } = await import(`../apps/${name}/check.ts`);
  const passed = await check(s);
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
