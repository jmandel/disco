// The one wrapper. `act` = do a Playwright action, optionally wait for the state you asked for
// (`until`), then return what happened: URL, aria diff, requests, console, dialogs, new pages —
// or a diagnosis when the action could not be performed. Every wait is short and named.
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, FrameLocator, Locator, Page } from "playwright-core";
import { Store, appStoreDir, appDir, openStore, type StoreReader } from "./store.ts";
import { attachRecorder, type DialogPolicy, type Recorder, type WsFrame } from "./record.ts";
import { readBrowserInfo, writeBrowserInfo, isAlive, launchChromium, attachEndpoint, connect, killLaunched, pidAlive, type BrowserInfo } from "./browser.ts";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------
export interface Timeouts {
  /** How long a Playwright action may wait for its element (visible, stable, receiving events). */
  action: number;
  /** Default budget for `until`. */
  until: number;
  /** Observation window after an action without `until`. */
  window: number;
  /** Budget for `navigate` to commit. */
  navigate: number;
}
export const DEFAULT_TIMEOUTS: Timeouts = { action: 3000, until: 5000, window: 700, navigate: 15000 };
/** `landed` waits this long past the response headers for the body to finish; a body the page never reads never does. */
export const LANDED_BOUND_MS = 1000;
/** A string url predicate matches the href without its query string (unless the string itself contains '?'); a RegExp sees the whole href. */
function originOf(u: string): string { try { return new URL(u).origin; } catch { return ""; } }
function sameUrl(a: string, b: string): boolean { const n = (x: string) => x.replace(/#.*$/, "").replace(/\/+$/, ""); return n(a) === n(b); }
export function urlMatches(u: string | RegExp, href: string): boolean {
  if (typeof u !== "string") return u.test(href);
  if (u.includes("?")) return href.includes(u);
  const q = href.indexOf("?"); return (q >= 0 ? href.slice(0, q) : href).includes(u);
}

export type Pred =
  | { selector: string; visible?: boolean; frame?: string; label?: string }   // an element is visible (visible: false → merely attached, hidden or not)
  | { gone: string; frame?: string; label?: string }                          // an element is hidden or detached
  | { text: string; label?: string }                                          // visible text anywhere on the page
  | { url: string | RegExp; label?: string }                                  // string: URL without its query contains it (with it, if the string has a '?'); RegExp: whole href
  | { request: string | RegExp; method?: string; landed?: boolean; label?: string }   // a response whose URL contains / matches (and whose method matches, if given) arrives; landed: its body finished too — bounded at 1 s past the headers
  | { fn: string | ((arg: any) => unknown); arg?: unknown; label?: string }   // page.waitForFunction
  | { page: string | RegExp; label?: string }                                 // a new page (popup) opens whose URL contains / matches
  | { ws: string | RegExp; dir?: "in" | "out"; label?: string }               // a WebSocket frame (received by default) whose payload contains / matches
  | { any: Pred[]; label?: string }
  | { all: Pred[]; label?: string };

export type Kind = "click" | "dblclick" | "fill" | "type" | "press" | "select" | "hover" | "scroll" | "drag" | "navigate" | "evaluate" | "noop";

export interface ActSpec {
  kind: Kind;
  target?: string | Locator;
  text?: string;               // fill / type
  key?: string;                // press
  value?: string | string[];   // select
  url?: string;                // navigate
  fn?: string | ((arg: any) => unknown); arg?: unknown;   // evaluate: run in the page as an act (its requests are attributed; the value is report.value)
  frame?: string;              // iframe selector(s), `>>`-chained for nesting; the target is resolved inside
  button?: "left" | "right" | "middle";
  js?: boolean;                // click: dispatch a DOM click event instead of moving the mouse (widgets the app re-renders under you)
  to?: string | Locator | { dx: number; dy: number };   // drag: the drop target, or an offset from the target's centre
  position?: { x: number; y: number };                   // click/dblclick at this offset from the element's top-left (canvas cells)
  deltaY?: number;             // scroll without a target
  until?: Pred;
  timeout?: number;            // budget for `until` (default timeouts.until)
  window?: number;             // observation window when there is no `until` (default timeouts.window)
  shot?: boolean;              // take a screenshot at the end of the window
  wire?: "app" | "all";        // report: "app" (default) lists documents/xhr/fetch/streams and folds scripts, styles, images, fonts into `static`; "all" lists everything
}

export interface Diagnosis {
  reason: "not-found" | "hidden" | "disabled" | "occluded" | "offscreen" | "unclickable" | "detached" | "timeout" | "error";
  message: string;
  target?: string;
  matches?: number;
  over?: string;               // the element that would receive the click instead
  candidates?: string[];       // visible controls on the page (not-found)
  dialogs?: string[];          // open dialogs/overlays at the time
  url?: string;
  shot?: string;               // screenshot blob hash
}
export interface UntilResult { ok: boolean; elapsedMs: number; which?: string; error?: string; diagnosis?: Diagnosis; /** the predicate already held before the action was dispatched — it proved nothing */ alreadyTrue?: boolean; /** the log id of the response a `request` predicate matched */ request?: string }
export interface WireLine { id: string; method: string; path: string; status?: number | null; ms?: number | null; mime?: string | null; body?: string | null; size?: number | null; state?: string | null; type?: string | null; /** started before the window and finished inside it (a long-poll that answered you) */ earlier?: boolean; /** the response the `until` matched */ until?: boolean }
export interface Report {
  action: string;              // act:<n>
  kind: Kind | "until";
  target?: string;
  matches?: number;
  ok: boolean;                 // the action was performed (a failed `until` still has ok: true — read report.until; `reached()` checks both)
  diagnosis?: Diagnosis;
  until?: UntilResult;
  url: string;
  ui: { added: string[]; removed: string[]; more?: number };
  requests: WireLine[];
  /** Static resources (script, stylesheet, image, font, media…) started in the window, folded out of `requests` unless `wire: "all"`. */
  static: { count: number; types: Record<string, number> };
  console: Array<{ level: string; text: string }>;
  dialogs: Array<{ type: string; message: string | null; handled: string | null }>;
  pages: string[];
  /** Non-GET requests of the app's own traffic in the window — what this act may have persisted. */
  writes: string[];
  /** evaluate: what the expression returned */
  value?: unknown;
  /** Pages open in the browser after this act (popups included). More than 1 means the driven page can be throttled in the background. */
  openPages: number;
  shot?: string;
  window: { t0: number; t1: number };
  timing: { actMs: number; untilMs: number; windowMs: number; reportMs: number; totalMs: number };
}

export interface OpenOptions {
  url?: string;
  attach?: string | number;
  headed?: boolean;
  dialogs?: DialogPolicy;
  appsDir?: string;
  timeouts?: Partial<Timeouts>;
  page?: number;
  fresh?: boolean;
  /** Drop aria-diff lines containing these strings / matching these RegExps (live counters, clocks). Also `s.uiIgnore`. */
  uiIgnore?: Array<string | RegExp>;
  /** This session IS the recorder (`disco record`): always write rows, even if browser.json names a recorder. */
  recorder?: boolean;
}

// ---------------------------------------------------------------------------------------------
// open / Session
// ---------------------------------------------------------------------------------------------
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
    if (opts.fresh && existsSync(join(storeDir, "profile"))) { const { rmSync } = await import("node:fs"); rmSync(join(storeDir, "profile"), { recursive: true, force: true }); }
    info = await launchChromium(storeDir, { headed: opts.headed }); fresh = true;
  }
  const browser = await connect(info);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages();
  // pages() is not in creation order after a reconnect: prefer the page already at `url` (then its origin), never a popup by accident
  let page = opts.page !== undefined ? pages[opts.page] : undefined;
  if (!page && opts.url) page = pages.find((p) => sameUrl(p.url(), opts.url!)) ?? pages.find((p) => p.url().includes(opts.url!)) ?? pages.find((p) => originOf(p.url()) === originOf(opts.url!));
  page = page ?? pages[0] ?? (await context.newPage());
  await page.bringToFront().catch(() => {});
  const store = new Store(storeDir);
  if (fresh || !store.resumeRun()) store.beginRun({ url: opts.url ?? page.url(), mode: info.mode });
  // a detached `disco record` process may already be capturing this browser: then this session only acts
  const external = !opts.recorder && pidAlive(info.recorderPid);
  const s = new Session(app, dir, store, browser, context, page, info, { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) }, opts.dialogs ?? "accept", !external);
  s.uiIgnore.push(...(opts.uiIgnore ?? []));
  await s.recorderReady();
  // navigate when we just launched, or when the page is somewhere else; joining a browser that is already there leaves its state alone
  if (opts.url && (fresh || !sameUrl(page.url(), opts.url))) await s.navigate(opts.url);
  return s;
}

