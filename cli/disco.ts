#!/usr/bin/env node
// disco — the CLI. Five commands. Every command reconnects to the app's browser, does one thing, prints, and
// disconnects; the browser (and a detached recorder) keep running between commands.
import { existsSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open, type Session } from "../src/session.ts";
import { formatLook } from "../src/format.ts";
import { appsRoot, appStoreDir, appDir, openStore, syncEvidence } from "../src/store.ts";
import { readBrowserInfo, killLaunched, writeBrowserInfo, isAlive, pidAlive } from "../src/browser.ts";

const HELP = `disco — drive a web app you have never seen; everything it does lands in a SQLite log.

  disco open <app> <url> [--headed]                launch Chromium, navigate, record until close
  disco open <app> --attach <port|host:port|ws://…> [--url <substring>]   attach to a running browser
  disco close [<app>]                              kill the launched browser (forget an attached one)

  disco look [<selector>]                          the screen: aria tree, numbered controls with selectors that paste, a marked-up screenshot
                                                   with a selector: what it matches, where, what is under the pointer
  disco act <js> [--until <js>] [--quiet MS] [--max MS] [--label TEXT]
                                                   run Playwright code (page, s in scope) as one observed step; prints what happened
  disco sql <query> [--json]                       the log (tables: runs actions requests bodies ws_frames console dialogs nav shots)

Examples:
  disco act 'page.click("#save")'
  disco act 'await page.fill("#q", "ada"); await page.press("#q", "Enter")' --until 'page.waitForResponse(r => r.url().includes("/api/search"))'
  disco look 'role=button[name="Save"]'
  disco sql "SELECT method, path, status FROM requests WHERE action_id='act:3'"

--app <name> on any command (default: the last opened); --json prints data instead of text.`;

type Args = { _: string[]; [k: string]: string | boolean | string[] | undefined };
const BOOL = new Set(["json", "headed"]);   // flags that never take a value, wherever they appear
function parse(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith("--") && x.length > 2) { const k = x.slice(2); const next = argv[i + 1]; a[k] = !BOOL.has(k) && next !== undefined && !(next.startsWith("--") && next.length > 2) ? (i++, next) : true; }
    else a._.push(x);
  }
  return a;
}
const args = parse(process.argv.slice(2));
const cmd = args._[0];
const json = args.json === true;
const currentFile = join(appsRoot(), ".current");
function currentApp(): string {
  const a = (args.app as string) ?? process.env.DISCO_APP ?? (existsSync(currentFile) ? readFileSync(currentFile, "utf8").trim() : "");
  if (!a) fail("no app: pass --app <name> or run `disco open` first");
  return a;
}
function fail(msg: string): never { console.error("error: " + msg); process.exit(2); }
function num(v: unknown): number | undefined { return v === undefined || v === true ? undefined : Number(v); }
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...b: unknown[]) => Promise<unknown>;

async function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const app = currentApp();
  const info = readBrowserInfo(appStoreDir(app));
  if (!info) fail(`no browser for app ${app}: run \`disco open ${app} <url>\` first`);
  if (!(await isAlive(info.endpoint))) fail(`browser for ${app} is gone (${info.endpoint}); run \`disco open\` again`);
  const s = await open(app, {});
  try { return await fn(s); } finally { await s.close(); }
}

