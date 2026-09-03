// node scripts/export.ts <app> <dir> — the pack, runnable without disco.
// Writes <dir>/: the sdk (its disco import rewritten to disco-lite.ts), disco-lite.ts, README.md, evidence/, package.json;
// then runs the pack's check there, on the Playwright-only runtime. What passes is what leaves discovery.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { appDir } from "../src/store.ts";

const [app, out] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!app || !out) { console.error("usage: node scripts/export.ts <app> <dir>"); process.exit(2); }
const root = join(import.meta.dirname, "..");
const pack = appDir(app);
const entry = existsSync(join(pack, "sdk.ts")) ? "sdk.ts" : existsSync(join(pack, "sdk", "index.ts")) ? "sdk/index.ts" : null;
if (!entry) { console.error(`${pack} has no sdk.ts or sdk/index.ts`); process.exit(2); }

mkdirSync(out, { recursive: true });
for (const f of ["README.md", "evidence"]) if (existsSync(join(pack, f))) cpSync(join(pack, f), join(out, f), { recursive: true });
cpSync(join(root, "src", "lite.ts"), join(out, "disco-lite.ts"));

// the sdk, with every import of disco pointed at the runtime beside it; a workflow that reads the log is named (it will throw there)
const logReads: string[] = [];
const files: string[] = [];   // pack-relative: sdk.ts, or everything under sdk/ (never store/, never anything else)
const walk = (rel: string) => { for (const e of readdirSync(join(pack, rel), { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walk(r); else files.push(r); } };
if (entry === "sdk.ts") files.push("sdk.ts"); else walk("sdk");
for (const r of files) {
  mkdirSync(dirname(join(out, r)), { recursive: true });
  if (!/\.ts$/.test(r)) { cpSync(join(pack, r), join(out, r)); continue; }
  const lite = relative(dirname(join(out, r)), join(out, "disco-lite.ts")).replace(/\\/g, "/");
  const src = readFileSync(join(pack, r), "utf8");
  src.split("\n").forEach((l, i) => { if (/\.sql\s*[<(]/.test(l) && !/^\s*\/\//.test(l)) logReads.push(`${r}:${i + 1}`); });
  writeFileSync(join(out, r), src.replace(/(from\s+["'])[^"']*src\/index\.ts(["'])/g, `$1${lite.startsWith(".") ? lite : "./" + lite}$2`));
}

const pwVersion = (() => { try { return "^" + JSON.parse(readFileSync(join(root, "node_modules", "playwright-core", "package.json"), "utf8")).version; } catch { return "^1.55.0"; } })();
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: `${app}-sdk`, private: true, type: "module",
  description: `${app}: workflows found with disco, runnable on plain Playwright. npm i && npx playwright install chromium && npm run check`,
  engines: { node: ">=24" },
  scripts: { check: `node ${entry}` },
  dependencies: { playwright: pwVersion },
}, null, 2) + "\n");

console.log(`exported ${app} → ${out}: ${entry}, disco-lite.ts${existsSync(join(out, "README.md")) ? ", README.md" : ""}${existsSync(join(out, "evidence")) ? ", evidence/" : ""}, package.json`);
if (logReads.length) console.log(`reads the log (sql throws outside disco): ${logReads.join(", ")}`);

// the check, on the runtime beside the pack; the repo's node_modules stand in until the consumer runs npm i
const nm = join(out, "node_modules"); let linked = false;
if (!existsSync(nm)) { try { symlinkSync(join(root, "node_modules"), nm, "dir"); linked = true; } catch {} }
console.log(`check on disco-lite: node ${entry}`);
const r = spawnSync("node", [join(out, entry)], { cwd: out, stdio: "inherit", env: { ...process.env, DISCO_APPS_DIR: undefined as unknown as string } });
if (linked) { try { if (lstatSync(nm).isSymbolicLink()) rmSync(nm); } catch {} }
console.log(r.status === 0 ? "check passed on disco-lite: the pack runs without disco" : `check FAILED on disco-lite (exit ${r.status}) — a workflow relies on something only disco has`);
process.exit(r.status ?? 1);