/** open → fn → close, whatever happens. A script that forgets `close()` never exits; this one cannot forget. */
export async function withApp<T>(app: string, opts: OpenOptions, fn: (s: Session) => Promise<T>): Promise<T> {
  const s = await open(app, opts);
  try { return await fn(s); } finally { await s.close(); }
}

export class Session {
  private currentAction: string | null = null;
  private recorder: Recorder;
  /** Aria-diff lines containing any of these are dropped from reports (live counters, clocks). */
  uiIgnore: Array<string | RegExp> = [];
  private reader: StoreReader | null = null;

  app: string;
  /** apps/<app> — where NOTES.md and the pack live. */
  dir: string;
  log: Store;
  browser: Browser;
  context: BrowserContext;
  /** The Playwright page. Use it directly whenever the wrapper is in your way. */
  page: Page;
  info: BrowserInfo;
  timeouts: Timeouts;
  dialogs: DialogPolicy;

  /** false when a detached `disco record` process is writing the log for this browser and this session only acts. */
  recording: boolean;

  constructor(app: string, dir: string, log: Store, browser: Browser, context: BrowserContext, page: Page, info: BrowserInfo, timeouts: Timeouts, dialogs: DialogPolicy, recording = true) {
    this.app = app; this.dir = dir; this.log = log; this.browser = browser; this.context = context; this.page = page; this.info = info; this.timeouts = timeouts; this.dialogs = dialogs; this.recording = recording;
    page.setDefaultTimeout(timeouts.action);
    if (recording) sweepUnread(log);
    this.recorder = attachRecorder(context, log, () => this.currentAction, dialogs, { silent: !recording });
  }

  /** @internal */ recorderReady(): Promise<void> { return this.recorder.ready; }
  /** The run this session records into (one `open` of a browser = one run; a script that joins a live browser joins its run). */
  get run(): number { return this.log.run; }
  /** Read-only view of the log with the helpers (`requests`, `json`, `latestJson`, `sql`). */
  get store(): StoreReader { return (this.reader ??= openStore(this.log.dir)); }

