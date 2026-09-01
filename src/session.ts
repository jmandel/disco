// The surface. open → Session with three verbs: look (the screen), act (any Playwright code, bracketed by an
// observation that returns when the app is quiet or your until holds), sql (the log). Plus waitFor over the
// recorder's event stream, body/json for bodies, and reached to assert a report.
import { mkdirSync } from "node:fs";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { Store, appStoreDir, appDir, openStore, type StoreReader } from "./store.ts";
import { attachRecorder, type Recorder, type EventKind, type Events } from "./record.ts";
import { readBrowserInfo, writeBrowserInfo, isAlive, launchChromium, attachEndpoint, connect, killLaunched, pidAlive, type BrowserInfo } from "./browser.ts";
import { lookAt, controls, inspect, dialogCensus, locatorFromDescription, type Look, type LookCtx } from "./look.ts";
import { formatReport } from "./format.ts";

export interface OpenOptions {
  /** navigate after connecting (launch) — or pick the page containing it (attach / rejoin) */
  url?: string;
  /** a running browser: port, host:port, http://…, or ws://… ; omit to launch (or rejoin the one launched before) */
  attach?: string | number;
  headed?: boolean;
  /** where apps/<app>/ lives (default: apps/ next to this checkout, or $DISCO_APPS_DIR) */
  appsDir?: string;
  /** @internal this process IS the detached recorder */
  recorder?: boolean;
}

export interface ActOptions {
  /** Armed before `run`; the act returns the moment it resolves. Flagged `alreadyTrue` when it resolved before `run` was dispatched. */
  until?: () => Promise<unknown>;
  /** Without `until`: return once nothing has happened for this long — no request, response, frame, console line, dialog, navigation or DOM change. Default 500. */
  quiet?: number;
  /** The one budget of an act: the default timeout of every Playwright call inside `run` and `until`, and the longest the act observes. Default 3000. */
  max?: number;
}

export interface Diagnosis {
  reason: "not-found" | "hidden" | "disabled" | "occluded" | "offscreen" | "unclickable" | "detached" | "timeout" | "error";
  message: string;
  /** the locator Playwright named in its message, as it printed it */
  selector?: string;
  over?: string;
  candidates?: string[];
  dialogs?: string[];
  shot?: string;
}
export interface WireLine { id: string; method: string; path: string; status?: number | null; ms?: number | null; mime?: string | null; body?: string | null; size?: number | null; state?: string | null; type?: string | null; earlier?: boolean }
export interface Proposal { kind: "response" | "appeared" | "gone" | "url" | "storage"; code: string; atMs: number | null }
export interface Report<T = unknown> {
  action: string;              // act:<n> — the id every log row inside the window carries
  label: string;
  ok: boolean;                 // the code ran without throwing (a failed until leaves ok: true — read until.ok; reached() checks both)
  value?: T;
  diagnosis?: Diagnosis;
  /** why the observation ended: your until held · the app went quiet · max expired · the code threw */
  returned: "until" | "quiet" | "max" | "error";
  until?: { ok: boolean; elapsedMs: number; alreadyTrue?: boolean; error?: string; /** what your until resolved with — label your Promise.race arms and this says which */ value?: unknown };
  url: string;
  ui: { added: string[]; removed: string[]; more?: number };
  requests: WireLine[];
  static: { count: number; types: Record<string, number> };
  /** requests started in the window and still in flight when it closed */
  pending: string[];
  /** the non-GET app requests in the window — what this act may have persisted */
  writes: string[];
  storage: { cookies: string[]; local: string[]; session: string[] };
  console: Array<{ level: string; text: string }>;
  dialogs: Array<{ type: string; message: string | null; handled: string | null }>;
  pages: string[];
  openPages: number;
  /** pasteable until code for what this act caused — each was false before the action */
  proposed: Proposal[];
  note?: string;
  window: { t0: number; t1: number };
  timing: { runMs: number; observeMs: number; reportMs: number; totalMs: number };
}

const DEFAULT_MAX = 3000;
const DEFAULT_QUIET = 500;
const STATIC_TYPES = new Set(["script", "stylesheet", "image", "font", "media", "texttrack", "manifest"]);

