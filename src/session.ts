// The surface. open → Session with three verbs: look (the screen), act (any Playwright code, bracketed by an
// observation that returns when the app is quiet or your until holds), sql (the log). Plus waitFor over the
// recorder's event stream, body/json for bodies, and reached to assert a report.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { Store, appStoreDir, appDir, appsRoot, openStore, syncEvidence, formatEvidence, type StoreReader } from "./store.ts";
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
export interface Proposal { kind: "response" | "appeared" | "text" | "gone" | "url" | "storage"; code: string; atMs: number | null }
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
  /** requests to other sites (telemetry, fonts CDNs) — folded out of `requests` and `pending`; the log has them */
  thirdParty: { count: number; hosts: Record<string, number> };
  /** requests started in the window and still in flight when it closed */
  pending: string[];
  storage: { cookies: string[]; local: string[]; session: string[] };
  console: Array<{ level: string; text: string }>;
  dialogs: Array<{ type: string; message: string | null; handled: string | null }>;
  pages: string[];
  /** files the page started downloading in the window (suggested file names) */
  downloads: string[];
  openPages: number;
  /** pasteable until code for what this act caused — each was false before the action */
  proposed: Proposal[];
  /** hash of the accessibility tree after the act (a blob; `body(hash)` returns it) — what a look right after this act would show, and evidence for what the screen said */
  aria?: string;
  note?: string;
  window: { t0: number; t1: number };
  timing: { runMs: number; observeMs: number; reportMs: number; totalMs: number };
}

const DEFAULT_MAX = 3000;
const DEFAULT_QUIET = 500;
const STATIC_TYPES = new Set(["script", "stylesheet", "image", "font", "media", "texttrack", "manifest"]);