  // --- sugar -------------------------------------------------------------------------------------
  click(target: string | Locator, o: Partial<ActSpec> = {}) { return this.act({ kind: "click", target, ...o }); }
  dblclick(target: string | Locator, o: Partial<ActSpec> = {}) { return this.act({ kind: "dblclick", target, ...o }); }
  rightclick(target: string | Locator, o: Partial<ActSpec> = {}) { return this.act({ kind: "click", target, button: "right", ...o }); }
  fill(target: string | Locator, text: string, o: Partial<ActSpec> = {}) { return this.act({ kind: "fill", target, text, ...o }); }
  type(target: string | Locator, text: string, o: Partial<ActSpec> = {}) { return this.act({ kind: "type", target, text, ...o }); }
  press(key: string, o: Partial<ActSpec> = {}) { return this.act({ kind: "press", key, ...o }); }
  select(target: string | Locator, value: string | string[], o: Partial<ActSpec> = {}) { return this.act({ kind: "select", target, value, ...o }); }
  hover(target: string | Locator, o: Partial<ActSpec> = {}) { return this.act({ kind: "hover", target, ...o }); }
  scroll(targetOrDeltaY: string | Locator | number, o: Partial<ActSpec> = {}) {
    return typeof targetOrDeltaY === "number" ? this.act({ kind: "scroll", deltaY: targetOrDeltaY, ...o }) : this.act({ kind: "scroll", target: targetOrDeltaY, ...o });
  }
  drag(target: string | Locator, to: string | Locator | { dx: number; dy: number }, o: Partial<ActSpec> = {}) { return this.act({ kind: "drag", target, to, ...o }); }
  navigate(url: string, o: Partial<ActSpec> = {}) { return this.act({ kind: "navigate", url, ...o }); }
  /** Wait for a state without acting. Same report shape; `report.until` says whether it arrived. */
  until(pred: Pred, o: { timeout?: number } = {}) { return this.act({ kind: "noop", until: pred, timeout: o.timeout }); }
  /** Run code in the page AS AN ACT: the requests it causes are attributed to it, the value is `report.value`. `s.evaluate` is the raw, unlogged form. */
  probe<T = unknown>(fn: string | ((arg: any) => T | Promise<T>), arg?: unknown, o: Partial<ActSpec> = {}) { return this.act({ kind: "evaluate", fn: fn as any, arg, ...o }) as Promise<Report & { value: T }>; }
  /** Is this predicate true right now? One cheap check, no waiting — ask before you write an `until` on it. */
  holds(pred: Pred): Promise<boolean> { return this.holdsNow(pred); }

  /** Close every page except the driven one (popups left by earlier scripts throttle the browser). Returns how many were closed. */
  async closeOtherPages(): Promise<number> {
    let n = 0;
    for (const p of this.context.pages()) if (p !== this.page) { await p.close().catch(() => {}); n++; }
    await this.page.bringToFront().catch(() => {});
    return n;
  }

  /** A FrameLocator for `iframe#a >> iframe#b`. */
  frame(spec: string): FrameLocator {
    let fl: FrameLocator | null = null;
    for (const part of spec.split(">>").map((x) => x.trim()).filter(Boolean)) fl = fl ? fl.frameLocator(part) : this.page.frameLocator(part);
    if (!fl) throw new Error("empty frame spec");
    return fl;
  }
  private base(frame?: string): Page | FrameLocator { return frame ? this.frame(frame) : this.page; }

  evaluate<T = unknown>(fn: string | ((arg: any) => T | Promise<T>), arg?: unknown): Promise<T> { return this.page.evaluate(fn as any, arg) as Promise<T>; }

  /** The page as the accessibility tree sees it (Playwright's aria snapshot) — the whole body, or one element. Read this when the diff is not enough. */
  async aria(selector?: string, o: { frame?: string } = {}): Promise<string> {
    const base = this.base(o.frame);
    let loc = base.locator(selector ?? "body").first();
    // a bare word that is an ARIA role ("banner", "navigation", "dialog") — the words aria itself prints — means role=
    if (selector && /^[a-z]+$/.test(selector) && (await loc.count()) === 0) { const byRole = base.locator(`role=${selector}`).first(); if ((await byRole.count()) > 0) loc = byRole; }
    if (selector && (await loc.count()) === 0) { const c = await this.candidates(o.frame); throw new Error(`aria: no element matches ${selector}${o.frame ? ` in ${o.frame}` : ""} (a css/role selector, or a bare role name such as "banner"). Visible controls: ${c.slice(0, 10).join(", ")}${c.length > 10 ? ", …" : ""}`); }
    return loc.ariaSnapshot({ timeout: this.timeouts.action });
  }

  async screenshot(reason = "shot"): Promise<{ hash: string; path: string }> {
    const buf = await this.page.screenshot({ type: "jpeg", quality: 60 });
    const hash = this.log.writeBlob(new Uint8Array(buf));
    this.log.insert("shots", { t: this.log.now(), hash, reason, action_id: this.currentAction });
    return { hash, path: join(this.log.dir, "blobs", hash.slice(0, 2), hash) };
  }

  /** Append a line to apps/<app>/NOTES.md (and the notes table). */
  note(text: string): void {
    const t = this.log.now();
    this.log.insert("notes", { t, text, action_id: this.currentAction });
    mkdirSync(this.dir, { recursive: true });
    const p = join(this.dir, "NOTES.md");
    const head = existsSync(p) ? "" : `# ${this.app} — notes\n\nAppended by \`disco note\` / \`s.note()\`. Distill into README.md when it settles.\n\n`;
    appendFileSync(p, `${head}- [run ${this.log.run} · ${Math.round(t)}ms] ${text}\n`);
  }

  /** Disconnect. `{ browser: true }` also kills a browser we launched (an attached one is only forgotten). */
  async close(o: { browser?: boolean } = {}): Promise<void> {
    await this.recorder.flush(500);
    this.recorder.detach();
    if (this.recording) this.log.update("requests", { body_state: "missing", error: "body not read by the page (session closed)" }, "run=? AND body_state='pending' AND status IS NOT NULL", [this.log.run]);
    if (o.browser) { this.log.endRun(); killLaunched(this.info); writeBrowserInfo(this.log.dir, null); }
    try { await this.browser.close(); } catch {}
    this.reader?.close(); this.log.close();
  }

