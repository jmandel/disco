#!/usr/bin/env node
// disco — the CLI. Every command reconnects to the app's browser (launched by `open`, or attached),
// does one thing, prints the report, and disconnects. The browser keeps running between commands.
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { open, type ActSpec, type Pred, type Kind } from "../src/session.ts";
import { formatReport } from "../src/format.ts";
import { appsRoot, appStoreDir, openStore, SCHEMA } from "../src/store.ts";
import { readBrowserInfo, killLaunched, writeBrowserInfo, isAlive, pidAlive } from "../src/browser.ts";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `disco — drive an unfamiliar web app, keep every wait short and named, leave a pack behind.

  disco open <app> <url> [--headed] [--dialogs accept|dismiss] [--fresh]   launch Chromium, navigate, start recording (until close)
  disco open <app> --attach <port|host:port|ws://…> [--url <substring>]     attach to a running browser (page matching --url, else the first)
  disco close [<app>]                          kill the launched browser (forget an attached one)
  disco ls                                     apps with a store, and whether their browser is alive

  disco click|dblclick|rightclick|hover <target> [until…] [--frame F] [--js]   (--js: dispatch a click event, for re-rendering widgets)
  disco drag <target> <to>
  disco fill <target> <text>  |  disco type <target> <text>  |  disco press <key> [--target T]
  disco select <target> <value>  |  disco scroll [<target>|--dy N]  |  disco navigate <url>
  disco act <kind> [<target>] [--text T] [--key K] [--value V] [--url U] [--button right] …
  disco until [until…]                         wait for a state without acting
    until…: --until-selector S [--attached] | --until-gone S | --until-text T | --until-url U   (selector = visible unless --attached)
            --until-request R [--landed] | --until-fn JS   (repeat flags → any-of)   --timeout MS  --window MS  --shot  --wire all

  disco aria [<selector>] [--frame F]          the page (or one element) as the accessibility tree sees it — look before you guess a selector
  disco eval <js-expression>                   run in the page as an act (its requests are attributed); prints the value and the report
  disco screenshot [--out file.jpg]
  disco sql <query> [--json | --wide]          the log (disco schema for the tables); cells clip at 200 chars unless --wide/--json
  disco body <hash-or-prefix>                  a captured body / screenshot blob
  disco req <request-id>                       one request in full: method, url, status, headers, request body, response body hash
  disco writes [--run N]                       every non-GET app request of the run (the write inventory)
  disco note <text>                            append to apps/<app>/NOTES.md
  disco record                                 record in the foreground (open already runs one in the background)
  disco pages [--close N | --close-others]     list open pages (* = driven); --page N picks one for any command
  disco schema

Targets are Playwright selectors: css, text=…, role=button[name="Save"], #id >> css, xpath=…
Every command takes --app <name> (default: the last opened, apps/.current) and --json.`;

type Args = { _: string[]; [k: string]: string | boolean | string[] | undefined };
function parse(argv: string[]): Args {
  const a: Args = { _: [] };
  const multi = new Set(["until-selector", "until-gone", "until-text", "until-url", "until-request", "until-fn"]);
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith("--")) {
      const k = x.slice(2); const next = argv[i + 1];
      const val = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      if (multi.has(k)) (a[k] = [...((a[k] as string[]) ?? []), String(val)]);
      else a[k] = val;
    } else a._.push(x);
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

function untilFromArgs(): Pred | undefined {
  const preds: Pred[] = [];
  for (const s of (args["until-selector"] as string[]) ?? []) preds.push({ selector: s, ...(args.attached === true ? { visible: false } : {}) });
  for (const s of (args["until-gone"] as string[]) ?? []) preds.push({ gone: s });
  for (const s of (args["until-text"] as string[]) ?? []) preds.push({ text: s });
  for (const s of (args["until-url"] as string[]) ?? []) preds.push({ url: s });
  for (const s of (args["until-request"] as string[]) ?? []) preds.push({ request: s, landed: args.landed === true });
  for (const s of (args["until-fn"] as string[]) ?? []) preds.push({ fn: s });
  if (!preds.length) return undefined;
  return preds.length === 1 ? preds[0] : { any: preds };
}

