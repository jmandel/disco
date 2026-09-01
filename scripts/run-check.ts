// bun scripts/run-check.ts <app> [--headed] [--close]
// Runs apps/<app>/check.ts: `export const target = { url }` and `export async function check(s, step)`.
import { join } from "node:path";
import { open, type Session } from "../src/session.ts";
import { appDir } from "../src/store.ts";

export type Step = (name: string, fn: () => Promise<unknown>) => Promise<boolean>;

const argv = process.argv.slice(2);
const app = argv.find((a) => !a.startsWith("--"));
if (!app) { console.error("usage: bun scripts/run-check.ts <app> [--headed] [--close]"); process.exit(2); }
const mod = await import(join(appDir(app), "check.ts"));
if (!mod.target?.url || typeof mod.check !== "function") { console.error(`apps/${app}/check.ts must export target = { url } and check(s, step)`); process.exit(2); }

const s: Session = await open(app, { url: mod.target.url, headed: argv.includes("--headed"), attach: mod.target.attach });
const results: Array<{ name: string; ok: boolean; ms: number; error?: string }> = [];
const step: Step = async (name, fn) => {
  const t = performance.now();
  try { await fn(); results.push({ name, ok: true, ms: Math.round(performance.now() - t) }); console.log(`PASS ${name} (${Math.round(performance.now() - t)}ms)`); return true; }
  catch (e) { const error = String((e as Error).message ?? e).split("\n")[0]; results.push({ name, ok: false, ms: Math.round(performance.now() - t), error }); console.log(`FAIL ${name} (${Math.round(performance.now() - t)}ms): ${error}`); return false; }
};
const t0 = performance.now();
try { await mod.check(s, step); } catch (e) { console.log("check() threw: " + String((e as Error).message ?? e)); results.push({ name: "check()", ok: false, ms: 0, error: String((e as Error).message ?? e) }); }
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed in ${Math.round(performance.now() - t0)}ms`);
await s.close({ browser: argv.includes("--close") });
process.exit(failed ? 1 : 0);