  // --- act -----------------------------------------------------------------------------------------
  async act(spec: ActSpec): Promise<Report> {
    const T = this.timeouts;
    const n = this.log.nextActionN();
    const id = `act:${n}`;
    const targetText = spec.target === undefined ? undefined : typeof spec.target === "string" ? spec.target : String(spec.target);
    const tStart = performance.now();
    const untilBudget = spec.timeout ?? T.until;
    // The postcondition is armed synchronously, before anything else happens in this call — so a response or
    // frame that arrives during the pre-action snapshot counts, and `const p = s.until(…); trigger(); await p`
    // cannot lose the race. A navigation's postcondition is about the NEW document: it is armed after commit
    // (an anchor that is true on both the old and the new page is a legitimate postcondition there).
    const armLate = spec.kind === "navigate";
    let armed = spec.until && !armLate ? this.arm(spec.until, untilBudget) : null;
    const alreadyTrue = spec.until && spec.kind !== "noop" && !armLate ? await this.holdsNow(spec.until) : false;
    const preAria = await this.ariaSafe();
    const t0 = this.log.now();
    this.log.insert("actions", { id, n, t0, kind: spec.kind, target: targetText });
    this.currentAction = id;
    let ok = true; let diagnosis: Diagnosis | undefined; let matches: number | undefined; let value: unknown;
    let untilRes: UntilResult | undefined;
    const tAct0 = performance.now();
    if (this.context.pages().length > 1) await this.page.bringToFront().catch(() => {});
    try {
      if (spec.kind === "evaluate") value = await this.page.evaluate(spec.fn as any, spec.arg);
      else if (spec.kind !== "noop" && spec.kind !== "navigate" && spec.kind !== "scroll" && !(spec.kind === "press" && !spec.target)) {
        const r = await this.resolve(spec);
        if ("diagnosis" in r) { ok = false; diagnosis = r.diagnosis; }
        else { matches = r.matches; await this.perform(spec, r.locator, r.force); }
      } else await this.perform(spec, null);
      if (armLate && spec.until) armed = this.arm(spec.until, untilBudget);
    } catch (e) {
      ok = false; diagnosis = await this.diagnose(e as Error, spec);
    }
    const tAct1 = performance.now();
    if (armed) {
      if (ok) {
        untilRes = await armed.wait();
        // resolved before the action was even dispatched → it held beforehand, whatever the arm (fn arms are not pre-checked)
        if (untilRes.ok && spec.kind !== "noop" && !armLate && armed.resolvedAt !== undefined && armed.resolvedAt <= tAct0 && stateArms(spec.until!).has(untilRes.which ?? "")) untilRes.alreadyTrue = true;
      } else { armed.cancel(); untilRes = { ok: false, elapsedMs: 0, error: "action not performed" }; }
      if (!untilRes.ok && !untilRes.diagnosis && ok) untilRes.diagnosis = await this.untilDiagnosis(spec.until!, untilRes.error ?? "", t0);
      if (alreadyTrue) untilRes.alreadyTrue = true;
    } else if (ok && spec.kind !== "noop" && spec.kind !== "evaluate") await sleep(spec.window ?? T.window);
    const tWin1 = performance.now();
    await this.recorder.flush(300);
    const t1 = this.log.now();
    this.currentAction = null;
    const postAria = await this.ariaSafe();
    const shot = spec.shot ? (await this.screenshot("shot")).hash : undefined;
    const report: Report = {
      action: id, kind: spec.kind === "noop" ? "until" : spec.kind, target: targetText, matches, ok, diagnosis, until: untilRes,
      url: safe(() => this.page.url(), ""),
      ui: diffAria(preAria, postAria, 40, this.uiIgnore),
      ...this.wire(t0, t1, untilRes?.request, spec.wire ?? "app"),
      console: this.log.all("SELECT level, text FROM console WHERE run=? AND t BETWEEN ? AND ? AND level IN ('error','exception','warning') ORDER BY seq", this.log.run, t0, t1 + 1),
      dialogs: this.log.all("SELECT type, message, handled FROM dialogs WHERE run=? AND t BETWEEN ? AND ? ORDER BY seq", this.log.run, t0, t1 + 1),
      pages: this.log.all<{ url: string }>("SELECT url FROM nav WHERE run=? AND kind='popup' AND t BETWEEN ? AND ? ORDER BY seq", this.log.run, t0, t1 + 1).map((x) => x.url),
      openPages: this.context.pages().length,
      writes: [],
      ...(spec.kind === "evaluate" ? { value } : {}),
      shot,
      window: { t0: Math.round(t0), t1: Math.round(t1) },
      timing: { actMs: ms(tAct0, tAct1), untilMs: armed ? ms(tAct1, tWin1) : 0, windowMs: armed ? 0 : ms(tAct1, tWin1), reportMs: 0, totalMs: 0 },
    };
    report.writes = report.requests.filter((w) => !["GET", "HEAD", "OPTIONS"].includes(w.method) && !w.earlier).map((w) => `${w.method} ${w.path}${w.status != null ? " " + w.status : ""}`);
    report.timing.reportMs = ms(tWin1, performance.now());
    report.timing.totalMs = ms(tStart, performance.now());
    this.log.update("actions", { t1, ok, report }, "id=?", [id]);
    if (!this.recording) for (const table of ["requests", "console", "dialogs", "nav", "ws_frames"]) // the recorder process could not know the window; attribution is the window
      this.log.update(table, { action_id: id }, `run=? AND action_id IS NULL AND ${table === "requests" ? "t_start" : "t"} BETWEEN ? AND ?`, [this.log.run, t0 - 1, t1 + 1]);
    return report;
  }

  private wire(t0: number, t1: number, matched: string | undefined, mode: "app" | "all"): { requests: WireLine[]; static: Report["static"] } {
    const all = this.log.all<any>("SELECT id, method, path, url, status, t_start, t_end, mime, body_hash, body_size, body_state, resource_type FROM requests WHERE run=? AND ((t_start BETWEEN ? AND ?) OR (t_start < ? AND (t_end BETWEEN ? AND ? OR t_response BETWEEN ? AND ?)) OR id=?) ORDER BY t_start", this.log.run, t0 - 1, t1 + 1, t0 - 1, t0 - 1, t1 + 1, t0 - 1, t1 + 1, matched ?? "")
      .map((r) => ({ id: r.id, method: r.method, path: pathOf(r.url, r.path), status: r.status, ms: r.t_end != null ? Math.round(r.t_end - r.t_start) : null, mime: shortMime(r.mime), body: r.body_hash ? r.body_hash.slice(0, 16) : null, size: r.body_size, state: r.body_state, type: r.resource_type, ...(r.t_start < t0 - 1 ? { earlier: true } : {}), ...(matched && r.id === matched ? { until: true } : {}) }));
    const types: Record<string, number> = {}; let count = 0;
    const requests = all.filter((w) => { const isStatic = mode === "app" && STATIC_TYPES.has(w.type ?? "") && !w.until; if (isStatic) { count++; types[w.type!] = (types[w.type!] ?? 0) + 1; } return !isStatic; });
    return { requests, static: { count, types } };
  }