/** Spawn a detached recorder for the app; resolves with its pid once it has attached (or null). */
async function startRecorder(app: string): Promise<number | null> {
  const dir = appStoreDir(app);
  const before = readBrowserInfo(dir); if (!before) return null;
  if (pidAlive(before.recorderPid)) return before.recorderPid!;
  const fd = openSync(join(dir, "recorder.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "_record", "--app", app], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, DISCO_APPS_DIR: appsRoot() } });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const now = readBrowserInfo(dir);
    if (now?.recorderPid === child.pid) return child.pid!;
    if (child.exitCode !== null) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

try { await main(); } catch (e) {
  console.error("error: " + String((e as Error)?.message ?? e).split("\n").slice(0, 3).join(" | "));
  process.exit(2);
}
async function main() { switch (cmd) {
  case undefined: case "help": case "--help": console.log(HELP); break;

  case "open": {
    const app = args._[1]; if (!app) fail("usage: disco open <app> <url> | disco open <app> --attach <port>");
    const url = args._[2] ?? (typeof args.url === "string" ? args.url : undefined);
    if (!args.attach && !url) fail("usage: disco open <app> <url> | disco open <app> --attach <port>");
    const s = await open(app, { url, attach: args.attach as any, headed: args.headed === true });
    writeFileSync(currentFile, app);
    const others = s.context.pages().filter((p) => !p.url().startsWith("data:")).length - 1;
    const line = `${app}: run ${s.run}  ${s.opened === "navigated" ? "navigated to" : "joined at"} ${s.page.url()}${others > 0 ? `  (+${others} other page${others > 1 ? "s" : ""} open)` : ""}\nstore: ${appStoreDir(app)}`;
    await s.close();
    const rec = await startRecorder(app);
    console.log(line + (rec ? `\nrecording: pid ${rec} (everything until \`disco close\`)` : "\nrecording: only while commands run (recorder did not start; see store/recorder.log)"));
    break;
  }
  case "close": {
    const app = args._[1] ?? currentApp();
    const dir = appStoreDir(app); const info = readBrowserInfo(dir);
    if (info) {
      if (pidAlive(info.recorderPid)) { try { process.kill(info.recorderPid!, "SIGTERM"); } catch {} await new Promise((r) => setTimeout(r, 400)); }
      killLaunched(info); writeBrowserInfo(dir, null);
      try { const st = openStore(dir, { readonly: false }); st.db.prepare("UPDATE runs SET ended_wall=? WHERE ended_wall IS NULL").run(new Date().toISOString()); st.close(); } catch {}
    }
    console.log(`${app}: ${!info ? "no browser" : info.mode === "launch" ? "browser killed" : "detached"} (the log stays; ${app} remains the default app)`);
    try { const ev = syncEvidence(appDir(app), dir); if (ev.cited) console.log(`evidence: README cites ${ev.cited} act${ev.cited === 1 ? "" : "s"}; ${ev.copied.length ? `copied ${ev.copied.length} report${ev.copied.length === 1 ? "" : "s"} to apps/${app}/evidence/` : "nothing new to copy"}${ev.missing.length ? `; NO REPORT for ${ev.missing.join(", ")} — a cite with nothing behind it is a guess` : ""}`); } catch {}
    break;
  }
  case "look": {
    const l = await withSession((s) => s.look(args._[1]));
    console.log(json ? JSON.stringify(l, null, 2) : formatLook(l));
    if (l.error) process.exit(1);
    break;
  }
  case "act": {
    const src = args._.slice(1).join(" "); if (!src) fail("usage: disco act <js>  (page and s are in scope; e.g. disco act 'page.click(\"#save\")')");
    // an expression (its value is the act's value) or statements (use return); try the expression form first
    let run: (...a: unknown[]) => Promise<unknown>; let until: ((...a: unknown[]) => unknown) | undefined;
    try { run = new AsyncFunction("page", "s", `return (${src}\n);`); } catch { try { run = new AsyncFunction("page", "s", src); } catch (e) { fail(`act: the code does not parse — ${(e as Error).message}`); } }
    if (typeof args.until === "string") { try { until = new Function("page", "s", `return (${args.until});`) as any; } catch (e) { fail(`--until: the code does not parse — ${(e as Error).message}`); } }
    // an expression that evaluates to a function (e.g. a pasted `(page) => …`) is called, not returned
    const call = async (page: unknown, s: Session) => { const v = await run(page, s); return typeof v === "function" ? await (v as (...a: unknown[]) => unknown)(page, s) : v; };
    const r = await withSession((s) => s.act((args.label as string) ?? src.slice(0, 70), (page) => call(page, s), { until: until ? () => Promise.resolve(until!(s.page, s)) : undefined, quiet: num(args.quiet), max: num(args.max) }));
    console.log(json ? JSON.stringify(r, null, 2) : String(r));
    if (!r.ok || (r.until && (!r.until.ok || r.until.alreadyTrue))) process.exit(1);
    break;
  }
  case "sql": {
    const q = args._.slice(1).join(" "); if (!q) fail("usage: disco sql <query>");
    const st = openStore(appStoreDir(currentApp()));
    const rows = st.sql(q);
    // one row, one column, holding JSON → print that JSON itself (a report, a body), not an array wrapping a string
    const scalar = json && rows.length === 1 && Object.keys(rows[0]).length === 1 ? (() => { const v = Object.values(rows[0])[0]; if (typeof v !== "string" || !/^[\[{]/.test(v.trim())) return undefined; try { return JSON.parse(v); } catch { return undefined; } })() : undefined;
    if (json) console.log(JSON.stringify(scalar ?? rows, null, 2));
    else if (!rows.length) console.log("(no rows)");
    else {
      const cols = Object.keys(rows[0]);
      console.log(cols.join("\t"));
      let clipped = false;
      for (const r of rows) console.log(cols.map((c) => { const v = r[c]; const s = v == null ? "" : typeof v === "string" ? v : String(v); if (s.length > 300) { clipped = true; return s.slice(0, 297) + "…"; } return s.replace(/\n/g, "\\n"); }).join("\t"));
      if (clipped) console.error("(cells clipped at 300 chars — --json for everything)");
    }
    st.close();
    break;
  }
  case "_record": {
    const app = currentApp();
    const info = readBrowserInfo(appStoreDir(app));
    if (!info) fail(`no browser for app ${app}`);
    if (pidAlive(info.recorderPid) && info.recorderPid !== process.pid) fail(`a recorder is already running for ${app} (pid ${info.recorderPid})`);
    const s = await open(app, { recorder: true });   // the Session claims recorderPid in browser.json
    await new Promise<void>((resolve) => { process.on("SIGINT", () => resolve()); process.on("SIGTERM", () => resolve()); s.browser.on("disconnected", () => resolve()); });
    await s.close();
    const cur = readBrowserInfo(appStoreDir(app)); if (cur?.recorderPid === process.pid) writeBrowserInfo(appStoreDir(app), { ...cur, recorderPid: undefined });
    break;
  }
  default: fail(`unknown command ${cmd}\n\n${HELP}`);
} }