function originOf(u: string): string { try { return new URL(u).origin; } catch { return ""; } }
/** CDP target info for a page — its id survives reconnects, and openerId marks a popup, which Page.opener() cannot see from a new connection. */
async function targetInfoOf(context: BrowserContext, page: Page): Promise<{ targetId?: string; openerId?: string }> {
  try { const cdp = await context.newCDPSession(page); const { targetInfo } = await cdp.send("Target.getTargetInfo") as any; await cdp.detach().catch(() => {}); return { targetId: targetInfo?.targetId, openerId: targetInfo?.openerId }; } catch { return {}; }
}
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
  if (fresh) { try { writeFileSync(join(appsRoot(opts.appsDir), ".current"), app); } catch {} }   // the CLI's default app follows whoever opened a browser last
  const browser = await connect(info);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages().filter((p) => !isScratch(p));
  // pages() is not in creation order after a reconnect, and a popup left by an earlier script must not become the driven
  // page: prefer the page this browser was opened on (remembered by target id), then the page at `url` (then its origin),
  // and among candidates one that no other page opened
  const targets = await Promise.all(pages.map((p) => targetInfoOf(context, p)));
  const remembered = pages.find((_, i) => info!.pageTarget && targets[i].targetId === info!.pageTarget);
  const pick = (cands: Page[]) => (cands.length ? [...cands].sort((a, b) => (targets[pages.indexOf(a)].openerId ? 1 : 0) - (targets[pages.indexOf(b)].openerId ? 1 : 0))[0] : undefined);
  let page: Page | undefined = remembered;
  if (!page && opts.url) page = pick(pages.filter((p) => sameUrl(p.url(), opts.url!))) ?? pick(pages.filter((p) => p.url().includes(opts.url!))) ?? pick(pages.filter((p) => originOf(p.url()) === originOf(opts.url!)));
  page = page ?? pick(pages) ?? (await context.newPage());
  if (!info.pageTarget || !remembered) { const ti = pages.includes(page) ? targets[pages.indexOf(page)] : await targetInfoOf(context, page); if (ti.targetId) { info.pageTarget = ti.targetId; writeBrowserInfo(storeDir, info); } }
  await page.bringToFront().catch(() => {});
  const store = new Store(storeDir);
  if (fresh || !store.resumeRun()) store.beginRun({ url: opts.url ?? page.url(), mode: info.mode });
  // a detached `disco _record` process may already be capturing this browser: then this session only acts
  const external = !opts.recorder && pidAlive(info.recorderPid);
  const s = new Session(app, dir, store, browser, context, page, info, !external);
  await Session._ready(s);
  // navigate when we just launched, or when the page is somewhere else; joining a browser that is already there leaves its
  // state alone. The navigation is an act like any other, so open returns once the new page is quiet (SPA redirects and
  // first fetches included) and its wire is in the log.
  const absolute = !!opts.url && /^[a-z][a-z0-9+.-]*:\/\//i.test(opts.url);
  if (absolute && (fresh || !sameUrl(page.url(), opts.url!))) { await s.act(`open ${opts.url}`, (p) => p.goto(opts.url!, { waitUntil: "commit" }), { max: 15000 }); s.opened = "navigated"; }
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
  /** whether open navigated the page (as its first act) or joined it where it was */
  opened: "navigated" | "joined" = "joined";

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
    this.#recorder = attachRecorder(context, store, () => this.#current, "accept", { silent: !recording });
    if (recording) this.#claimRecorder();
  }
  /** Exactly one process records a browser (two would collide on request ids): claim it in browser.json, or go silent if another process won. */
  #claimRecorder(): void {
    const dir = this.#store.dir;
    const cur = readBrowserInfo(dir) ?? this.#info;
    if (pidAlive(cur.recorderPid) && cur.recorderPid !== process.pid) { this.#recording = false; this.#recorder.setSilent(true); return; }
    writeBrowserInfo(dir, { ...cur, recorderPid: process.pid });
    this.#recording = true; this.#recorder.setSilent(false);
    this.#store.update("requests", { body_state: "missing", error: "body not read by the page" }, "body_state='pending' AND status IS NOT NULL AND t_response < ?", [this.#store.now() - 1500]);
  }
  /** @internal */ static _ready(s: Session): Promise<void> { return s.#recorder.ready; }

  /** Disconnect. `{ browser: true }` also kills a browser disco launched (an attached one is only forgotten). A script that never closes never exits.
   *  Also copies the report of every act the pack's README cites into evidence/ (once). */
  async close(o: { browser?: boolean } = {}): Promise<void> {
    // a response still on its way (the act's until held before its bodies landed) gets up to a second before the rows are called stranded
    if (this.#recording) { const t0 = Date.now(); while (Date.now() - t0 < 1000 && (this.#store.get<{ n: number }>("SELECT count(*) n FROM requests WHERE run=? AND status IS NULL AND t_end IS NULL AND t_start > ?", this.#store.run, this.#store.now() - 5000)?.n ?? 0) > 0) await sleep(100); }
    await this.#recorder.flush(500);
    this.#recorder.detach();
    // a script's close prints the same evidence and claim check as `disco close` (to stderr, so a script's own output stays clean)
    try { for (const line of formatEvidence(syncEvidence(this.dir, this.#store.dir), this.app)) process.stderr.write(line + "\n"); } catch {}
    if (this.#recording) {
      this.#store.update("requests", { body_state: "missing", error: "body not read by the page (session closed)" }, "run=? AND body_state='pending' AND status IS NOT NULL", [this.#store.run]);
      // a request still unanswered when the recording session ends can never be completed by anyone: say so instead of "pending"
      this.#store.update("requests", { body_state: "error", error: "recording ended before the response arrived" }, "run=? AND body_state='pending' AND status IS NULL", [this.#store.run]);
    }
    if (o.browser) { this.#store.endRun(); killLaunched(this.#info); writeBrowserInfo(this.#store.dir, null); }
    else if (this.#recording) { const cur = readBrowserInfo(this.#store.dir); if (cur?.recorderPid === process.pid) writeBrowserInfo(this.#store.dir, { ...cur, recorderPid: undefined }); }
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
    if (!this.#recording && !pidAlive(readBrowserInfo(store.dir)?.recorderPid)) this.#claimRecorder();   // the recorder died: this session records from here on
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
    const siteNow = () => siteOf(safe(() => new URL(page.url()).host, ""));
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
    let lastDom = tRun1;
    if (!ok) {
      returned = "error";
      if (untilP) { until = { ok: false, elapsedMs: 0, error: "the code threw before the until could be judged" }; untilP.catch(() => {}); }
    } else if (untilP) {
      const remaining = Math.max(0, max - (tRun1 - tDispatch));
      if (!armed.done) await Promise.race([untilP.catch(() => {}), sleep(remaining)]);
      if (armed.done && !armed.error) { returned = "until"; until = { ok: true, elapsedMs: Math.max(0, ms(tDispatch, armed.resolvedAt!)) }; if (armed.resolvedAt! <= tDispatch) until.alreadyTrue = true; if (armed.value !== undefined) until.value = plainValue(armed.value); }
      else { returned = "max"; until = { ok: false, elapsedMs: ms(tDispatch, performance.now()), error: armed.error ?? `did not hold within max (${max} ms) — until: ${fnSource(opts.until!).replace(/\s+/g, " ").slice(0, 160)}` }; untilP.catch(() => {}); }
    } else {
      const deadline = tDispatch + max;
      let prev = await this.#fingerprint();
      for (;;) {
        const left = deadline - performance.now();
        if (left <= 0) { returned = "max"; break; }
        await sleep(Math.min(quiet, left));
        const site = siteNow();
        const cur = await this.#fingerprint();
        const idle = store.now() - rec.lastActivity((h) => !isThirdParty(h, site));
        const awaiting = store.all<{ host: string | null }>("SELECT host FROM requests WHERE run=? AND t_start >= ? AND t_response IS NULL AND t_end IS NULL", store.run, t0 - 1).filter((r) => !isThirdParty(r.host, site)).length;
        if (cur !== prev) lastDom = performance.now();
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
    const ariaHash = postAria ? store.writeBlob(new TextEncoder().encode(postAria)) : undefined;
    const pageSite = siteNow() || siteOfFirstDocument(store, t0, t1);
    const { requests, static: st, thirdParty, pending, matchedRows } = this.#wire(t0, t1, pageSite);
    const ui = diffAria(preAria, postAria, 40);
    const storage = diffStorage(preStorage, postStorage);
    const report: Report<T> = {
      action: id, label, ok, ...(value !== undefined ? { value } : {}), diagnosis, returned, until, url,
      ui, requests, static: st, thirdParty, pending,
      storage,
      console: store.all("SELECT level, text FROM console WHERE run=? AND t BETWEEN ? AND ? AND level IN ('error','exception','warning') ORDER BY seq", store.run, t0, t1 + 1),
      dialogs: store.all("SELECT type, message, handled FROM dialogs WHERE run=? AND t BETWEEN ? AND ? ORDER BY seq", store.run, t0, t1 + 1),
      pages: store.all<{ url: string }>("SELECT url FROM nav WHERE run=? AND kind='popup' AND t BETWEEN ? AND ? ORDER BY seq", store.run, t0, t1 + 1).map((x) => x.url),
      downloads: store.all<{ url: string }>("SELECT url FROM nav WHERE run=? AND kind='download' AND t BETWEEN ? AND ? ORDER BY seq", store.run, t0, t1 + 1).map((x) => x.url),
      openPages: this.context.pages().filter((p) => !isScratch(p)).length,
      proposed: await selfTest(page, propose(matchedRows, t0, ms(tStart, tDispatch), ui, preAria.split("\n").map((l) => l.trim()), preUrl, url, storage)),
      ...(ariaHash ? { aria: ariaHash } : {}),
      window: { t0: Math.round(t0), t1: Math.round(t1) },
      timing: { runMs: ms(tDispatch, tRun1), observeMs: ms(tRun1, tObs1), reportMs: 0, totalMs: 0 },
    };
    const notes: string[] = [];
    if (landedNote) notes.push(landedNote);
    // what the app did on its own since the previous act (a debounced save that landed after that window closed, a poll): unattributed rows are easy to miss
    { const prev = store.get<{ t1: number | null }>("SELECT t1 FROM actions WHERE run=? AND n<? ORDER BY n DESC LIMIT 1", store.run, n);
      if (prev?.t1 != null) { const between = store.all<any>("SELECT method, url, host, status FROM requests WHERE run=? AND action_id IS NULL AND t_start > ? AND t_start < ? AND resource_type IN ('xhr','fetch','document') ORDER BY t_start LIMIT 6", store.run, prev.t1 + 1, t0 - 1).filter((r) => !isThirdParty(r.host, pageSite)); if (between.length) notes.push(`between the previous act and this one the app requested on its own: ${between.map((r) => `${r.method} ${pathOf(r.url, null).slice(0, 60)} ${r.status ?? "…"}`).join(", ")}${between.some((r) => r.method !== "GET") ? " — a write outside any act" : ""}`); } }
    if (returned === "quiet" && !opts.until && tObs1 - tRun1 > quiet + 400) { const domMs = Math.round(lastDom - tRun1), netMs = Math.round(rec.lastActivity((h) => !isThirdParty(h, pageSite)) - (t0 + ms(tStart, tDispatch))); notes.push(`quiet arrived after ${Math.round(tObs1 - tRun1)} ms: the last DOM change was at +${domMs} ms, the last app request event at about +${Math.max(0, netMs)} ms`); }
    if (!ui.added.length && !ui.removed.length && preAria && postAria && preAria !== postAria) notes.push("the accessibility tree changed without additions or removals: lines moved (a sort or a reorder)");
    if (until && (until.alreadyTrue || !until.ok) && opts.until) notes.push(...(await this.#untilNotes(fnSource(opts.until), until, t0)));
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
    const where = ["url LIKE ?", "(status IS NOT NULL OR t_end IS NULL)"]; const args: unknown[] = [`%${urlPart}%`];
    if (scope.action) { where.push("action_id=?"); args.push(scope.action); }
    if (scope.method) { where.push("method=?"); args.push(scope.method.toUpperCase()); }
    const q = `SELECT id, url, body_hash, body_state FROM requests WHERE ${where.join(" AND ")} ORDER BY run DESC, t_start DESC LIMIT 50`;
    // "/queue-entry" must not pick "/queue-entry-metrics": prefer matches that end at a path boundary, when there are any;
    // a fragment found only in query strings that spans several endpoints is ambiguous — say so instead of guessing
    const boundary = (u: string) => { const i = u.indexOf(urlPart); if (i < 0) return false; const c = u[i + urlPart.length]; return c === undefined || "?#/&".includes(c); };
    const inPath = (u: string) => { try { return new URL(u).pathname.includes(urlPart); } catch { return u.split("?")[0].includes(urlPart); } };
    const pathOnly = (u: string) => { try { return new URL(u).pathname; } catch { return u.split("?")[0]; } };
    const scopeText = `${JSON.stringify(urlPart)}${scope.action ? ` in ${scope.action}` : ""}${scope.method ? ` (${scope.method.toUpperCase()})` : ""}`;
    const t0 = Date.now();
    for (;;) {
      const all = this.#store.all<{ id: string; url: string; body_hash: string | null; body_state: string; status: number | null }>(q.replace("SELECT id, url,", "SELECT id, url, status,"), ...args);
      // a matching request that has not answered yet (started in the act, still in flight) is worth the same 1 s wait as a body still arriving
      if (all.some((r) => r.status == null) && !all.some((r) => r.status != null) && Date.now() - t0 < 1000) { await sleep(50); continue; }
      const every = all.filter((r) => r.status != null);
      if (!every.length) {
        const near = this.#store.all<{ method: string; url: string }>(`SELECT method, url FROM requests WHERE status IS NOT NULL ${scope.action ? "AND action_id=?" : ""} AND resource_type IN ('xhr','fetch','document') ORDER BY run DESC, t_start DESC LIMIT 8`, ...(scope.action ? [scope.action] : []));
        throw new Error(`json: no JSON body matched ${scopeText}${near.length ? ` — what did answer: ${near.map((r) => `${r.method} ${pathOf(r.url, null).slice(0, 70)}`).join(", ")}` : " — nothing answered there"}`);
      }
      const byPath = every.filter((r) => inPath(r.url));
      const pool = byPath.length ? byPath : every;
      const paths = new Set(pool.map((r) => pathOnly(r.url)));
      if (!byPath.length && paths.size > 1) throw new Error(`json: ${scopeText} matches only query strings, on ${paths.size} different endpoints (${[...paths].map((p) => p.slice(-60)).join(", ")}) — name the path`);
      const bounded = pool.some((r) => boundary(r.url)) ? pool.filter((r) => boundary(r.url)) : pool;
      // "/visit" names the collection: prefer "/visit?…" over "/visit/<uuid>" when both answered (a sub-path is a different resource)
      const exactEnd = (u: string) => { const i = u.indexOf(urlPart); const c = u[i + urlPart.length]; return c === undefined || "?#&".includes(c); };
      const rows = !urlPart.endsWith("/") && bounded.some((r) => exactEnd(r.url)) ? bounded.filter((r) => exactEnd(r.url)) : bounded;
      if (!rows.length) return null;
      // an error answer is not the fact you asked for: say so now, instead of handing back {error} to code that expects a record
      const newest = rows[0] as any;
      if (newest.status >= 400) { let snippet = ""; try { snippet = newest.body_hash ? this.body(newest.body_hash).slice(0, 160) : ""; } catch {} throw new Error(`json: the newest match for ${scopeText} answered ${newest.status}${snippet ? ` — ${snippet}` : ""} (read it with sql/body if that error body is what you meant)`); }
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
  #wire(t0: number, t1: number, pageSite: string): { requests: WireLine[]; static: Report["static"]; thirdParty: Report["thirdParty"]; pending: string[]; matchedRows: any[] } {
    const store = this.#store;
    const every = store.all<any>("SELECT id, method, path, url, host, status, t_start, t_response, t_end, mime, body_hash, body_size, body_state, resource_type FROM requests WHERE run=? AND ((t_start BETWEEN ? AND ?) OR (t_start < ? AND (t_end BETWEEN ? AND ? OR t_response BETWEEN ? AND ?))) ORDER BY t_start", store.run, t0 - 1, t1 + 1, t0 - 1, t0 - 1, t1 + 1, t0 - 1, t1 + 1);
    const hosts: Record<string, number> = {}; let tpCount = 0;
    const rows = every.filter((r) => { if (isThirdParty(r.host, pageSite)) { tpCount++; hosts[r.host] = (hosts[r.host] ?? 0) + 1; return false; } return true; });
    const all: WireLine[] = rows.map((r) => ({ id: r.id, method: r.method, path: pathOf(r.url, r.path), status: r.status, ms: r.t_end != null ? Math.round(r.t_end - r.t_start) : null, mime: shortMime(r.mime), body: r.body_hash ? r.body_hash.slice(0, 16) : null, size: r.body_size, state: r.body_state, type: r.resource_type, ...(r.t_start < t0 - 1 ? { earlier: true } : {}) }));
    const types: Record<string, number> = {}; let count = 0;
    const requests = all.filter((w) => { const isStatic = STATIC_TYPES.has(w.type ?? ""); if (isStatic) { count++; types[w.type!] = (types[w.type!] ?? 0) + 1; } return !isStatic; });
    const pending = rows.filter((r) => r.t_start >= t0 - 1 && r.t_end == null && !STATIC_TYPES.has(r.resource_type) && r.body_state !== "streaming" && r.resource_type !== "websocket" && r.resource_type !== "eventsource" && r.body_state !== "missing")
      .map((r) => `${r.method} ${pathOf(r.url, r.path).slice(0, 80)} (${((t1 - r.t_start) / 1000).toFixed(1)}s${r.status != null ? `, ${r.status}, body pending` : ""})`);
    return { requests, static: { count, types }, thirdParty: { count: tpCount, hosts }, pending, matchedRows: rows.filter((r) => r.t_start >= t0 - 1 && !STATIC_TYPES.has(r.resource_type)) };
  }
  /** What the until's own target looks like now, and — for a response wait that failed — what answered just before the act. */
  async #untilNotes(src: string, until: NonNullable<Report["until"]>, t0: number): Promise<string[]> {
    const notes: string[] = [];
    const desc = src.match(/page\.((?:locator|getBy[A-Z]\w*|frameLocator)\(.*?\)(?:\.(?:first|last)\(\)|\.nth\(\d+\))?)\.waitFor\(/)?.[1];
    const loc = desc ? locatorFromDescription(this.page, desc) : null;
    if (loc) {
      const n = await loc.count().catch(() => -1);
      if (n === 0) notes.push(`the until's target ${desc} matches nothing now`);
      else if (n > 0) {
        const m = await inspect(this.page, loc.first());
        notes.push(`the until's target ${desc}: ${n} match${n === 1 ? "" : "es"} now; the first is ${m.visible ? "visible" : "hidden"}${m.enabled ? "" : ", disabled"}${m.box ? ` at (${m.box.x},${m.box.y} ${m.box.w}×${m.box.h})` : ""}${m.why ? ` — ${m.why}` : ""}${until.alreadyTrue ? " — it existed before the action; anchor on what the action changes: a state (aria-selected, aria-hidden, aria-expanded), a value, or the element that leaves" : ""}`);
      }
    }
    if (!until.ok && /waitForResponse|waitFor\(\s*["']response["']/.test(src)) {
      const before = this.#store.all<any>("SELECT method, url, status, t_response FROM requests WHERE run=? AND t_response IS NOT NULL AND t_response BETWEEN ? AND ? AND resource_type IN ('xhr','fetch','document') ORDER BY t_response DESC LIMIT 6", this.#store.run, t0 - 5000, t0);
      if (before.length) notes.push(`no response matched during the wait; these answered in the 5 s BEFORE this act (a cache or a de-duplicated fetch answers before you click — anchor on the screen, or read that earlier body from the log): ${before.map((r) => `${r.method} ${pathOf(r.url, null).slice(0, 70)} ${r.status} (−${Math.round(t0 - r.t_response)} ms)`).join(", ")}`);
    }
    return notes;
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
    if (reason === "not-found") {
      const cs = await controls(page).catch(() => []);
      // `:has-text("Search patient")` on an icon button whose name is an aria-label: the text is not in its content, but a control carries that name
      const wanted = (desc ?? full).match(/:has-text\(["']([^"']+)["']\)|text=["']?([^"'\]]+)|getByText\(["']([^"']+)["']/);
      const t = (wanted?.[1] ?? wanted?.[2] ?? wanted?.[3] ?? "").trim().toLowerCase();
      const named = t ? cs.filter((c) => c.name.toLowerCase().includes(t)) : [];
      const meant = named.length ? ` — did you mean ${named.slice(0, 3).map((c) => c.selector.startsWith("role=") ? c.selector : `role=${c.role}[name="${c.name}"]`).join(" or ")}? "${named[0].name}" is that control's accessible name (an aria-label or a label), which :has-text() and text= cannot see` : "";
      d.candidates = [...named, ...cs.filter((c) => !named.includes(c))].slice(0, 25).map((c) => `${c.selector}${c.role && c.name && !c.selector.startsWith("role=") ? `  (${c.role} "${c.name}")` : ""}`);
      hint = `${meant} — nothing matches${meant ? "" : "; the visible controls are listed below, and look(selector) tries a selector without acting"}`;
    }
    else if (reason === "occluded" && !styled) hint = ` — covered by ${over ?? "another element"}: dismiss the dialog or toast that is over it, or wait for it to be gone`;
    else if (reason === "detached") hint = " — the app replaces this element faster than a mouse click; locator.dispatchEvent(\"click\") lands where a real click cannot";
    else if (reason === "timeout" && /page\.goto/.test(full)) hint = ` — the navigation did not finish within max; raise max for this act, or goto(url, { waitUntil: "commit" }) and wait for the element you need`;
    else if (reason === "timeout") hint = ` — the wait inherited this act's max (${this.#max === DEFAULT_MAX ? DEFAULT_MAX : this.#max} ms); look() shows what is on the screen now`;
    else if (reason === "disabled") hint = " — the form is not ready; wait for whatever enables it";
    else if (reason === "hidden") hint = " — it is rendered but collapsed, off-screen or display:none; open what reveals it";
    else if (reason === "error" && /is not defined|Failed to parse URL|fetch failed|ReferenceError/.test(full)) hint = " — your act code runs in Node, not in the page: page.evaluate(() => …) for the DOM, and for a fetch that should carry the page's cookies";
    d.message = msg + hint;
    d.dialogs = await dialogCensus(page);
    try { const buf = await page.screenshot({ type: "jpeg", quality: 60 }); const hash = this.#store.writeBlob(new Uint8Array(buf), ".jpg"); this.#store.insert("shots", { t: this.#store.now(), hash, reason: "diagnosis", url: safe(() => page.url(), ""), action_id: this.#current }); d.shot = this.#store.blobFile(hash); } catch {}
    return d;
  }
}

/** Throw unless the code ran and its until (if any) held — and throw when the until was already true before the action, because that proved nothing. */
export function reached<T>(r: Report<T>, what?: string): Report<T> {
  const who = `${what ?? r.label} (${r.action})`;
  if (r.ok && r.until?.alreadyTrue) throw new Error(`${who}: the until was already true before the action — it proves nothing (the action itself ran and may have changed the page); wait for something that is false beforehand (the report's proposed untils all were)`);
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
    // for a step that navigates from a page already at (or redirecting to) the destination, the nav EVENT is the until that is false beforehand
    if (p) out.push({ kind: "url", code: `() => s.waitFor("nav", e => e.url.includes(${JSON.stringify(p === "/" ? new URL(postUrl).host : p)}))`, atMs: null });
  }
  const STATES = ["selected", "expanded", "checked", "pressed", "disabled"];
  const rank = (role: string) => ({ dialog: 0, alertdialog: 0, heading: 1, alert: 2, status: 2, tab: 3, button: 4, link: 5, textbox: 5, cell: 9, text: 8 } as Record<string, number>)[role] ?? 7;
  const parsed = (line: string) => {
    const m = line.match(/^-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*:?\s*(.*)$/); if (!m) return null;
    const states = [...(m[3] ?? "").matchAll(/\[([a-z]+)\]/g)].map((x) => x[1]).filter((x) => STATES.includes(x));
    const rest = m[4]?.trim().replace(/^"|"$/g, "");
    return { role: m[1], name: m[2], states, rest, key: `${m[1]}|${m[2] ?? rest ?? ""}|${states.join(",")}` };
  };
  const before = new Set(preLines.map(parsed).filter(Boolean).flatMap((x) => [x!.key, `${x!.role}|${x!.name ?? x!.rest ?? ""}|`]));
  const preText = preLines.join("").replace(/\s+/g, "");
  const added = ui.added.map(parsed).filter((x): x is NonNullable<typeof x> => !!x && !before.has(x.key) && x.role !== "generic" && x.role !== "list" && x.role !== "listitem" && x.role !== "group" && x.role !== "region").sort((a, b) => rank(a.role) - rank(b.role));
  let n = 0;
  for (const a of added) {
    if (n >= 3) break;
    // a text line often merges sibling elements (a label and a value span), which no single getByText matches: wait on the page's
    // text instead — collected through open shadow roots, and only when the fragment was not already on screen (substrings lie: "armed" is in "unarmed")
    if (a.role === "text") {
      const t = a.rest; if (!t || t.length < 3 || t.length > 60) continue;
      const frag = t.replace(/\s+/g, "");
      if (preText.includes(frag)) continue;
      out.push({ kind: "text", code: `() => page.waitForFunction(t => { const txt = (n) => n.nodeType === 3 ? n.textContent : [...(n.shadowRoot ? [n.shadowRoot] : []), ...n.childNodes].map(txt).join(""); return txt(document.body).replace(/\\s+/g, "").includes(t); }, ${JSON.stringify(frag)})`, atMs: null }); n++; continue;
    }
    if (!a.name) continue;
    const st = a.states.map((x) => `, ${x}: true`).join("");
    // an <option> inside a native <select> is never "visible": wait for it attached with its state
    const w = a.role === "option" ? `.waitFor({ state: "attached" })` : ".waitFor()";
    out.push({ kind: "appeared", code: `() => page.getByRole(${JSON.stringify(a.role)}, { name: ${JSON.stringify(a.name.slice(0, 60))}, exact: true${st} }).first()${w}`, atMs: null }); n++;
  }
  // "the one that left" is only a postcondition when it was the only one: `.first()` of a repeated button re-resolves to the next one
  const preCount = (role: string, name: string) => preLines.map(parsed).filter((x) => x && x.role === role && x.name === name).length;
  const removed = ui.removed.map(parsed).filter((x): x is NonNullable<typeof x> => !!x && !!x.name && ["dialog", "heading", "button", "alert", "status", "progressbar"].includes(x.role) && preCount(x.role, x.name) === 1).sort((a, b) => rank(a.role) - rank(b.role));
  if (removed[0]) out.push({ kind: "gone", code: `() => page.getByRole(${JSON.stringify(removed[0].role)}, { name: ${JSON.stringify(removed[0].name!.slice(0, 60))}, exact: true }).first().waitFor({ state: "hidden" })`, atMs: null });
  for (const line of storage.local.slice(0, 1)) { const k = line.replace(/^\+/, "").split(/[=:]/)[0]; if (k && line.startsWith("+")) out.push({ kind: "storage", code: `() => page.waitForFunction(k => localStorage.getItem(k) !== null, ${JSON.stringify(k)})`, atMs: null }); }
  return out.slice(0, 7);
}

/** A proposal must hold right after the act — otherwise it is a guess. DOM/url/storage proposals are run with a short budget; response proposals already happened. */
async function selfTest(page: Page, proposals: Proposal[]): Promise<Proposal[]> {
  const keep = await Promise.all(proposals.map(async (p) => {
    if (p.kind === "response" || p.code.includes("s.waitFor(")) return true;   // already happened / needs the session; cannot be re-run here
    try {
      const fn = new Function("page", `return (${p.code})`)(page) as () => Promise<unknown>;
      const run = Promise.resolve(fn()); run.catch(() => {});
      const held = await Promise.race([run.then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 400))]);
      if (!held) return false;
      // an element that "appeared" must be on the page's canvas, not parked off-canvas (Playwright calls a translated drawer visible)
      if (p.kind === "appeared") {
        const m = p.code.match(/^\(\) => page\.(.*)\.waitFor\(\)$/);
        if (m) { const loc = new Function("page", `return page.${m[1]};`)(page) as Locator; const box = await loc.boundingBox().catch(() => null); if (box && (box.x + box.width <= 0 || box.y + box.height <= 0)) return false; }
      }
      return true;
    } catch { return false; }
  }));
  return proposals.filter((_, i) => keep[i]);
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
/** What an until resolved with, kept when it is JSON and small; otherwise a short description. */
function plainValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const cls = (v as any)?.constructor?.name;
  if (cls === "Response") { try { const r = v as any; return `${r.request().method()} ${pathOf(r.url(), null)} ${r.status()}`; } catch {} }
  if (cls && /^(Request|Locator|Page|Frame|ElementHandle|JSHandle|WebSocket|Dialog|Download|BrowserContext)$/.test(cls)) return `[${cls}]`;
  try { const s = JSON.stringify(v); if (s !== undefined && s.length <= 2000) return JSON.parse(s); return `${(s ?? String(v)).slice(0, 200)}… (${s?.length ?? 0} chars)`; } catch { return String(v).slice(0, 200); }
}
/** The site a host belongs to: its last two labels (an IP or a single label stands alone). Good enough to tell telemetry from the app's API. */
function siteOf(host: string | null | undefined): string { if (!host) return ""; const h = host.replace(/:\d+$/, ""); if (/^[\d.]+$/.test(h) || h.startsWith("[") || !h.includes(".")) return h; return h.split(".").slice(-2).join("."); }
function isThirdParty(host: string | null | undefined, pageSite: string): boolean { const s = siteOf(host); return !!s && !!pageSite && s !== pageSite; }
/** When the page had no host yet (about:blank before open's navigation), the app's site is that of the first document it loaded. */
function siteOfFirstDocument(store: Store, t0: number, t1: number): string { const r = store.get<{ host: string | null }>("SELECT host FROM requests WHERE run=? AND resource_type='document' AND t_start BETWEEN ? AND ? ORDER BY t_start LIMIT 1", store.run, t0 - 1, t1 + 1); return siteOf(r?.host); }
function firstLine(e: unknown): string { return String((e as any)?.message ?? e).split("\n")[0].slice(0, 300); }
function ms(a: number, b: number): number { return Math.round(b - a); }
function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
function sleep(n: number) { return new Promise((r) => setTimeout(r, n)); }
function pathOf(url: string, path: string | null): string { try { const u = new URL(url); return u.pathname + u.search; } catch { return path ?? url; } }
function shortMime(m: string | null): string | null { if (!m) return null; const b = m.split(";")[0].trim(); return b.replace(/^application\//, "").replace(/^text\//, "text/"); }