  private async resolve(spec: ActSpec): Promise<{ locator: Locator; matches: number; force?: boolean } | { diagnosis: Diagnosis }> {
    const base = this.base(spec.frame);
    const loc = typeof spec.target === "string" ? base.locator(spec.target) : spec.target!;
    const targetText = typeof spec.target === "string" ? spec.target : String(spec.target);
    let count = await loc.count();
    if (count === 0) {
      // brief attach wait: re-renders and route transitions often need a few hundred ms
      try { await loc.first().waitFor({ state: "attached", timeout: Math.min(this.timeouts.action, 1000) }); count = await loc.count(); } catch {}
      if (count === 0) return { diagnosis: await this.finish({ reason: "not-found", message: `no element matches ${targetText}`, target: targetText, candidates: await this.candidates(spec.frame) }) };
    }
    const el = loc.first();
    if (spec.kind === "hover" || spec.kind === "press") return { locator: el, matches: count };
    const detached = () => this.finish({ reason: "detached", message: `${targetText} was replaced while being checked — the app re-renders it continuously; try { js: true } (a dispatched click event)`, target: targetText, matches: count });
    if (!(await el.isVisible())) {
      if (!(await el.evaluate((n: Element) => n.isConnected).catch(() => false))) return { diagnosis: await detached() };
      // a visually-hidden checkbox/radio with a visible <label> is a styled control: the label is what a user clicks
      if (spec.kind === "click") {
        const labelSel = await el.evaluate((n: Element) => {
          if (!(n instanceof HTMLInputElement) || !["checkbox", "radio"].includes(n.type)) return null;
          const lbl = n.closest("label") || (n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`) : null);
          if (!lbl) return null;
          if (!lbl.id) lbl.setAttribute("data-disco-label", String(Date.now()));
          return lbl.id ? `#${CSS.escape(lbl.id)}` : `label[data-disco-label="${lbl.getAttribute("data-disco-label")}"]`;
        }).catch(() => null);
        if (labelSel) { const lbl = this.base(spec.frame).locator(labelSel).first(); if (await lbl.isVisible()) return { locator: lbl, matches: count, force: true }; }
      }
      return { diagnosis: await this.finish({ reason: "hidden", message: `${targetText} exists but is not visible`, target: targetText, matches: count }) };
    }
    if ((spec.kind === "click" || spec.kind === "dblclick" || spec.kind === "fill" || spec.kind === "type" || spec.kind === "select") && !(await el.isEnabled()))
      return { diagnosis: await this.finish({ reason: "disabled", message: `${targetText} is disabled`, target: targetText, matches: count }) };
    if ((spec.kind === "click" || spec.kind === "dblclick") && !spec.js) {
      try { await el.scrollIntoViewIfNeeded({ timeout: 1000 }); } catch {}
      const hit = await el.evaluate((node: Element, pos: { x: number; y: number } | null) => {
        const d = (e: Element) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
        const r = node.getBoundingClientRect();
        const x = pos ? r.left + pos.x : r.left + r.width / 2, y = pos ? r.top + pos.y : r.top + r.height / 2;
        const vw = Math.min(innerWidth, document.documentElement.clientWidth || innerWidth), vh = Math.min(innerHeight, document.documentElement.clientHeight || innerHeight);
        if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {
          let fixed: Element | null = node; while (fixed && getComputedStyle(fixed).position !== "fixed") fixed = fixed.parentElement;
          return { offscreen: `at (${Math.round(r.left)}, ${Math.round(r.top)}) in a ${vw}×${vh} viewport${fixed ? `; ${d(fixed)} is position: fixed, so scrolling cannot bring it into view` : " (a panel translated out of view still counts as visible)"}` };
        }
        for (let e: Element | null = node; e; e = e.parentElement) if (getComputedStyle(e).pointerEvents === "none") return { noPointer: d(e) };
        let h = document.elementFromPoint(x, y);
        while (h && h.shadowRoot) { const inner = h.shadowRoot.elementFromPoint(x, y); if (!inner || inner === h) break; h = inner; }
        if (!h || node.contains(h) || h.contains(node)) return null;
        // a styled checkbox/radio/switch: the real input is hidden under a visual that lives in the same <label> (or a label[for]) — that is the control, not an occluder
        const label = node.closest("label") || (node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null);
        if (label && (label.contains(h) || h === label)) return { styled: d(h) };
        return { over: d(h) };
      }, spec.position ?? null).catch((e: Error) => (/detached|not attached|not connected/i.test(String(e?.message)) ? { detached: true } : null));
      if (hit && "detached" in hit) return { diagnosis: await detached() };
      if (hit?.offscreen) return { diagnosis: await this.finish({ reason: "offscreen", message: `${targetText} is outside the viewport ${hit.offscreen} — scroll the page so it is visible, or click with { js: true } if its handler is delegated`, target: targetText, matches: count }) };
      if (hit?.noPointer) return { diagnosis: await this.finish({ reason: "unclickable", message: `${targetText} ignores the mouse (pointer-events: none on ${hit.noPointer}) — the app wants the keyboard (type / ArrowDown / Enter), or { js: true }`, target: targetText, matches: count }) };
      if (hit?.styled) return { locator: el, matches: count, force: true };
      if (hit?.over) return { diagnosis: await this.finish({ reason: "occluded", message: `${targetText} is covered by ${hit.over}`, target: targetText, matches: count, over: hit.over }) };
    }
    return { locator: el, matches: count };
  }

  private async perform(spec: ActSpec, el: Locator | null, force = false): Promise<void> {
    const T = this.timeouts;
    switch (spec.kind) {
      case "click": if (spec.js) await el!.dispatchEvent("click", undefined, { timeout: T.action }); else await el!.click({ timeout: T.action, button: spec.button, position: spec.position, force }); break;
      case "drag": {
        const to = spec.to;
        if (to && typeof to === "object" && "dx" in to) {
          await el!.scrollIntoViewIfNeeded({ timeout: T.action });
          const box = await el!.boundingBox(); if (!box) throw new Error("drag: target has no box");
          const x = box.x + box.width / 2, y = box.y + box.height / 2;
          await this.page.mouse.move(x, y); await this.page.mouse.down();
          await this.page.mouse.move(x + to.dx / 2, y + to.dy / 2, { steps: 6 }); await this.page.mouse.move(x + to.dx, y + to.dy, { steps: 6 });
          await this.page.mouse.up();
        } else { const base = this.base(spec.frame); const dst = typeof to === "string" ? base.locator(to).first() : (to as Locator); await el!.dragTo(dst, { timeout: T.action }); }
        break;
      }
      case "dblclick": await el!.dblclick({ timeout: T.action, position: spec.position }); break;
      case "fill": await el!.fill(spec.text ?? "", { timeout: T.action }); break;
      case "type": await el!.pressSequentially(spec.text ?? "", { timeout: T.action, delay: 15 }); break;
      case "press": if (el) await el.press(spec.key!, { timeout: T.action }); else await this.page.keyboard.press(spec.key!); break;
      case "select": await el!.selectOption(spec.value as any, { timeout: T.action }); break;
      case "hover": await el!.hover({ timeout: T.action }); break;
      case "scroll":
        if (spec.target) { const base = this.base(spec.frame); const loc = typeof spec.target === "string" ? base.locator(spec.target).first() : spec.target; await loc.scrollIntoViewIfNeeded({ timeout: T.action }); }
        else await this.page.mouse.wheel(0, spec.deltaY ?? 600);
        break;
      case "navigate": await this.page.goto(spec.url!, { waitUntil: "commit", timeout: T.navigate }); break;
      case "evaluate": case "noop": break;
    }
  }

  private async diagnose(e: Error, spec: ActSpec): Promise<Diagnosis> {
    const full = String(e?.message ?? e);
    const msg = full.split("\n").filter((l) => l.trim() && !/^\s*[-=]+\s*$/.test(l)).slice(0, 8).join(" | ");
    const targetText = spec.target === undefined ? undefined : String(spec.target);
    let reason: Diagnosis["reason"] = "error"; let over: string | undefined;
    const m = full.match(/<([a-z][^>]*)>[^\n]*intercepts pointer events/i);
    // a detach-retry loop (often with <html> "intercepting" because the node vanished) is the re-render signature
    if (/detached from the DOM|not attached/i.test(full)) reason = "detached";
    else if (m && /^(html|body)\b/i.test(m[1])) { reason = "offscreen"; over = "<" + m[1].split(" ")[0] + ">"; }
    else if (m) { reason = "occluded"; over = "<" + m[1] + ">"; }
    else if (/scrolling into view if needed/.test(full) && !/done scrolling/.test(full)) reason = "offscreen";
    else if (/not enabled|is disabled/i.test(full)) reason = "disabled";
    else if (/not visible|is hidden/i.test(full)) reason = "hidden";
    else if (/Timeout/i.test(full)) reason = "timeout";
    const hint = reason === "detached" ? " — the app replaces this element faster than a mouse click; try { js: true } (a dispatched click event)"
      : reason === "offscreen" ? ` — the pointer lands on ${over ?? "nothing"}: the element is outside the viewport (a panel translated off-screen, a menu below the fold) or still moving; scroll it into view, or { js: true }`
      : reason === "occluded" ? ` — covered by ${over}` : "";
    return this.finish({ reason, message: msg + hint, target: targetText, over });
  }

  private async finish(d: Diagnosis): Promise<Diagnosis> {
    d.url = safe(() => this.page.url(), "");
    d.dialogs = await this.dialogCensus();
    try { d.shot = (await this.screenshot("diagnosis")).hash; } catch {}
    return d;
  }

  private async untilDiagnosis(pred: Pred, error: string, t0: number): Promise<Diagnosis> {
    const notes: string[] = [];
    const walk = (p: Pred) => {
      if ("any" in p) p.any.forEach(walk); else if ("all" in p) p.all.forEach(walk);
      else if ("request" in p) {
        const rows = this.log.all<any>("SELECT id, t_start, status, url, method FROM requests WHERE run=? AND t_start>=? ORDER BY t_start", this.log.run, t0 - 1)
          .filter((r) => (typeof p.request === "string" ? r.url.includes(p.request) : p.request.test(r.url)) && (!p.method || r.method.toUpperCase() === p.method.toUpperCase()));
        notes.push(rows.length === 0 ? `no request matching ${String(p.request)} was issued during the wait` : `${rows.length} matching request(s) issued (${rows.map((r) => `${r.id} status ${r.status ?? "none yet"}`).join(", ")})`);
        if (rows.length === 0) {
          const arrived = this.log.all<any>("SELECT method, url, status, resource_type FROM requests WHERE run=? AND t_start>=? AND resource_type NOT IN ('script','stylesheet','image','font','media','texttrack','manifest') ORDER BY t_start LIMIT 9", this.log.run, t0 - 1);
          notes.push(arrived.length ? `what did arrive: ${arrived.slice(0, 8).map((r) => `${r.method} ${pathOf(r.url, null)} ${r.status ?? "…"}`).join(", ")}${arrived.length > 8 ? ", …" : ""}` : "nothing else was requested either");
        }
      } else if ("ws" in p) {
        const n = this.log.get<{ n: number }>("SELECT count(*) n FROM ws_frames WHERE run=? AND t>=? AND dir=?", this.log.run, t0 - 1, p.dir ?? "in")?.n ?? 0;
        notes.push(n === 0 ? `no WebSocket frame was ${p.dir === "out" ? "sent" : "received"} during the wait` : `${n} frame(s) ${p.dir === "out" ? "sent" : "received"}, none matched ${String(p.ws)}`);
      } else if ("page" in p) notes.push(`no page opened matching ${String(p.page)}`);
    };
    walk(pred);
    return this.finish({ reason: "timeout", message: `until ${describe(pred)} did not happen: ${error}${notes.length ? " — " + notes.join("; ") : ""}` });
  }

  private dialogCensus(): Promise<string[]> {
    return this.page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]'))) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const title = el.querySelector("h1,h2,h3,h4,[role=heading]")?.textContent?.trim() || (el as HTMLElement).innerText?.trim().slice(0, 80) || "";
        out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${title.slice(0, 80)}"`);
      }
      return out;
    }).catch(() => []);
  }

  private candidates(frame?: string): Promise<string[]> {
    const base = this.base(frame);
    return base.locator("body").evaluate((body: Element) => {
      const out: string[] = [];
      const sel = 'button,a[href],input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="checkbox"],summary';
      for (const el of Array.from(body.querySelectorAll(sel))) {
        const h = el as HTMLElement;
        const r = h.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const name = (h.getAttribute("aria-label") || h.innerText || (h as HTMLInputElement).placeholder || (h as HTMLInputElement).value || h.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 40);
        const tag = h.tagName.toLowerCase(); const type = (h.getAttribute("type") || "").toLowerCase();
        const role = h.getAttribute("role") || (tag === "button" || tag === "summary" ? "button" : tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "input" ? (type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "submit" || type === "button" ? "button" : "textbox") : tag);
        // a selector that pastes: role=…[name="…"] matches icon buttons and inputs that :has-text() cannot
        const sel = name ? `role=${role}[name="${name.replace(/"/g, '\\"')}"]` : h.id ? `#${h.id}` : tag;
        out.push(h.id && name ? `${sel} (#${h.id})` : sel);
        if (out.length >= 25) break;
      }
      return out;
    }).catch(() => []);
  }

  private async ariaSafe(): Promise<string> {
    try { return await this.page.locator("body").ariaSnapshot({ timeout: 1500 }); } catch { return ""; }
  }

  // --- until ---------------------------------------------------------------------------------------
  private arm(pred: Pred, timeout: number): { wait: () => Promise<UntilResult>; cancel: () => void; resolvedAt?: number } {
    const t0 = performance.now();
    let cancelled = false;
    const ctx: ArmContext = {};
    const handle: { wait: () => Promise<UntilResult>; cancel: () => void; resolvedAt?: number } = { wait: () => p, cancel: () => { cancelled = true; } };
    const p = this.waitPred(pred, timeout, ctx).then(
      (which) => { handle.resolvedAt = performance.now(); return { ok: true, elapsedMs: ms(t0, handle.resolvedAt), which, ...(ctx.request ? { request: ctx.request } : {}) }; },
      (e) => ({ ok: false, elapsedMs: ms(t0, performance.now()), error: firstLine(e) }),
    );
    p.catch(() => {});
    return handle;
  }

  /** Cheap pre-dispatch check for element/text predicates (the ones that can be trivially true already). */
  private async holdsNow(pred: Pred): Promise<boolean> {
    try {
      if ("any" in pred) { for (const p of pred.any) if (await this.holdsNow(p)) return true; return false; }
      if ("all" in pred) { for (const p of pred.all) if (!(await this.holdsNow(p))) return false; return true; }
      if ("selector" in pred) { const l = this.base(pred.frame).locator(pred.selector).first(); return pred.visible === false ? (await l.count()) > 0 : l.isVisible(); }
      if ("gone" in pred) return !(await this.base(pred.frame).locator(pred.gone).first().isVisible());
      if ("text" in pred) return this.page.getByText(pred.text).first().isVisible();
      if ("url" in pred) return urlMatches(pred.url, this.page.url());
      if ("fn" in pred) return !!(await this.page.evaluate(pred.fn as any, pred.arg));
    } catch {}
    return false;
  }

  private waitPred(pred: Pred, timeout: number, ctx: ArmContext = {}): Promise<string> {
    const label = pred.label ?? describe(pred);
    const done = (p: Promise<unknown>) => p.then(() => label);
    if ("any" in pred) return firstFulfilled(pred.any.map((x) => this.waitPred(x, timeout, ctx)));
    if ("all" in pred) return Promise.all(pred.all.map((x) => this.waitPred(x, timeout, ctx))).then(() => label);
    if ("selector" in pred) return done(this.base(pred.frame).locator(pred.selector).first().waitFor({ state: pred.visible === false ? "attached" : "visible", timeout }));
    if ("gone" in pred) return done(this.base(pred.frame).locator(pred.gone).first().waitFor({ state: "hidden", timeout }));
    if ("text" in pred) return done(this.page.getByText(pred.text).first().waitFor({ state: "visible", timeout }));
    if ("url" in pred) { const u = pred.url; return done(this.page.waitForURL((x) => urlMatches(u, x.href), { timeout, waitUntil: "commit" })); }
    if ("request" in pred) {
      const r = pred.request; const match = (url: string) => (typeof r === "string" ? url.includes(r) : r.test(url));
      const wantMethod = pred.method?.toUpperCase();
      return done(this.page.waitForResponse((res) => match(res.url()) && (!wantMethod || res.request().method().toUpperCase() === wantMethod), { timeout }).then(async (res) => {
        ctx.request = this.recorder.idOf(res.request());
        // a body the page never reads never "finishes" in Chromium (and cannot be fetched at all), so landed waits at most 1 s past the headers
        if (pred.landed) await Promise.race([res.finished(), new Promise((r) => setTimeout(r, LANDED_BOUND_MS))]);
        return res;
      }));
    }
    if ("fn" in pred) return done(this.page.waitForFunction(pred.fn as any, pred.arg, { timeout, polling: 100 }));
    if ("page" in pred) {
      const u = pred.page;
      return done(this.context.waitForEvent("page", { timeout }).then((p) => p.waitForURL((x) => urlMatches(u, x.href), { timeout, waitUntil: "commit" })));
    }
    if ("ws" in pred) {
      const m = pred.ws;
      const match = (payload: unknown) => (typeof m === "string" ? String(payload).includes(m) : m.test(String(payload)));
      return new Promise<string>((resolve, reject) => {
        const want = pred.dir ?? "in";
        const cb = (f: WsFrame) => { if (f.dir === want && match(f.payload)) { cleanup(); resolve(label); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`no WebSocket frame matching ${String(m)} within ${timeout}ms`)); }, timeout);
        const cleanup = () => { clearTimeout(timer); this.recorder.offFrame(cb); };
        this.recorder.onFrame(cb);
      });
    }
    return Promise.reject(new Error("unknown predicate " + JSON.stringify(pred)));
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
export function describe(p: Pred): string {
  if ("any" in p) return "any(" + p.any.map(describe).join(", ") + ")";
  if ("all" in p) return "all(" + p.all.map(describe).join(", ") + ")";
  if ("selector" in p) return (p.visible === false ? "attached " : "") + p.selector + (p.frame ? ` in ${p.frame}` : "");
  if ("gone" in p) return "gone " + p.gone;
  if ("text" in p) return `text "${p.text}"`;
  if ("url" in p) return "url " + String(p.url);
  if ("request" in p) return "request " + (p.method ? p.method.toUpperCase() + " " : "") + String(p.request) + (p.landed ? " landed" : "");
  if ("fn" in p) return "fn " + (typeof p.fn === "string" ? p.fn : p.fn.name || "…").slice(0, 60);
  if ("page" in p) return "page " + String(p.page);
  if ("ws" in p) return "ws " + (p.dir === "out" ? "sent " : "") + String(p.ws);
  return JSON.stringify(p);
}