function originOf(u: string): string { try { return new URL(u).origin; } catch { return ""; } }
function sameUrl(a: string, b: string): boolean { const n = (x: string) => x.replace(/#.*$/, "").replace(/\/+$/, ""); return n(a) === n(b); }
const isScratch = (p: Page) => { try { return p.url().startsWith("data:"); } catch { return false; } };

export async function open(app: string, opts: OpenOptions = {}): Promise<Session> {
  const dir = appDir(app, opts.appsDir);
  const storeDir = appStoreDir(app, opts.appsDir);
  mkdirSync(storeDir, { recursive: true });
  let info = readBrowserInfo(storeDir);
  let fresh = false;
  if (opts.attach !== undefined) {
    info = { mode: "attach", endpoint: attachEndpoint(opts.attach), startedWall: new Date().toISOString() };
    writeBrowserInfo(storeDir, info); fresh = true;
  } else if (!info || !(await isAlive(info.endpoint))) {
    info = await launchChromium(storeDir, { headed: opts.headed }); fresh = true;
  }
  const browser = await connect(info);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages().filter((p) => !isScratch(p));
  // pages() is not in creation order after a reconnect: prefer the page already at `url` (then its origin), never a popup by accident
  let page: Page | undefined;
  if (opts.url) page = pages.find((p) => sameUrl(p.url(), opts.url!)) ?? pages.find((p) => p.url().includes(opts.url!)) ?? pages.find((p) => originOf(p.url()) === originOf(opts.url!));
  page = page ?? pages[0] ?? (await context.newPage());
  await page.bringToFront().catch(() => {});
  const store = new Store(storeDir);
  if (fresh || !store.resumeRun()) store.beginRun({ url: opts.url ?? page.url(), mode: info.mode });
  // a detached `disco _record` process may already be capturing this browser: then this session only acts
  const external = !opts.recorder && pidAlive(info.recorderPid);
  const s = new Session(app, dir, store, browser, context, page, info, !external);
  await Session._ready(s);
  // navigate when we just launched, or when the page is somewhere else; joining a browser that is already there leaves its state alone
  if (opts.url && (fresh || !sameUrl(page.url(), opts.url))) await page.goto(opts.url, { waitUntil: "load", timeout: 15000 }).catch(() => {});
  return s;
}

export class Session {
  app: string;
  /** apps/<app>/ — where the pack lives. */
  dir: string;
  /** The run this session records into (one browser's life = one run; a script that joins a live browser joins its run). */
  run: number;
  /** The Playwright page. This is what your `act` code drives. */
  page: Page;
  context: BrowserContext;
  browser: Browser;

  #store: Store;
  #reader: StoreReader | null = null;
  #recorder: Recorder;
  #info: BrowserInfo;
  #recording: boolean;
  #current: string | null = null;
  #max = DEFAULT_MAX;

  /** @internal */
  constructor(app: string, dir: string, store: Store, browser: Browser, context: BrowserContext, page: Page, info: BrowserInfo, recording: boolean) {
    this.app = app; this.dir = dir; this.#store = store; this.browser = browser; this.context = context; this.page = page; this.#info = info; this.#recording = recording; this.run = store.run;
    page.setDefaultTimeout(DEFAULT_MAX);
    if (recording) store.update("requests", { body_state: "missing", error: "body not read by the page" }, "body_state='pending' AND status IS NOT NULL AND t_response < ?", [store.now() - 1500]);
    this.#recorder = attachRecorder(context, store, () => this.#current, "accept", { silent: !recording });
  }
  /** @internal */ static _ready(s: Session): Promise<void> { return s.#recorder.ready; }

  /** Disconnect. `{ browser: true }` also kills a browser disco launched (an attached one is only forgotten). A script that never closes never exits. */
  async close(o: { browser?: boolean } = {}): Promise<void> {
    await this.#recorder.flush(500);
    this.#recorder.detach();
    if (this.#recording) this.#store.update("requests", { body_state: "missing", error: "body not read by the page (session closed)" }, "run=? AND body_state='pending' AND status IS NOT NULL", [this.#store.run]);
    if (o.browser) { this.#store.endRun(); killLaunched(this.#info); writeBrowserInfo(this.#store.dir, null); }
    try { await this.browser.close(); } catch {}
    this.#reader?.close(); this.#store.close();
  }

  /** The screen: aria tree, numbered controls with durable selectors, a marked-up screenshot. With a selector or Locator: what it matches, where, and what is under the pointer. */
  look(target?: string | Locator): Promise<Look> { return lookAt(this.#ctx(), target); }

  /** Run any Playwright code as one observed step. Returns when your `until` holds, when the app has been quiet, or at `max`. */
  async act<T = unknown>(label: string, run: (page: Page) => Promise<T> | T, opts: ActOptions = {}): Promise<Report<T>> {
    const quiet = opts.quiet ?? DEFAULT_QUIET, max = opts.max ?? DEFAULT_MAX;
    const store = this.#store, rec = this.#recorder, page = this.page;
    const n = store.nextActionN(); const id = `act:${n}`;
    const tStart = performance.now();
    page.setDefaultTimeout(max); page.setDefaultNavigationTimeout(max); this.#max = max;
    // The until is armed first, before the pre-snapshots — a response that lands during them still counts; one that already
    // held resolves during them and is flagged. A navigation is the one case where "already true" is legitimate: arm late there? No —
    // the agent's until code decides; page.waitForURL on the new document is false before the click.
    const armed = { done: false, resolvedAt: undefined as number | undefined, error: undefined as string | undefined, value: undefined as unknown };
    let untilP: Promise<unknown> | null = null;
    if (opts.until) {
      try { untilP = Promise.resolve(opts.until()); } catch (e) { untilP = Promise.reject(e); }
      untilP.then((v) => { armed.done = true; armed.resolvedAt = performance.now(); armed.value = v; }, (e) => { armed.done = true; armed.error = firstLine(e); });
    }
    const preAria = await this.#aria();
    const preStorage = await this.#storage();
    const preUrl = safe(() => page.url(), "");
    const t0 = store.now();
    store.insert("actions", { id, n, t0, label, code: fnSource(run) });
    this.#current = id;
    if (this.context.pages().filter((p) => !isScratch(p)).length > 1) await page.bringToFront().catch(() => {});
    const tDispatch = performance.now();
    let ok = true, value: T | undefined, runError: unknown, landedNote: string | undefined;
    try { value = await run(page); } catch (e) {
      // Playwright's click can time out AFTER the click was performed: a handler that blocks the main thread past max.
      // The click landed; say so and keep observing, so the until (or quiet) still decides.
      const m = String((e as Error)?.message ?? e).replace(/\x1b\[\d+m/g, "");
      const lastLog = m.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
      if (/click: Timeout/.test(m) && /^- (performing click action|click action done|waiting for scheduled navigations|navigations have finished)/.test(lastLog)) landedNote = `the click landed but the page did not respond within max (${max} ms) — a handler blocked the main thread; the observation continued`;
      else { ok = false; runError = e; }
    }
    const tRun1 = performance.now();
    let returned: Report["returned"];
    let until: Report["until"];
    if (!ok) {
      returned = "error";
      if (untilP) { until = { ok: false, elapsedMs: 0, error: "the code threw before the until could be judged" }; untilP.catch(() => {}); }
    } else if (untilP) {
      const remaining = Math.max(0, max - (tRun1 - tDispatch));
      if (!armed.done) await Promise.race([untilP.catch(() => {}), sleep(remaining)]);
      if (armed.done && !armed.error) { returned = "until"; until = { ok: true, elapsedMs: Math.max(0, ms(tDispatch, armed.resolvedAt!)) }; if (armed.resolvedAt! <= tDispatch) until.alreadyTrue = true; if (armed.value !== undefined && (typeof armed.value !== "object" || armed.value === null)) until.value = armed.value; }
      else { returned = "max"; until = { ok: false, elapsedMs: ms(tDispatch, performance.now()), error: armed.error ?? `did not hold within max (${max} ms)` }; untilP.catch(() => {}); }
    } else {
      const deadline = tDispatch + max;
      let prev = await this.#fingerprint();
      for (;;) {
        const left = deadline - performance.now();
        if (left <= 0) { returned = "max"; break; }
        await sleep(Math.min(quiet, left));
        const cur = await this.#fingerprint();
        const idle = store.now() - rec.lastActivity();
        const awaiting = store.get<{ n: number }>("SELECT count(*) n FROM requests WHERE run=? AND t_start >= ? AND t_response IS NULL AND t_end IS NULL", store.run, t0 - 1)?.n ?? 0;
        if (cur === prev && idle >= quiet && awaiting === 0) { returned = "quiet"; break; }
        prev = cur;
        if (performance.now() >= deadline) { returned = "max"; break; }
      }
    }
    const tObs1 = performance.now();
    await rec.flush(300);
    const t1 = store.now();
    this.#current = null;
    page.setDefaultTimeout(DEFAULT_MAX); page.setDefaultNavigationTimeout(DEFAULT_MAX); this.#max = DEFAULT_MAX;
    const postAria = await this.#aria();
    const postStorage = await this.#storage();
    const url = safe(() => page.url(), "");
    const diagnosis = ok ? undefined : await this.#diagnose(runError);
    const { requests, static: st, pending, matchedRows } = this.#wire(t0, t1);
    const ui = diffAria(preAria, postAria, 40);
    const storage = diffStorage(preStorage, postStorage);
    const report: Report<T> = {
      action: id, label, ok, ...(value !== undefined ? { value } : {}), diagnosis, returned, until, url,
      ui, requests, static: st, pending,
      writes: requests.filter((w) => !["GET", "HEAD", "OPTIONS"].includes(w.method) && !w.earlier).map((w) => `${w.method} ${w.path}${w.status != null ? " " + w.status : ""}`),
      storage,
      console: store.all("SELECT level, text FROM console WHERE run=? AND t BETWEEN ? AND ? AND level IN ('error','exception','warning') ORDER BY seq", store.run, t0, t1 + 1),
      dialogs: store.all("SELECT type, message, handled FROM dialogs WHERE run=? AND t BETWEEN ? AND ? ORDER BY seq", store.run, t0, t1 + 1),
      pages: store.all<{ url: string }>("SELECT url FROM nav WHERE run=? AND kind='popup' AND t BETWEEN ? AND ? ORDER BY seq", store.run, t0, t1 + 1).map((x) => x.url),
      openPages: this.context.pages().filter((p) => !isScratch(p)).length,
      proposed: propose(matchedRows, t0, ms(tStart, tDispatch), ui, preAria.split("\n").map((l) => l.trim()), preUrl, url, storage),
      window: { t0: Math.round(t0), t1: Math.round(t1) },
      timing: { runMs: ms(tDispatch, tRun1), observeMs: ms(tRun1, tObs1), reportMs: 0, totalMs: 0 },
    };
    const notes: string[] = [];
    if (landedNote) notes.push(landedNote);
    if (!preAria || !postAria) notes.push("the aria snapshot exceeded 1.5 s on this page; the ui diff is unreliable");
    if (until && !until.ok && /finished\(\)/.test(fnSource(opts.until!)) && requests.some((w) => w.state === "missing")) notes.push("a matching response arrived but the page never read its body, so finished() cannot resolve — drop it and read the status, or read the body from the log");
    if (until && !until.ok && returned === "max" && !opts.until!.toString().includes("timeout")) notes.push(`Playwright calls inside until inherit max (${max} ms) as their timeout`);
    if (notes.length) report.note = notes.join("; ");
    report.timing.reportMs = ms(tObs1, performance.now());
    report.timing.totalMs = ms(tStart, performance.now());
    store.update("actions", { t1, ok, report }, "id=?", [id]);
    if (!this.#recording) for (const table of ["requests", "console", "dialogs", "nav", "ws_frames"]) // the recorder process could not know the window; attribution is the window
      store.update(table, { action_id: id }, `run=? AND action_id IS NULL AND ${table === "requests" ? "t_start" : "t"} BETWEEN ? AND ?`, [store.run, t0 - 1, t1 + 1]);
    Object.defineProperty(report, "toString", { value: () => formatReport(report as Report), enumerable: false });
    return report;
  }

  /** The log. Any SQL over the app's store (`disco sql` prints the same). */
  sql<T = any>(query: string, ...args: unknown[]): T[] { return this.#read().sql<T>(query, ...args); }
  /** A captured body (or screenshot) by hash or 16-char prefix — the whole blob, even when the text column was capped. */
  body(hash: string): string { return this.#read().body(hash); }
  /** The newest JSON body whose URL contains `urlPart` — scoped to an act and/or a method (`json("/api/save", { action: r.action, method: "POST" })` reads back a write even when the app fired GETs afterwards). Waits up to 1 s for a body that is still arriving. */
  async json<T = any>(urlPart: string, scope: { action?: string; method?: string } = {}): Promise<T | null> {
    const where = ["url LIKE ?", "status IS NOT NULL"]; const args: unknown[] = [`%${urlPart}%`];
    if (scope.action) { where.push("action_id=?"); args.push(scope.action); }
    if (scope.method) { where.push("method=?"); args.push(scope.method.toUpperCase()); }
    const q = `SELECT id, body_hash, body_state FROM requests WHERE ${where.join(" AND ")} ORDER BY run DESC, t_start DESC LIMIT 20`;
    const t0 = Date.now();
    for (;;) {
      const rows = this.#store.all<{ id: string; body_hash: string | null; body_state: string }>(q, ...args);
      if (!rows.length) return null;
      if (rows[0].body_state === "pending" && Date.now() - t0 < 1000) { await sleep(50); continue; }
      const row = rows.find((r) => r.body_hash);
      if (!row) return null;
      try { return JSON.parse(this.body(row.body_hash!)) as T; } catch { return null; }
    }
  }

  /** The next event of a kind on the recorder's stream (every page, sockets opened before you joined included) that satisfies `pred`. Default timeout: the enclosing act's max. */
  waitFor<K extends EventKind>(kind: K, pred: (e: Events[K]) => boolean, timeout?: number): Promise<Events[K]> {
    const budget = timeout ?? this.#max;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`waitFor ${kind}: nothing matched within ${budget} ms`)); }, budget);
      const off = this.#recorder.on(kind, (e) => { let hit = false; try { hit = !!pred(e); } catch {} if (hit) { clearTimeout(timer); off(); resolve(e); } });
    });
  }

  // --- internals -----------------------------------------------------------------------------------
  #ctx(): LookCtx { return { page: this.page, context: this.context, store: this.#store, recorder: this.#recorder, current: () => this.#current }; }
  #read(): StoreReader { return (this.#reader ??= openStore(this.#store.dir)); }
  async #aria(): Promise<string> { try { return await this.page.locator("body").ariaSnapshot({ timeout: 1500 }); } catch { return ""; } }
  /** A cheap change detector for the quiet loop: element count, text length, focus, url. */
  #fingerprint(): Promise<string> {
    return this.page.evaluate(() => `${document.getElementsByTagName("*").length}:${document.body?.textContent?.length ?? 0}:${document.activeElement?.tagName ?? ""}#${(document.activeElement as HTMLElement | null)?.id ?? ""}:${location.href}`).catch(() => "?");
  }
  async #storage(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    try { for (const c of await this.context.cookies()) out[`cookie:${c.name}`] = c.value.slice(0, 80); } catch {}
    try {
      const kv = await this.page.evaluate(() => {
        const o: Record<string, string> = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; o["local:" + k] = (localStorage.getItem(k) ?? "").slice(0, 80); } } catch {}
        try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i)!; o["session:" + k] = (sessionStorage.getItem(k) ?? "").slice(0, 80); } } catch {}
        return o;
      });
      Object.assign(out, kv);
    } catch {}
    return out;
  }
  #wire(t0: number, t1: number): { requests: WireLine[]; static: Report["static"]; pending: string[]; matchedRows: any[] } {
    const store = this.#store;
    const rows = store.all<any>("SELECT id, method, path, url, status, t_start, t_response, t_end, mime, body_hash, body_size, body_state, resource_type FROM requests WHERE run=? AND ((t_start BETWEEN ? AND ?) OR (t_start < ? AND (t_end BETWEEN ? AND ? OR t_response BETWEEN ? AND ?))) ORDER BY t_start", store.run, t0 - 1, t1 + 1, t0 - 1, t0 - 1, t1 + 1, t0 - 1, t1 + 1);
    const all: WireLine[] = rows.map((r) => ({ id: r.id, method: r.method, path: pathOf(r.url, r.path), status: r.status, ms: r.t_end != null ? Math.round(r.t_end - r.t_start) : null, mime: shortMime(r.mime), body: r.body_hash ? r.body_hash.slice(0, 16) : null, size: r.body_size, state: r.body_state, type: r.resource_type, ...(r.t_start < t0 - 1 ? { earlier: true } : {}) }));
    const types: Record<string, number> = {}; let count = 0;
    const requests = all.filter((w) => { const isStatic = STATIC_TYPES.has(w.type ?? ""); if (isStatic) { count++; types[w.type!] = (types[w.type!] ?? 0) + 1; } return !isStatic; });
    const pending = rows.filter((r) => r.t_start >= t0 - 1 && r.t_end == null && !STATIC_TYPES.has(r.resource_type) && r.body_state !== "streaming" && r.resource_type !== "websocket" && r.resource_type !== "eventsource" && r.body_state !== "missing")
      .map((r) => `${r.method} ${pathOf(r.url, r.path).slice(0, 80)} (${((t1 - r.t_start) / 1000).toFixed(1)}s${r.status != null ? `, ${r.status}, body pending` : ""})`);
    return { requests, static: { count, types }, pending, matchedRows: rows.filter((r) => r.t_start >= t0 - 1 && !STATIC_TYPES.has(r.resource_type)) };
  }
  async #diagnose(e: unknown): Promise<Diagnosis> {
    const full = String((e as Error)?.message ?? e).replace(/\x1b\[\d+m/g, "");
    const msg = full.split("\n").filter((l) => l.trim() && !/^\s*[-=]+\s*$/.test(l) && !/^Call log:/.test(l)).slice(0, 6).map((l) => l.trim()).join(" | ").slice(0, 600);
    const page = this.page;
    const desc = full.match(/waiting for (locator\(.*\)|getBy[A-Z]\w*\(.*\)|frameLocator\(.*\))\s*$/m)?.[1] ?? full.match(/(locator\('[^\n]*?'\)(?:\.\w+\([^\n]*?\))*|getBy[A-Z]\w*\([^\n]*?\))/)?.[1];
    let reason: Diagnosis["reason"] = "error"; let over: string | undefined; let hint = ""; let styled = false;
    const intercept = full.match(/<([a-z][^>]*)>[^\n]*intercepts pointer events/i);
    if (/detached from the DOM|not attached|Element is not attached/i.test(full)) reason = "detached";
    else if (intercept && /^(html|body)\b/i.test(intercept[1])) { reason = "offscreen"; over = "<" + intercept[1].split(" ")[0] + ">"; }
    else if (intercept) { reason = "occluded"; over = "<" + intercept[1].slice(0, 80) + ">"; }
    else if (/waiting for/.test(full) && !/resolved to|locator resolved/.test(full)) reason = "not-found";
    else if (/not enabled|is disabled/i.test(full)) reason = "disabled";
    else if (/not visible|is hidden/i.test(full)) reason = "hidden";
    else if (/scrolling into view if needed/.test(full) && !/done scrolling/.test(full)) reason = "offscreen";
    else if (/Timeout/i.test(full)) reason = "timeout";
    const d: Diagnosis = { reason, message: msg, ...(desc ? { selector: desc } : {}), over };
    // ask the page what is really there for the locator Playwright named
    const loc = desc ? locatorFromDescription(page, desc) : null;
    if (loc) {
      const count = await loc.count().catch(() => -1);
      if (count === 0) reason = "not-found";
      else if (count > 0) {
        const m = await inspect(page, loc.first());
        if (!m.visible) reason = "hidden";
        else if (!m.enabled) reason = "disabled";
        else if (m.why && /pointer-events/.test(m.why)) reason = "unclickable";
        else if (m.why && /outside the/.test(m.why)) reason = "offscreen";
        else if (m.why && /styled control|ancestor/.test(m.why)) { reason = "occluded"; over = m.under ?? over; styled = true; }
        else if (m.why && /covered by/.test(m.why)) { reason = "occluded"; over = m.under ?? over; }
        else if (m.why && /detached/.test(m.why)) reason = "detached";
        if (m.why) hint = " — " + m.why;
        if (count > 1) hint += ` (${count} elements match; the first was used)`;
      }
      d.reason = reason; d.over = over;
    }
    if (reason === "not-found") { d.candidates = (await controls(page).catch(() => [])).slice(0, 25).map((c) => `${c.selector}${c.role && c.name && !c.selector.startsWith("role=") ? `  (${c.role} "${c.name}")` : ""}`); hint = " — nothing matches; the visible controls are listed below, and look(selector) tries a selector without acting"; }
    else if (reason === "occluded" && !styled) hint = ` — covered by ${over ?? "another element"}: dismiss the dialog or toast that is over it, or wait for it to be gone`;
    else if (reason === "detached") hint = " — the app replaces this element faster than a mouse click; locator.dispatchEvent(\"click\") lands where a real click cannot";
    else if (reason === "timeout" && /page\.goto/.test(full)) hint = ` — the navigation did not finish within max; raise max for this act, or goto(url, { waitUntil: "commit" }) and wait for the element you need`;
    else if (reason === "timeout") hint = ` — the wait inherited this act's max (${this.#max === DEFAULT_MAX ? DEFAULT_MAX : this.#max} ms); look() shows what is on the screen now`;
    else if (reason === "disabled") hint = " — the form is not ready; wait for whatever enables it";
    else if (reason === "hidden") hint = " — it is rendered but collapsed, off-screen or display:none; open what reveals it";
    d.message = msg + hint;
    d.dialogs = await dialogCensus(page);
    try { const buf = await page.screenshot({ type: "jpeg", quality: 60 }); const hash = this.#store.writeBlob(new Uint8Array(buf)); this.#store.insert("shots", { t: this.#store.now(), hash, reason: "diagnosis", action_id: this.#current }); d.shot = `${this.#store.dir}/blobs/${hash.slice(0, 2)}/${hash}`; } catch {}
    return d;
  }
}

/** Throw unless the code ran and its until (if any) held — and throw when the until was already true before the action, because that proved nothing. */
export function reached<T>(r: Report<T>, what?: string): Report<T> {
  const who = `${what ?? r.label} (${r.action})`;
  if (r.ok && r.until?.alreadyTrue) throw new Error(`${who}: the until was already true before the action — it proves nothing; wait for something that is false beforehand (the report's proposed untils all were)`);
  if (r.ok && (!r.until || r.until.ok)) return r;
  const d = r.diagnosis;
  throw new Error(`${who}: ${r.ok ? `until failed after ${r.until?.elapsedMs}ms — ${r.until?.error ?? ""}${r.note ? ` (${r.note})` : ""}` : `${d?.reason} — ${d?.message}${d?.dialogs?.length ? ` (open: ${d.dialogs.join("; ")})` : ""}${d?.shot ? ` [shot ${d.shot}]` : ""}`}`);
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
/** Pasteable until code for what an act caused. Every proposal was false before the action: responses only exist after it, ui lines come from the diff, the url changed. */
function propose(rows: any[], t0: number, preMs: number, ui: Report["ui"], preLines: string[], preUrl: string, postUrl: string, storage: Report["storage"]): Proposal[] {
  const out: Proposal[] = [];
  const seen = new Set<string>();
  for (const r of rows.filter((x) => x.t_response != null).sort((a, b) => a.t_response - b.t_response)) {
    let path: string; try { path = new URL(r.url).pathname; } catch { path = r.path ?? r.url; }
    const key = `${r.method} ${path}`; if (seen.has(key)) continue; seen.add(key);
    const m = r.method === "GET" ? "" : ` && r.request().method() === ${JSON.stringify(r.method)}`;
    out.push({ kind: "response", code: `() => page.waitForResponse(r => r.url().includes(${JSON.stringify(path)})${m})`, atMs: Math.max(0, Math.round(r.t_response - t0 - preMs)) });
    if (out.length >= 3) break;
  }
  if (preUrl && postUrl && preUrl !== postUrl) {
    let p: string; try { p = new URL(postUrl).pathname; } catch { p = postUrl; }
    if (p && p !== "/") out.push({ kind: "url", code: `() => page.waitForURL(u => u.pathname.includes(${JSON.stringify(p)}))`, atMs: null });
  }
  const STATES = ["selected", "expanded", "checked", "pressed", "disabled"];
  const rank = (role: string) => ({ dialog: 0, alertdialog: 0, heading: 1, alert: 2, status: 2, tab: 3, button: 4, link: 5, textbox: 5, cell: 9, text: 8 } as Record<string, number>)[role] ?? 7;
  const parsed = (line: string) => {
    const m = line.match(/^-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*:?\s*(.*)$/); if (!m) return null;
    const states = [...(m[3] ?? "").matchAll(/\[([a-z]+)\]/g)].map((x) => x[1]).filter((x) => STATES.includes(x));
    return { role: m[1], name: m[2], states, rest: m[4]?.trim().replace(/^"|"$/g, ""), key: `${m[1]}|${m[2] ?? ""}|${states.join(",")}` };
  };
  const before = new Set(preLines.map(parsed).filter(Boolean).flatMap((x) => [x!.key, `${x!.role}|${x!.name ?? ""}|`]));
  const added = ui.added.map(parsed).filter((x): x is NonNullable<typeof x> => !!x && !before.has(x.key) && x.role !== "generic" && x.role !== "list" && x.role !== "listitem" && x.role !== "group" && x.role !== "region").sort((a, b) => rank(a.role) - rank(b.role));
  let n = 0;
  for (const a of added) {
    if (n >= 3) break;
    if (a.role === "text") { const t = a.rest; if (!t || t.length < 3 || t.length > 40) continue; out.push({ kind: "appeared", code: `() => page.getByText(${JSON.stringify(t)}).first().waitFor()`, atMs: null }); n++; continue; }
    if (!a.name) continue;
    const st = a.states.map((x) => `, ${x}: true`).join("");
    out.push({ kind: "appeared", code: `() => page.getByRole(${JSON.stringify(a.role)}, { name: ${JSON.stringify(a.name.slice(0, 60))}, exact: true${st} }).first().waitFor()`, atMs: null }); n++;
  }
  const removed = ui.removed.map(parsed).filter((x): x is NonNullable<typeof x> => !!x && !!x.name && ["dialog", "heading", "button", "alert", "status", "progressbar"].includes(x.role)).sort((a, b) => rank(a.role) - rank(b.role));
  if (removed[0]) out.push({ kind: "gone", code: `() => page.getByRole(${JSON.stringify(removed[0].role)}, { name: ${JSON.stringify(removed[0].name!.slice(0, 60))}, exact: true }).first().waitFor({ state: "hidden" })`, atMs: null });
  for (const line of storage.local.slice(0, 1)) { const k = line.replace(/^\+/, "").split(/[=:]/)[0]; if (k && line.startsWith("+")) out.push({ kind: "storage", code: `() => page.waitForFunction(k => localStorage.getItem(k) !== null, ${JSON.stringify(k)})`, atMs: null }); }
  return out.slice(0, 7);
}

function diffStorage(a: Record<string, string>, b: Record<string, string>): Report["storage"] {
  const lines: Report["storage"] = { cookies: [], local: [], session: [] };
  const bucket = (k: string) => (k.startsWith("cookie:") ? "cookies" : k.startsWith("session:") ? "session" : "local") as keyof Report["storage"];
  const name = (k: string) => k.slice(k.indexOf(":") + 1);
  for (const k of Object.keys(b)) { if (!(k in a)) lines[bucket(k)].push(`+${name(k)}=${b[k]}`); else if (a[k] !== b[k]) lines[bucket(k)].push(`${name(k)}: ${a[k]} → ${b[k]}`); }
  for (const k of Object.keys(a)) if (!(k in b)) lines[bucket(k)].push(`-${name(k)}`);
  return lines;
}

/** Line-multiset diff of two aria snapshots. */
export function diffAria(pre: string, post: string, cap = 40): Report["ui"] {
  const count = (s: string) => { const m = new Map<string, number>(); for (const l of s.split("\n")) { const t = l.trim(); if (t) m.set(t, (m.get(t) ?? 0) + 1); } return m; };
  const a = count(pre), b = count(post);
  const added: string[] = [], removed: string[] = [];
  for (const [l, n] of b) { const d = n - (a.get(l) ?? 0); for (let i = 0; i < d; i++) added.push(l); }
  for (const [l, n] of a) { const d = n - (b.get(l) ?? 0); for (let i = 0; i < d; i++) removed.push(l); }
  const more = Math.max(0, added.length - cap) + Math.max(0, removed.length - cap);
  return { added: added.slice(0, cap), removed: removed.slice(0, cap), ...(more ? { more } : {}) };
}

function fnSource(f: unknown): string { try { return String(f).slice(0, 4000); } catch { return ""; } }
function firstLine(e: unknown): string { return String((e as any)?.message ?? e).split("\n")[0].slice(0, 300); }
function ms(a: number, b: number): number { return Math.round(b - a); }
function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
function sleep(n: number) { return new Promise((r) => setTimeout(r, n)); }
function pathOf(url: string, path: string | null): string { try { const u = new URL(url); return u.pathname + u.search; } catch { return path ?? url; } }
function shortMime(m: string | null): string | null { if (!m) return null; const b = m.split(";")[0].trim(); return b.replace(/^application\//, "").replace(/^text\//, "text/"); }