async function withSession<T>(fn: (s: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
  const app = currentApp();
  const info = readBrowserInfo(appStoreDir(app));
  if (!info) fail(`no browser for app ${app}: run \`disco open ${app} <url>\` first`);
  if (!(await isAlive(info.endpoint))) fail(`browser for ${app} is gone (${info.endpoint}); run \`disco open\` again`);
  const s = await open(app, { page: num(args.page), dialogs: (args.dialogs as any) ?? "accept", timeouts: { action: num(args["action-timeout"]) ?? 3000 } });
  try { return await fn(s); } finally { await s.close(); }
}

function printReport(r: any) { console.log(json ? JSON.stringify(r, null, 2) : formatReport(r)); }

const KINDS: Record<string, Kind> = { click: "click", dblclick: "dblclick", rightclick: "click", hover: "hover", fill: "fill", type: "type", press: "press", select: "select", scroll: "scroll", drag: "drag", navigate: "navigate", act: "noop" };

/** Spawn a detached `disco record --detached` for the app; resolves with its pid once it has attached (or null). */
async function startRecorder(app: string, dialogs: string): Promise<number | null> {
  const dir = appStoreDir(app);
  const before = readBrowserInfo(dir); if (!before) return null;
  if (pidAlive(before.recorderPid)) return before.recorderPid!;
  const fd = openSync(join(dir, "recorder.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "record", "--app", app, "--dialogs", dialogs, "--detached"], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, DISCO_APPS_DIR: appsRoot() } });
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
  const msg = String((e as Error)?.message ?? e).split("\n")[0];
  console.error("error: " + msg + (/no such column|no such table/.test(msg) ? "  (./disco schema lists the tables and columns; requests uses t_start/t_end, other tables t)" : ""));
  process.exit(2);
}
async function main() { switch (cmd) {
  case undefined: case "help": case "--help": console.log(HELP); break;

  case "open": {
    const app = args._[1]; if (!app) fail("usage: disco open <app> <url> | --attach <port>");
    const url = args._[2] ?? (typeof args.url === "string" ? args.url : undefined);
    if (!args.attach && !url) fail("usage: disco open <app> <url> | disco open <app> --attach <port>");
    const s = await open(app, { url, attach: args.attach as any, headed: args.headed === true, dialogs: (args.dialogs as any) ?? "accept", fresh: args.fresh === true });
    writeFileSync(currentFile, app);
    const line = `${app}: ${s.info.mode} ${s.info.endpoint} run ${s.log.run}  page ${s.page.url()}${s.context.pages().length > 1 ? `  (+${s.context.pages().length - 1} other pages open — ./disco pages)` : ""}\nstore: ${s.log.dir}`;
    await s.close();
    const rec = await startRecorder(app, (args.dialogs as any) ?? "accept");
    console.log(line + (rec ? `\nrecording: pid ${rec} (everything until \`disco close\`)` : "\nrecording: only while commands run (recorder did not start; see store/recorder.log)"));
    break;
  }
  case "close": {
    const app = args._[1] ?? currentApp();
    const dir = appStoreDir(app); const info = readBrowserInfo(dir);
    if (!info) { console.log(`${app}: no browser`); break; }
    if (pidAlive(info.recorderPid)) { try { process.kill(info.recorderPid!, "SIGTERM"); } catch {} await new Promise((r) => setTimeout(r, 400)); }
    killLaunched(info); writeBrowserInfo(dir, null);
    try { const st = openStore(dir, { readonly: false }); st.db.prepare("UPDATE runs SET ended_wall=? WHERE ended_wall IS NULL").run(new Date().toISOString()); st.close(); } catch {}
    if (existsSync(currentFile) && readFileSync(currentFile, "utf8").trim() === app) rmSync(currentFile);
    console.log(`${app}: ${info.mode === "launch" ? "browser killed" : "detached"}`);
    break;
  }
  case "ls": {
    const { readdirSync } = await import("node:fs");
    const root = appsRoot();
    for (const d of existsSync(root) ? readdirSync(root) : []) {
      const dir = join(root, d, "store"); if (!existsSync(join(dir, "store.sqlite"))) continue;
      const info = readBrowserInfo(dir);
      console.log(`${d}\t${info ? `${info.mode} ${info.endpoint} ${(await isAlive(info.endpoint)) ? "alive" : "dead"}${pidAlive(info.recorderPid) ? " recording" : ""}` : "no browser"}`);
    }
    break;
  }
  case "schema": console.log(SCHEMA.trim()); break;

  case "click": case "dblclick": case "rightclick": case "hover": case "fill": case "type": case "press": case "select": case "scroll": case "drag": case "navigate": case "act": case "until": {
    let spec: ActSpec;
    const until = untilFromArgs();
    const common = { until, timeout: num(args.timeout), window: num(args.window), shot: args.shot === true, frame: args.frame as string | undefined, wire: (args.wire === "all" ? "all" : undefined) as "all" | undefined };
    if (cmd === "until") { if (!until) fail("until needs at least one --until-* flag"); spec = { kind: "noop", ...common }; }
    else if (cmd === "act") {
      const kind = args._[1] as Kind; if (!kind || !(kind in KINDS) || (kind as string) === "act") fail("usage: disco act <kind> [target] …");
      spec = { kind, target: args._[2], text: args.text as string, key: args.key as string, value: args.value as string, url: args.url as string, button: args.button as any, deltaY: num(args.dy), ...common };
    } else {
      const kind = KINDS[cmd];
      const t = args._[1];
      spec = { kind, ...common };
      if (cmd === "rightclick") spec.button = "right";
      if (cmd === "click" && args.js === true) spec.js = true;
      if (cmd === "drag") { spec.target = t; spec.to = args._[2]; if (!spec.to) fail("usage: disco drag <target> <to>"); }
      if (cmd === "press") { spec.key = t; spec.target = args.target as string | undefined; }
      else if (cmd === "navigate") spec.url = t;
      else if (cmd === "scroll") { if (t) spec.target = t; spec.deltaY = num(args.dy); }
      else if (cmd !== "drag") { spec.target = t; if (cmd === "fill" || cmd === "type") spec.text = args._[2] ?? (args.text as string) ?? ""; if (cmd === "select") spec.value = args._[2] ?? (args.value as string); }
      if (kind !== "scroll" && kind !== "navigate" && !spec.target && cmd !== "press") fail(`usage: disco ${cmd} <target>`);
      if (cmd === "navigate" && !spec.url) fail("usage: disco navigate <url>");
    }
    const r = await withSession((s) => s.act(spec));
    printReport(r);
    if (!r.ok || (r.until && !r.until.ok)) process.exit(1);
    break;
  }
  case "aria": {
    const text = await withSession((s) => s.aria(args._[1], { frame: args.frame as string | undefined }));
    console.log(text);
    break;
  }
  case "eval": {
    const js = args._.slice(1).join(" "); if (!js) fail("usage: disco eval <js-expression>");
    const r = await withSession((s) => s.probe(js, undefined, { until: untilFromArgs(), timeout: num(args.timeout), window: num(args.window) }));
    if (json) console.log(JSON.stringify(r, null, 2));
    else { console.log(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)); console.log(formatReport({ ...r, value: undefined } as any)); }
    if (!r.ok) process.exit(1);
    break;
  }
  case "screenshot": {
    const r = await withSession(async (s) => s.screenshot("shot"));
    if (typeof args.out === "string") { const { copyFileSync } = await import("node:fs"); copyFileSync(r.path, args.out); console.log(args.out); }
    else console.log(r.path);
    break;
  }
  case "sql": {
    const q = args._.slice(1).join(" "); if (!q) fail("usage: disco sql <query>");
    const st = openStore(appStoreDir(currentApp()));
    const rows = st.sql(q);
    if (json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log("(no rows)");
    else {
      const cols = Object.keys(rows[0]);
      console.log(cols.join("\t"));
      const wide = args.wide === true; let clipped = false;
      for (const r of rows) console.log(cols.map((c) => { const v = r[c]; const s = v == null ? "" : typeof v === "string" ? v : String(v); if (!wide && s.length > 200) { clipped = true; return s.slice(0, 197) + "…"; } return s; }).join("\t"));
      if (clipped) console.error("(cells clipped at 200 chars — --wide or --json for everything)");
    }
    st.close();
    break;
  }
  case "body": {
    const h = args._[1]; if (!h) fail("usage: disco body <hash>");
    const st = openStore(appStoreDir(currentApp()));
    const p = st.blobPath(h);
    const bytes = st.bytes(h);
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) console.log(p);
    else process.stdout.write(st.body(h) + "\n");
    st.close();
    break;
  }
  case "req": {
    const id = args._[1]; if (!id) fail("usage: disco req <request-id>  (ids look like r3-41)");
    const st = openStore(appStoreDir(currentApp()));
    const r = st.one<any>("SELECT * FROM requests WHERE id=?", id); if (!r) fail(`no request ${id}`);
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`${r.id}  ${r.method} ${r.url}\nstatus ${r.status ?? "—"}  ${r.mime ?? ""}  t_start ${Math.round(r.t_start)}  action ${r.action_id ?? "—"}  body ${r.body_hash ? r.body_hash.slice(0, 16) + " [" + r.body_state + "]" : "(" + r.body_state + ")"}`);
      console.log("request headers: " + (r.req_headers ?? ""));
      console.log("request body: " + (r.req_body ?? "(none)"));
      console.log("response headers: " + (r.resp_headers ?? ""));
      if (r.body_hash && r.error) console.log("error: " + r.error);
    }
    st.close();
    break;
  }
  case "writes": {
    const st = openStore(appStoreDir(currentApp()));
    const run = num(args.run) ?? st.one<{ m: number }>("SELECT max(run) m FROM runs")?.m;
    const rows = st.sql<any>("SELECT id, action_id, method, url, status, substr(req_body,1,120) body FROM requests WHERE run=? AND method NOT IN ('GET','HEAD','OPTIONS') AND resource_type NOT IN ('script','stylesheet','image','font','media','texttrack','manifest') ORDER BY t_start", run);
    if (json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log(`run ${run}: no writes`);
    else for (const r of rows) console.log(`${r.id}\t${r.action_id ?? "—"}\t${r.method} ${r.url} ${r.status ?? "…"}${r.body ? "\t" + r.body : ""}`);
    st.close();
    break;
  }
  case "note": {
    const text = args._.slice(1).join(" "); if (!text) fail("usage: disco note <text>");
    await withSession(async (s) => { s.note(text); });
    console.log("noted");
    break;
  }
  case "record": {
    const app = currentApp();
    const info = readBrowserInfo(appStoreDir(app));
    if (!info) fail(`no browser for app ${app}`);
    if (pidAlive(info.recorderPid) && info.recorderPid !== process.pid) fail(`a recorder is already running for ${app} (pid ${info.recorderPid})`);
    const s = await open(app, { recorder: true, dialogs: (args.dialogs as any) ?? "accept" });
    writeBrowserInfo(s.log.dir, { ...(readBrowserInfo(s.log.dir) ?? info), recorderPid: process.pid });
    if (args.detached !== true) console.log(`recording ${s.app} (run ${s.log.run}) — Ctrl-C to stop`);
    await new Promise<void>((resolve) => { process.on("SIGINT", () => resolve()); process.on("SIGTERM", () => resolve()); s.browser.on("disconnected", () => resolve()); });
    await s.close();
    const cur = readBrowserInfo(s.log.dir); if (cur?.recorderPid === process.pid) writeBrowserInfo(s.log.dir, { ...cur, recorderPid: undefined });
    break;
  }
  case "pages": {
    await withSession(async (s) => {
      if (args["close-others"] === true) console.log(`closed ${await s.closeOtherPages()}`);
      else if (args.close !== undefined) { const p = s.context.pages()[Number(args.close)]; if (!p || p === s.page) fail("--close <n>: not a closable page index (see ./disco pages)"); await p.close(); console.log("closed"); }
      s.context.pages().forEach((p, i) => console.log(`${i}\t${p === s.page ? "*" : " "}\t${p.url()}`));
    });
    break;
  }
  default: fail(`unknown command ${cmd}\n\n${HELP}`);
} }