/** Throw unless the action was performed and its `until` (if any) held. The message carries the diagnosis. */
export function reached(r: Report, what?: string): Report {
  if (r.ok && r.until?.alreadyTrue) throw new Error(`${what ?? r.action}: until ${r.until.which ?? ""} was already true before the action — it proves nothing; wait for something that is false beforehand`);
  if (r.ok && (!r.until || r.until.ok)) return r;
  const d = r.diagnosis ?? r.until?.diagnosis;
  throw new Error(`${what ?? r.action}: ${r.ok ? `until failed after ${r.until?.elapsedMs}ms` : r.diagnosis?.reason}${d ? ` — ${d.message}${d.dialogs?.length ? ` (open: ${d.dialogs.join("; ")})` : ""}${d.shot ? ` [shot ${d.shot.slice(0, 12)}]` : ""}` : ""}`);
}

interface ArmContext { request?: string }
/** Labels of the arms that describe a STATE (element, text, url, fn) — the ones that can be true before an action. Event arms (request, ws, page) only ever see the future. */
function stateArms(p: Pred, out = new Set<string>()): Set<string> {
  if ("any" in p) { p.any.forEach((x) => stateArms(x, out)); return out; }
  if ("all" in p) { p.all.forEach((x) => stateArms(x, out)); out.add(p.label ?? describe(p)); return out; }
  if (!("request" in p) && !("ws" in p) && !("page" in p)) out.add(p.label ?? describe(p));
  return out;
}
/** Playwright resource types that are the page's own assets, not the app talking to its server. */
const STATIC_TYPES = new Set(["script", "stylesheet", "image", "font", "media", "texttrack", "manifest"]);

