#!/usr/bin/env bun
// `disco` — thin command surface over the daemon RPC and the store (GUIDANCE §3.1). Every convenience
// here is sugar over `disco sql` / `disco eval` / the library; see README for desugarings.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcClient } from "../src/rpc.ts";
import { openStore, readManifest, blobPath } from "../src/store.ts";
import { launchChromium } from "../src/launch.ts";
import { defaults } from "../defaults.ts";

const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) { const k = a.slice(2); const nxt = argv[i + 1]; if (nxt !== undefined && !nxt.startsWith("--")) { flags[k] = nxt; i++; } else flags[k] = true; }
  else pos.push(a);
}
const f = (k: string): string | undefined => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
const has = (k: string) => flags[k] !== undefined;
const appsDir = () => resolve(f("dir") ?? process.env.DISCO_APPS_DIR ?? join(process.cwd(), "apps"));
const storeDirFor = (product: string) => join(appsDir(), product, "store");
const out = (o: unknown) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, has("compact") ? 0 : 2));
const die = (m: string, code = 1): never => { console.error(m); process.exit(code); };
const hasStore = (d: string) => existsSync(join(d, "store.sqlite")) || existsSync(join(d, "manifest.json"));

/** Resolve a selector to a product's STORE dir (apps/<product>/store). Accepts a product name, a path, or the current app. */
function sessionDir(sel?: string): string {
  const s = sel ?? f("app") ?? f("session") ?? process.env.DISCO_APP ?? process.env.DISCO_SESSION;
  if (s) {
    if (hasStore(s)) return resolve(s);                              // a path to a store dir
    if (hasStore(join(s, "store"))) return resolve(join(s, "store")); // a path to a product home
    const d = storeDirFor(s); if (hasStore(d)) return d;             // a product name
    die(`no app "${s}" (looked in ${appsDir()})`);
  }
  const cur = join(appsDir(), ".current");
  if (existsSync(cur)) { const d = storeDirFor(readFileSync(cur, "utf8").trim()); if (hasStore(d)) return d; }
  return die(`no current app; run \`disco session new <product> --attach <port> --scope <url-part>\` or pass --app <product>`);
}
async function client(dir = sessionDir()): Promise<RpcClient> {
  const sock = join(dir, "daemon.sock");
  if (!existsSync(sock)) die(`daemon not running for ${dir} (no daemon.sock). Store queries still work: disco sql "…"`);
  return RpcClient.connect(sock);
}
async function withClient<T>(fn: (c: RpcClient) => Promise<T>): Promise<T> { const c = await client(); try { return await fn(c); } finally { c.close(); } }

const HELP = `disco — discovery daemon CLI

session new <product> (--attach <port> [--host h] | --launch [--headless] [--url u]) [--scope <substr|/re/>] [--run name] [--dialogs accept|dismiss] [--no-idle] [--idle-ms N] [--ignore <url-part>]… [--fg]
                              (open the app in the browser FIRST: the 30s idle observation learns its ambient traffic; skipped when nothing is scoped)
session end [product]         end current run; next 'session new' starts another
session ls | info             list apps (runs per app) / current run info
targets                       scoped targets + frames (primary = where act/watch/eval/screenshot go without --target)
focus <id-prefix|url-part>    make another scoped page the primary target
tail [--from seq]             stream digested events as JSONL (Ctrl-C to stop)
schema [table]                the store's tables + columns (what sql can select)
sql [<product>] <query> [--json|--wide]  query one app's whole history (every run, tagged by run; t restarts per run); read-only; cells cut at 60 chars (--wide: 200; --json: all)
note "<text>" [--kind state|transition|ledger|note] [--name n] [--action act:N] [--data json]
families [--mark-read F] [--ambient F|url-part] [--not-ambient F|url-part] [--forget]   learned families + evidence; a url-part becomes a persistent rule
rules [--remove id] [--json]  per-app overrides: attribution rules + sentinel mutes (persist across runs)
sentinels [--mute name [--selector s] [--text t] [--url u]] [--unmute id]   mute noisy sentinels (recorded, not reported)
idle [ms] [--json]            idle-observe to warm the ambient classifier; prints the ambient digest (--json: full families)
screenshot [--out file.jpg]   capture now; prints the blob hash
blob|body <hash|prefix> [--out file]  copy a blob out / print text (any hash argument accepts a prefix, e.g. the 12-char handles in reports)
eval "<fn source>" [--frame f] [--world main] [--args json]   run an in-page function, e.g. "() => document.title"
cdp <Method> [json params] [--target id | --browser]
act <kind> [target] [--frame f] [--target id-prefix|url-part] [--budget ms] [--eval "fn"] [--until sel [--until-visible] | --until-fn "fn" | --until-url part [--until-landed]] [--until-budget ms] [--until-tail ms] [--json]
                              kind: click|rightclick|dblclick|middleclick|hover|type(--text)|fill(--text, replaces)|press(key)|scroll|select(--value)|navigate(url)|drag(--to|--to-dx/--to-dy)
settle [--action act:N] [--budget ms]   re-arm / extend settlement without acting
watch <selector> [--visible] | --url-like part [--landed] | --fn "fn" [--fn-arg json] [--budget ms]   evidence-driven wait; diagnosis on expiry
Select an app via --app <product> (or --session / DISCO_APP / the current app). One home per app: apps/<product>/ (committed pack) + apps/<product>/store/ (gitignored history: one run-tagged SQLite + blobs + stream.jsonl).`;