/** Rows whose headers arrived but whose body never finished are bodies the page never read: no recorder will ever complete them. */
export function sweepUnread(log: Store): void {
  log.update("requests", { body_state: "missing", error: "body not read by the page" }, "body_state='pending' AND status IS NOT NULL AND t_response < ?", [log.now() - 1500]);
}

function firstFulfilled<T>(ps: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let rejected = 0; const errors: unknown[] = [];
    ps.forEach((p, i) => p.then(resolve, (e) => {
      errors[i] = e;
      // a malformed selector (or any non-timeout failure) in one arm is a bug in the predicate: say so now, don't burn the budget on the other arms
      if (!/timeout/i.test(String((e as any)?.message ?? e))) { reject(new Error("arm failed: " + firstLine(e))); return; }
      if (++rejected === ps.length) reject(new Error("none matched: " + errors.map(firstLine).join(" / ")));
    }));
  });
}
function firstLine(e: unknown): string { return String((e as any)?.message ?? e).split("\n")[0].slice(0, 200); }
function ms(a: number, b: number): number { return Math.round(b - a); }
function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
function sleep(n: number) { return new Promise((r) => setTimeout(r, n)); }
function pathOf(url: string, path: string | null): string { try { const u = new URL(url); return u.pathname + u.search; } catch { return path ?? url; } }
function shortMime(m: string | null): string | null { if (!m) return null; const b = m.split(";")[0].trim(); return b.replace(/^application\//, "").replace(/^text\//, "text/"); }

/** Line-multiset diff of two aria snapshots. */
export function diffAria(pre: string, post: string, cap = 40, ignore: Array<string | RegExp> = []): Report["ui"] {
  const skip = (t: string) => ignore.some((x) => (typeof x === "string" ? t.includes(x) : x.test(t)));
  const count = (s: string) => { const m = new Map<string, number>(); for (const l of s.split("\n")) { const t = l.trim(); if (t && !skip(t)) m.set(t, (m.get(t) ?? 0) + 1); } return m; };
  const a = count(pre), b = count(post);
  const added: string[] = [], removed: string[] = [];
  for (const [l, n] of b) { const d = n - (a.get(l) ?? 0); for (let i = 0; i < d; i++) added.push(l); }
  for (const [l, n] of a) { const d = n - (b.get(l) ?? 0); for (let i = 0; i < d; i++) removed.push(l); }
  const more = Math.max(0, added.length - cap) + Math.max(0, removed.length - cap);
  return { added: added.slice(0, cap), removed: removed.slice(0, cap), ...(more ? { more } : {}) };
}