const cmd = pos[0];
switch (cmd) {
  case undefined: case "help": case "--help": out(HELP); break;

  case "session": {
    const sub = pos[1];
    if (sub === "new") {
      const product = pos[2] ?? die("session new <product>");
      const dir = storeDirFor(product);
      if (existsSync(join(dir, "daemon.sock"))) die(`an active run already exists for "${product}" (one run per app at a time) — \`disco session end ${product}\` first, or reconnect`);
      mkdirSync(dir, { recursive: true });
      const runName = f("run") ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
      const daemonArgs = ["--dir", dir, "--name", runName, "--product", product];
      let launchedPid: number | undefined;
      if (has("launch")) {
        // Launch on about:blank and navigate AFTER the daemon has attached, so the top-level document load is
        // observed (act:1) instead of being an unobserved prefix (stranger #3 friction #1).
        const l = await launchChromium({ headless: has("headless"), userDataDir: join(dir, "profile") });
        launchedPid = l.pid;
        daemonArgs.push("--attach", String(l.port), "--launched-pid", String(l.pid), "--user-data-dir", l.userDataDir, "--mode", "launch");
        if (has("headless")) daemonArgs.push("--headless");
        console.error(`launched chromium pid=${l.pid} port=${l.port}`);
        l.proc.unref();
      } else if (has("attach")) {
        daemonArgs.push("--attach", String(f("attach")));
        if (f("host")) daemonArgs.push("--host", f("host")!);
        if (has("pick") && !f("pick")) { // list tabs and exit (review F2 / BRIEF §1.15)
          const pages = (await (await fetch(`http://${f("host") ?? "127.0.0.1"}:${f("attach")}/json/list`)).json() as any[]).filter((x) => x.type === "page");
          for (const [i2, t] of pages.entries()) console.log(`${i2 + 1}. ${t.title?.slice(0, 40) ?? ""}  ${t.url}`);
          die("re-run with --pick <n> (or --scope <url-part>)");
        }
        if (f("pick")) {
          const pages = (await (await fetch(`http://${f("host") ?? "127.0.0.1"}:${f("attach")}/json/list`)).json() as any[]).filter((x) => x.type === "page");
          const t = pages[Number(f("pick")) - 1] ?? pages.find((x) => x.id.startsWith(f("pick")!) || x.url.includes(f("pick")!));
          if (!t) die(`--pick ${f("pick")}: no such tab`);
          daemonArgs.push("--scope-target", t.id);
          console.error(`picked tab: ${t.url}`);
        } else if (!f("scope") && !has("all-targets")) {
          die("attach mode requires --scope <url-part> or --pick (or explicit --all-targets to record EVERY tab — GUIDANCE §3.2)");
        }
        if (has("all-targets")) daemonArgs.push("--all-targets");
      } else die("session new needs --attach <port> or --launch");
      if (f("scope")) daemonArgs.push("--scope", f("scope")!);
      if (f("dialogs")) daemonArgs.push("--dialogs", f("dialogs")!);
      const ignores = argv.flatMap((a, i) => (a === "--ignore" && argv[i + 1] ? [argv[i + 1]] : []));
      const daemonPath = join(import.meta.dir, "..", "src", "daemon.ts");
      if (f("state") && !has("launch")) console.error("--state only applies with --launch");
      if (has("fg")) {
        const p = Bun.spawn(["bun", daemonPath, ...daemonArgs, "--fg"], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
        writeFileSync(join(appsDir(), ".current"), product);
        await p.exited; break;
      }
      const setsid = Bun.which("setsid");
      const logFile = Bun.file(join(dir, "daemon.out"));
      const p = Bun.spawn([...(setsid ? [setsid] : []), "bun", daemonPath, ...daemonArgs], { stdout: logFile, stderr: logFile, stdin: "ignore" });
      p.unref();
      const sock = join(dir, "daemon.sock");
      const t0 = Date.now();
      while (!existsSync(sock)) { if (Date.now() - t0 > 15000) die(`daemon did not start; see ${join(dir, "daemon.out")}`); await new Promise((r) => setTimeout(r, 100)); }
      writeFileSync(join(appsDir(), ".current"), product);
      const c = await RpcClient.connect(sock);
      if (f("state") && has("launch")) { await c.call("state.restore", { state: JSON.parse(readFileSync(f("state")!, "utf8")) }); console.error("storage state restored"); }
      let info = await c.call("session.info");
      if (has("launch") && f("url")) {
        // launched on about:blank; navigate now that the daemon is attached, so the document load is observed as act:1
        const nav = await c.call("act", { kind: "navigate", url: f("url"), budgetMs: 8000, maxBudgetMs: 12000, until: { fn: "() => document.readyState === \"complete\"", budgetMs: 20000, tailMs: 1500 } }, 90000).catch((e: Error) => { console.error(`navigate failed: ${e.message}`); return null; });
        if (nav) console.error(`${nav.action}  navigate ${f("url")}  →  ${nav.verdict}${nav.settle ? ` (settled ${nav.settle.ms}ms; ${nav.settle.counts?.requests ?? 0} req)` : ""}`);
        info = await c.call("session.info");
      }
      // What did we attach to? A bot challenge (Cloudflare Turnstile, hCaptcha, Akamai, PerimeterX…) is a 403 page
      // that a script mistakes for "loading" — name it now (GUIDANCE §8) instead of letting the run invest in it.
      try {
        // the document may still be loading right after attach: give it up to 4s to have a title/body
        let v: any = {};
        for (let i = 0; i < 20; i++) {
          const probe = await c.call("evaluate", { fn: "() => ({ ready: document.readyState, title: document.title, html: (document.documentElement && document.documentElement.outerHTML || '').slice(0, 40000) })", world: "main" }).catch(() => null);
          v = probe?.value ?? {};
          if (v.ready === "complete" && (String(v.title ?? "") || String(v.html ?? "").length > 200)) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const h = String(v.html ?? ""); const t = String(v.title ?? "");
        const challenge = /challenges\.cloudflare\.com|cf-chl|cf_chl|turnstile|hcaptcha\.com|_Incapsula_|perimeterx|px-captcha|akamai.*bot|distil_/i.test(h) || /^just a moment|attention required|access denied|are you a human|verify you are human/i.test(t);
        if (challenge) console.error(`⚠ the page you attached to looks like a BOT CHALLENGE (title ${JSON.stringify(t.slice(0, 60))}). A headless browser will not pass it by waiting — attach to a real browser that has passed it, or use another host. Everything recorded from here is the challenge, not the app.`);
      } catch {}
      for (const ig of ignores) { const r = await c.call("rules.add", { kind: "ambient", match: ig, note: "session new --ignore" }); console.error(`rule #${r.id}: requests whose URL contains ${JSON.stringify(ig)} are ambient`); }
      console.error(`app "${product}" — run ${info.manifest.run} ${info.resumed ? "(resumed)" : "(new)"} (${info.manifest.mode}, scope=${info.manifest.scope ?? "all"}); ${info.targets.length} scoped target(s)`);
      for (const t of info.targets) console.error(`  ${t.targetId.slice(0, 8)} ${t.type} ${t.url}`);
      if (!has("no-idle") && info.targets.length === 0) {
        console.error(`0 scoped targets — skipping idle observation (nothing to learn from yet). Open the app in that browser, then \`disco idle ${defaults.idleObserveMs}\` to learn its ambient traffic.`);
      } else if (!has("no-idle")) {
        const ms = Number(f("idle-ms") ?? defaults.idleObserveMs);
        console.error(`idle-observing ${ms}ms to learn ambient traffic (--no-idle to skip)…`);
        const r = await c.call("idle", { ms }, ms + 10000);
        console.error(`families: ${r.families.length}, ambient: ${r.families.filter((x: any) => x.ambient).length}${r.immature ? " (classifier still immature)" : ""}`);
        for (const fam of r.families) console.error(`  ${fam.ambient ? "ambient " : "        "} ${fam.family} ×${fam.count}${fam.reason ? " " + fam.reason : ""}`);
      }
      c.close();
      out({ product, run: info.manifest.run, dir, pid: launchedPid, sock });
    } else if (sub === "end") {
      const dir = sessionDir(pos[2]);
      const c = await client(dir); await c.call("session.end"); c.close();
      const t0 = Date.now(); while (existsSync(join(dir, "daemon.sock")) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
      console.error(`run ended: ${dir}`);
    } else if (sub === "ls") {
      const root = appsDir();
      if (!existsSync(root)) { out([]); break; }
      const cur = existsSync(join(root, ".current")) ? readFileSync(join(root, ".current"), "utf8").trim() : null;
      for (const product of readdirSync(root)) {
        const dir = storeDirFor(product);
        if (!existsSync(join(dir, "store.sqlite"))) continue;
        const st = openStore(dir); const runs = st.runs(); st.close();
        const running = existsSync(join(dir, "daemon.sock"));
        const last = runs[0];
        console.log(`${product === cur ? "*" : " "} ${product.padEnd(20)} ${String(runs.length).padStart(3)} run(s)  ${running ? "running" : "stopped"}  last: ${last ? last.started_wall + (last.ended_wall ? "" : " (open)") : "-"}`);
      }
    } else if (sub === "info") {
      out(await withClient((c) => c.call("session.info")));
    } else die("session new|end|ls|info");
    break;
  }

  case "state": {
    const sub = pos[1];
    if (sub === "save") {
      const st = await withClient((c) => c.call("state.save"));
      const dest = f("out") ?? "storage-state.json";
      writeFileSync(dest, JSON.stringify(st, null, 2));
      console.error(`saved ${(st.cookies as unknown[]).length} cookie(s), ${st.origins.length} origin(s) → ${dest}`);
    } else if (sub === "restore") {
      const file = pos[2] ?? f("file") ?? die("state restore <file>");
      out(await withClient((c) => c.call("state.restore", { state: JSON.parse(readFileSync(file, "utf8")) })));
    } else die("state save [--out f] | state restore <f>");
    break;
  }

  case "targets": out(await withClient((c) => c.call("targets"))); break;

  case "rules": {
    // per-app overrides: attribution rules (URL substrings) and sentinel mutes — persist across runs
    await withClient(async (c) => {
      if (f("remove")) { await c.call("rules.remove", { id: Number(f("remove")) }); console.error(`rule #${f("remove")} removed`); }
      const rows: any[] = await c.call("rules.list");
      if (has("json")) return out(rows);
      if (!rows.length) return console.log("(no rules)  — disco families --ambient|--not-ambient <url-part>; disco sentinels --mute <name> [--selector s] [--text t] [--url u]");
      for (const r of rows) console.log(`#${String(r.id).padStart(3)}  ${String(r.kind).padEnd(14)} ${r.match}${r.note ? "   # " + r.note : ""}`);
    });
    break;
  }

  case "sentinels": {
    await withClient(async (c) => {
      if (f("mute")) { const r = await c.call("rules.add", { kind: "mute-sentinel", name: f("mute"), selector: f("selector"), text: f("text"), url: f("url"), note: f("note") }); console.error(`rule #${r.id}: ${f("mute")} sentinels matching ${r.match} are muted (recorded with muted=1, not reported)`); }
      if (f("unmute")) { await c.call("rules.remove", { id: Number(f("unmute")) }); console.error(`rule #${f("unmute")} removed`); }
      const rows: any[] = (await c.call("rules.list")).filter((r: any) => r.kind === "mute-sentinel");
      console.log(rows.length ? rows.map((r: any) => `#${r.id}  mute ${r.match}`).join("\n") : "(no sentinel mutes)");
    });
    const st = openStore(sessionDir());
    const counts = st.sql<any>("SELECT name, SUM(muted=0) live, SUM(muted=1) muted FROM sentinels WHERE run=(SELECT max(run) FROM runs) GROUP BY name ORDER BY live DESC"); st.close();
    for (const x of counts) console.log(`  ${String(x.name).padEnd(15)} ${String(x.live).padStart(4)} reported  ${String(x.muted).padStart(4)} muted   (this run)`);
    break;
  }

  case "focus": {
    // make a scoped page the PRIMARY target — where act/watch/eval/screenshot go when no --target is given.
    // (The primary is the first scoped page attached, or the last one focused; a popup that opens later can
    // become the only page if the first is closed. `disco targets` shows `primary`.)
    const spec = pos[1] ?? die("focus <target-id-prefix | url-part>");
    await withClient(async (c) => {
      const ts: any[] = await c.call("targets");
      const t = ts.find((x) => x.targetId.startsWith(spec) || String(x.url).includes(spec)) ?? die(`focus: no scoped target matches ${JSON.stringify(spec)}`);
      await c.call("focus", { targetId: t.targetId });
      console.error(`primary: ${t.targetId.slice(0, 8)} ${t.url}`);
    });
    break;
  }

  case "tail": {
    const c = await client();
    c.onEvent((ev) => console.log(JSON.stringify(ev)));
    const r = await c.call("subscribe");
    console.error(`tailing from seq ${r.lastSeq} (Ctrl-C to stop)`);
    await new Promise(() => {});
    break;
  }

  case "schema": {
    // the store's tables and columns, from the live DB (schema.sql is the source; this is what THIS store has)
    const st = openStore(pos[2] ? sessionDir(pos[1]) : sessionDir());
    const tables = st.sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name").map((r) => r.name);
    for (const t of tables.filter((t) => !pos[1] || pos[2] || t === pos[1] || t.includes(pos[1]))) console.log(`${t}(${st.sql<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name).join(", ")})`);
    st.close();
    break;
  }

  case "sql": {
    // "disco sql <query>" (current app) or "disco sql <product> <query>"
    const q = (pos[2] ?? pos[1]) ?? die("sql [<product>] <query>");
    const s = openStore(pos[2] ? sessionDir(pos[1]) : sessionDir());
    let rows: any[] = [];
    try { rows = s.sql(q); } catch (e) { s.close(); die("sql error: " + (e as Error).message + "  (schema: schema.sql, or: disco sql \"SELECT name FROM sqlite_master WHERE type=" + String.fromCharCode(39) + "table" + String.fromCharCode(39) + "\")"); }
    if (has("json")) out(rows);
    else if (!rows.length) console.log("(no rows)");
    else {
      const cols = Object.keys(rows[0]);
      const MAX = has("wide") ? 200 : 60; let cut = false;
      const cell = (v: unknown) => { const s = String(v ?? "").replace(/\n/g, " "); if (s.length <= MAX) return s; cut = true; return s.slice(0, MAX - 1) + "…"; };
      const w = cols.map((c) => Math.min(MAX, Math.max(c.length, ...rows.map((r: any) => String(r[c] ?? "").length))));
      console.log(cols.map((c, i) => c.padEnd(w[i])).join("  "));
      for (const r of rows) console.log(cols.map((c, i) => cell(r[c]).padEnd(w[i])).join("  "));
      console.log(`(${rows.length} rows${cut ? `; cells cut at ${MAX} chars — --json for full values; hashes accept any prefix` : ""})`);
    }
    s.close();
    break;
  }

  case "note": {
    const text = pos[1] ?? die('note "<text>"');
    out(await withClient((c) => c.call("note", { kind: f("kind") ?? "note", name: f("name"), action: f("action"), text, data: f("data") ? JSON.parse(f("data")!) : undefined })));
    break;
  }

  case "families": {
    await withClient(async (c) => {
      if (f("mark-read")) await c.call("family.mark", { family: f("mark-read"), read: true });
      if (has("forget")) { await c.call("families.forget"); console.error("learned families cleared (rules kept)"); }
      // --ambient / --not-ambient take a family name (exact) OR a URL substring → a persistent rule (DECISIONS #43)
      for (const [flag, kind, ambient] of [["ambient", "ambient", true], ["not-ambient", "not-ambient", false]] as const) {
        const v = f(flag); if (!v) continue;
        const fams0: any[] = await c.call("families");
        if (fams0.some((x) => x.family === v)) await c.call("family.mark", { family: v, ambient });
        else { const r = await c.call("rules.add", { kind, match: v }); console.error(`rule #${r.id}: requests whose URL contains ${JSON.stringify(v)} are ${kind} (persists for this app; \`disco rules\` lists, --remove <id> drops)`); }
      }
      const fams = await c.call("families");
      console.log(`${"".padEnd(8)} ${"write".padEnd(7)} ${"count".padStart(4)}  family  (ambient reason)   — ambient = periodic (≥${defaults.ambientMinCount} samples, gap cv ≤ ${defaults.ambientMaxCv}) or chained long-poll, seen while no action window was open; excluded from attribution AND settlement`);
      const cadence = (x: any) => { const g: number[] = x.evidence?.gaps ?? []; if (x.ambient || !g.length) return ""; const need = Math.max(0, defaults.ambientMinCount - (x.count ?? 0)); return `  gaps ${g.slice(-3).map((v: number) => v >= 1000 ? Math.round(v / 1000) + "s" : v + "ms").join(",")}${x.evidence?.cv != null ? " cv " + x.evidence.cv : ""}${need ? ` — ${need} more sample${need > 1 ? "s" : ""} to classify` : x.evidence?.outsideWindow === 0 ? " — never seen outside an action window" : ""}`; };
      for (const x of fams) console.log(`${x.ambient ? "ambient " : "        "} ${x.writeKind.padEnd(7)} ${String(x.count).padStart(4)}  ${x.family}${x.reason ? "  (" + x.reason + ")" : ""}${cadence(x)}`);
    });
    break;
  }

  case "idle": {
    const ms = Number(pos[1] ?? defaults.idleObserveMs);
    const r = await withClient((c) => c.call("idle", { ms }, ms + 10000));
    if (has("json")) { out(r); break; }
    const fams: any[] = r.families ?? [];
    console.log(`idle-observed ${ms}ms: ${fams.length} families, ${fams.filter((x) => x.ambient).length} ambient${r.immature ? "  (classifier still immature — keep going, or act and read the reports' progress line)" : ""}`);
    for (const fam of fams.filter((x) => x.ambient)) console.log(`  ambient  ${fam.family} ×${fam.count}${fam.reason ? " (" + fam.reason + ")" : ""}`);
    if (fams.some((x) => !x.ambient)) console.log(`  (${fams.filter((x) => !x.ambient).length} non-ambient families — \`disco families\` lists them with evidence; --json for the full table)`);
    break;
  }

  case "screenshot": {
    const r = await withClient((c) => c.call("screenshot", { targetId: f("target") }));
    if (f("out")) { copyFileSync(blobPath(sessionDir(), r.hash), f("out")!); console.error(`wrote ${f("out")}`); }
    out(r);
    break;
  }

  case "body": case "blob": {
    const hash = pos[1] ?? die("blob <hash-or-prefix>");
    const st = openStore(sessionDir());
    let p: string; try { p = st.blobPath(hash); } finally { st.close(); }
    if (!existsSync(p)) die(`no blob ${hash}`);
    if (f("out")) { copyFileSync(p, f("out")!); console.error(`wrote ${f("out")}`); }
    else process.stdout.write(readFileSync(p));
    break;
  }

  case "eval": {
    const fn = pos[1] ?? die('eval "<function source>"');
    out(await withClient((c) => c.call("evaluate", { fn, frame: f("frame"), world: f("world"), args: f("args") ? JSON.parse(f("args")!) : [] })));
    break;
  }

  case "cdp": {
    const method = pos[1] ?? die("cdp <Method> [json]");
    out(await withClient((c) => c.call("cdp.send", { method, params: pos[2] ? JSON.parse(pos[2]) : {}, targetId: f("target"), browser: has("browser") })));
    break;
  }

  default: {
    // Slice 2+ commands are registered in cli/commands.ts
    const mod = await import("./commands.ts").catch(() => null);
    if (mod && (mod as any).run) { await (mod as any).run(cmd, pos.slice(1), flags, { client, sessionDir, out, die }); break; }
    die(`unknown command "${cmd}"\n\n${HELP}`);
  }
}
