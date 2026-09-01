// The one wrapper. `act` = do a Playwright action, optionally wait for the state you asked for
// (`until`), then return what happened: URL, aria diff, requests, console, dialogs, new pages —
// or a diagnosis when the action could not be performed. Every wait is short and named.
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, FrameLocator, Locator, Page } from "playwright-core";
import { Store, appStoreDir, appDir, openStore, type StoreReader } from "./store.ts";
import { attachRecorder, type DialogPolicy, type Recorder } from "./record.ts";
import { readBrowserInfo, writeBrowserInfo, isAlive, launchChromium, attachEndpoint, connect, killLaunched, type BrowserInfo } from "./browser.ts";

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
export function urlMatches(u: string | RegExp, href: string): boolean {
  if (typeof u !== "string") return u.test(href);
  if (u.includes("?")) return href.includes(u);
  const q = href.indexOf("?"); return (q >= 0 ? href.slice(0, q) : href).includes(u);
}

export type Pred =
  | { selector: string; visible?: boolean; frame?: string; label?: string }   // an element exists (visible: true → is visible)
  | { gone: string; frame?: string; label?: string }                          // an element is hidden or detached
  | { text: string; label?: string }                                          // visible text anywhere on the page
  | { url: string | RegExp; label?: string }                                  // string: URL without its query contains it (with it, if the string has a '?'); RegExp: whole href
  | { request: string | RegExp; landed?: boolean; label?: string }            // a response whose URL contains / matches arrives (landed: its body finished too — bounded at 1 s past the headers)
  | { fn: string | ((arg: any) => unknown); arg?: unknown; label?: string }   // page.waitForFunction
  | { any: Pred[]; label?: string }
  | { all: Pred[]; label?: string };

export type Kind = "click" | "dblclick" | "fill" | "type" | "press" | "select" | "hover" | "scroll" | "drag" | "navigate" | "noop";

export interface ActSpec {
  kind: Kind;
  target?: string | Locator;
  text?: string;               // fill / type
  key?: string;                // press
  value?: string | string[];   // select
  url?: string;                // navigate
  frame?: string;              // iframe selector(s), `>>`-chained for nesting; the target is resolved inside
  button?: "left" | "right" | "middle";
  js?: boolean;                // click: dispatch a DOM click event instead of moving the mouse (widgets the app re-renders under you)
  to?: string | Locator;       // drag: the drop target
  deltaY?: number;             // scroll without a target
  until?: Pred;
  timeout?: number;            // budget for `until` (default timeouts.until)
  window?: number;             // observation window when there is no `until` (default timeouts.window)
  shot?: boolean;              // take a screenshot at the end of the window
}

export interface Diagnosis {
  reason: "not-found" | "hidden" | "disabled" | "occluded" | "detached" | "timeout" | "error";
  message: string;
  target?: string;
  matches?: number;
  over?: string;               // the element that would receive the click instead
  candidates?: string[];       // visible controls on the page (not-found)
  dialogs?: string[];          // open dialogs/overlays at the time
  url?: string;
  shot?: string;               // screenshot blob hash
}
export interface UntilResult { ok: boolean; elapsedMs: number; which?: string; error?: string; diagnosis?: Diagnosis; /** the predicate already held before the action was dispatched — it proved nothing */ alreadyTrue?: boolean }
export interface WireLine { id: string; method: string; path: string; status?: number | null; ms?: number | null; mime?: string | null; body?: string | null; size?: number | null; state?: string | null; type?: string | null }
export interface Report {
  action: string;              // act:<n>
  kind: Kind | "until";
  target?: string;
  matches?: number;
  ok: boolean;                 // the action was performed (a failed `until` still has ok: true — read report.until)
  diagnosis?: Diagnosis;
  until?: UntilResult;
  url: string;
  ui: { added: string[]; removed: string[]; more?: number };
  requests: WireLine[];
  console: Array<{ level: string; text: string }>;
  dialogs: Array<{ type: string; message: string | null; handled: string | null }>;
  pages: string[];
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
  let page = pages[opts.page ?? 0];
  if (!page) {
    if (opts.url && info.mode === "attach") page = pages.find((p) => p.url().includes(opts.url!)) ?? pages[0];
    page = page ?? (await context.newPage());
  }
  const store = new Store(storeDir);
  if (fresh || !store.resumeRun()) store.beginRun({ url: opts.url ?? page.url(), mode: info.mode });
  const s = new Session(app, dir, store, browser, context, page, info, { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) }, opts.dialogs ?? "accept");
  if (opts.url && (info.mode === "launch" || page.url() !== opts.url)) await s.navigate(opts.url);
  return s;
}

export class Session {
  private currentAction: string | null = null;
  private recorder: Recorder;
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

  constructor(app: string, dir: string, log: Store, browser: Browser, context: BrowserContext, page: Page, info: BrowserInfo, timeouts: Timeouts, dialogs: DialogPolicy) {
    this.app = app; this.dir = dir; this.log = log; this.browser = browser; this.context = context; this.page = page; this.info = info; this.timeouts = timeouts; this.dialogs = dialogs;
    page.setDefaultTimeout(timeouts.action);
    this.recorder = attachRecorder(context, log, () => this.currentAction, dialogs);
  }

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
  drag(target: string | Locator, to: string | Locator, o: Partial<ActSpec> = {}) { return this.act({ kind: "drag", target, to, ...o }); }
  navigate(url: string, o: Partial<ActSpec> = {}) { return this.act({ kind: "navigate", url, ...o }); }
  /** Wait for a state without acting. Same report shape; `report.until` says whether it arrived. */
  until(pred: Pred, o: { timeout?: number } = {}) { return this.act({ kind: "noop", until: pred, timeout: o.timeout }); }

  /** A FrameLocator for `iframe#a >> iframe#b`. */
  frame(spec: string): FrameLocator {
    let fl: FrameLocator | null = null;
    for (const part of spec.split(">>").map((x) => x.trim()).filter(Boolean)) fl = fl ? fl.frameLocator(part) : this.page.frameLocator(part);
    if (!fl) throw new Error("empty frame spec");
    return fl;
  }
  private base(frame?: string): Page | FrameLocator { return frame ? this.frame(frame) : this.page; }

  evaluate<T = unknown>(fn: string | ((arg: any) => T | Promise<T>), arg?: unknown): Promise<T> { return this.page.evaluate(fn as any, arg) as Promise<T>; }

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
    const preAria = await this.ariaSafe();
    const t0 = this.log.now();
    this.log.insert("actions", { id, n, t0, kind: spec.kind, target: targetText });
    this.currentAction = id;
    let ok = true; let diagnosis: Diagnosis | undefined; let matches: number | undefined;
    let untilRes: UntilResult | undefined;
    // arm the postcondition before dispatching, so a response that lands during the action counts
    const untilBudget = spec.timeout ?? T.until;
    const alreadyTrue = spec.until && spec.kind !== "noop" ? await this.holdsNow(spec.until) : false;
    const armed = spec.until ? this.arm(spec.until, untilBudget) : null;
    const tAct0 = performance.now();
    try {
      if (spec.kind !== "noop" && spec.kind !== "navigate" && spec.kind !== "scroll" && !(spec.kind === "press" && !spec.target)) {
        const r = await this.resolve(spec);
        if ("diagnosis" in r) { ok = false; diagnosis = r.diagnosis; }
        else { matches = r.matches; await this.perform(spec, r.locator); }
      } else await this.perform(spec, null);
    } catch (e) {
      ok = false; diagnosis = await this.diagnose(e as Error, spec);
    }
    const tAct1 = performance.now();
    if (armed) {
      if (ok) untilRes = await armed.wait();
      else { armed.cancel(); untilRes = { ok: false, elapsedMs: 0, error: "action not performed" }; }
      if (!untilRes.ok && !untilRes.diagnosis && ok) untilRes.diagnosis = await this.untilDiagnosis(spec.until!, untilRes.error ?? "");
      if (alreadyTrue) untilRes.alreadyTrue = true;
    } else if (ok && spec.kind !== "noop") await sleep(spec.window ?? T.window);
    const tWin1 = performance.now();
    await this.recorder.flush(300);
    const t1 = this.log.now();
    this.currentAction = null;
    const postAria = await this.ariaSafe();
    const shot = spec.shot ? (await this.screenshot("shot")).hash : undefined;
    const report: Report = {
      action: id, kind: spec.kind === "noop" ? "until" : spec.kind, target: targetText, matches, ok, diagnosis, until: untilRes,
      url: safe(() => this.page.url(), ""),
      ui: diffAria(preAria, postAria),
      requests: this.wire(t0, t1),
      console: this.log.all("SELECT level, text FROM console WHERE run=? AND t BETWEEN ? AND ? AND level IN ('error','exception','warning') ORDER BY seq", this.log.run, t0, t1 + 1),
      dialogs: this.log.all("SELECT type, message, handled FROM dialogs WHERE run=? AND t BETWEEN ? AND ? ORDER BY seq", this.log.run, t0, t1 + 1),
      pages: this.log.all<{ url: string }>("SELECT url FROM nav WHERE run=? AND kind='popup' AND t BETWEEN ? AND ? ORDER BY seq", this.log.run, t0, t1 + 1).map((x) => x.url),
      shot,
      window: { t0: Math.round(t0), t1: Math.round(t1) },
      timing: { actMs: ms(tAct0, tAct1), untilMs: armed ? ms(tAct1, tWin1) : 0, windowMs: armed ? 0 : ms(tAct1, tWin1), reportMs: 0, totalMs: 0 },
    };
    report.timing.reportMs = ms(tWin1, performance.now());
    report.timing.totalMs = ms(tStart, performance.now());
    this.log.update("actions", { t1, ok, report }, "id=?", [id]);
    return report;
  }

  private wire(t0: number, t1: number): WireLine[] {
    return this.log.all<any>("SELECT id, method, path, url, status, t_start, t_end, mime, body_hash, body_size, body_state, resource_type FROM requests WHERE run=? AND t_start BETWEEN ? AND ? ORDER BY t_start", this.log.run, t0 - 1, t1 + 1)
      .map((r) => ({ id: r.id, method: r.method, path: pathOf(r.url, r.path), status: r.status, ms: r.t_end != null ? Math.round(r.t_end - r.t_start) : null, mime: shortMime(r.mime), body: r.body_hash ? r.body_hash.slice(0, 16) : null, size: r.body_size, state: r.body_state, type: r.resource_type }));
  }

  private async resolve(spec: ActSpec): Promise<{ locator: Locator; matches: number } | { diagnosis: Diagnosis }> {
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
    if (!(await el.isVisible())) return { diagnosis: await this.finish({ reason: "hidden", message: `${targetText} exists but is not visible`, target: targetText, matches: count }) };
    if ((spec.kind === "click" || spec.kind === "dblclick" || spec.kind === "fill" || spec.kind === "type" || spec.kind === "select") && !(await el.isEnabled()))
      return { diagnosis: await this.finish({ reason: "disabled", message: `${targetText} is disabled`, target: targetText, matches: count }) };
    if ((spec.kind === "click" || spec.kind === "dblclick") && !spec.js) {
      try { await el.scrollIntoViewIfNeeded({ timeout: 1000 }); } catch {}
      const over = await el.evaluate((node: Element) => {
        const r = node.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        let hit = document.elementFromPoint(x, y);
        while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
        if (!hit || node.contains(hit) || hit.contains(node)) return null;
        const d = (e: Element) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
        return d(hit);
      }).catch(() => null);
      if (over) return { diagnosis: await this.finish({ reason: "occluded", message: `${targetText} is covered by ${over}`, target: targetText, matches: count, over }) };
    }
    return { locator: el, matches: count };
  }

  private async perform(spec: ActSpec, el: Locator | null): Promise<void> {
    const T = this.timeouts;
    switch (spec.kind) {
      case "click": if (spec.js) await el!.dispatchEvent("click", undefined, { timeout: T.action }); else await el!.click({ timeout: T.action, button: spec.button }); break;
      case "drag": { const base = this.base(spec.frame); const to = typeof spec.to === "string" ? base.locator(spec.to).first() : spec.to!; await el!.dragTo(to, { timeout: T.action }); break; }
      case "dblclick": await el!.dblclick({ timeout: T.action }); break;
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
      case "noop": break;
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
    else if (m) { reason = "occluded"; over = "<" + m[1] + ">"; }
    else if (/not enabled|is disabled/i.test(full)) reason = "disabled";
    else if (/not visible|is hidden/i.test(full)) reason = "hidden";
    else if (/Timeout/i.test(full)) reason = "timeout";
    return this.finish({ reason, message: reason === "detached" ? msg + " — the app replaces this element faster than a mouse click; try { js: true } (a dispatched click event)" : msg, target: targetText, over });
  }

  private async finish(d: Diagnosis): Promise<Diagnosis> {
    d.url = safe(() => this.page.url(), "");
    d.dialogs = await this.dialogCensus();
    try { d.shot = (await this.screenshot("diagnosis")).hash; } catch {}
    return d;
  }

  private async untilDiagnosis(pred: Pred, error: string): Promise<Diagnosis> {
    return this.finish({ reason: "timeout", message: `until ${describe(pred)} did not happen: ${error}` });
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
        const d = h.tagName.toLowerCase() + (h.id ? "#" + h.id : "") + (h.getAttribute("role") ? `[role=${h.getAttribute("role")}]` : "");
        out.push(name ? `${d} "${name}"` : d);
        if (out.length >= 25) break;
      }
      return out;
    }).catch(() => []);
  }

  private async ariaSafe(): Promise<string> {
    try { return await this.page.locator("body").ariaSnapshot({ timeout: 1500 }); } catch { return ""; }
  }

  // --- until ---------------------------------------------------------------------------------------
  private arm(pred: Pred, timeout: number): { wait: () => Promise<UntilResult>; cancel: () => void } {
    const t0 = performance.now();
    let cancelled = false;
    const p = this.waitPred(pred, timeout).then(
      (which) => ({ ok: true, elapsedMs: ms(t0, performance.now()), which }),
      (e) => ({ ok: false, elapsedMs: ms(t0, performance.now()), error: firstLine(e) }),
    );
    p.catch(() => {});
    return { wait: () => p, cancel: () => { cancelled = true; } };
  }

  /** Cheap pre-dispatch check for element/text predicates (the ones that can be trivially true already). */
  private async holdsNow(pred: Pred): Promise<boolean> {
    try {
      if ("any" in pred) { for (const p of pred.any) if (await this.holdsNow(p)) return true; return false; }
      if ("all" in pred) { for (const p of pred.all) if (!(await this.holdsNow(p))) return false; return true; }
      if ("selector" in pred) { const l = this.base(pred.frame).locator(pred.selector).first(); return pred.visible ? l.isVisible() : (await l.count()) > 0; }
      if ("gone" in pred) return !(await this.base(pred.frame).locator(pred.gone).first().isVisible());
      if ("text" in pred) return this.page.getByText(pred.text).first().isVisible();
      if ("url" in pred) return urlMatches(pred.url, this.page.url());
    } catch {}
    return false;
  }

  private waitPred(pred: Pred, timeout: number): Promise<string> {
    const label = pred.label ?? describe(pred);
    const done = (p: Promise<unknown>) => p.then(() => label);
    if ("any" in pred) return firstFulfilled(pred.any.map((x) => this.waitPred(x, timeout)));
    if ("all" in pred) return Promise.all(pred.all.map((x) => this.waitPred(x, timeout))).then(() => label);
    if ("selector" in pred) return done(this.base(pred.frame).locator(pred.selector).first().waitFor({ state: pred.visible ? "visible" : "attached", timeout }));
    if ("gone" in pred) return done(this.base(pred.frame).locator(pred.gone).first().waitFor({ state: "hidden", timeout }));
    if ("text" in pred) return done(this.page.getByText(pred.text).first().waitFor({ state: "visible", timeout }));
    if ("url" in pred) { const u = pred.url; return done(this.page.waitForURL((x) => urlMatches(u, x.href), { timeout, waitUntil: "commit" })); }
    if ("request" in pred) {
      const r = pred.request; const match = (url: string) => (typeof r === "string" ? url.includes(r) : r.test(url));
      return done(this.page.waitForResponse((res) => match(res.url()), { timeout }).then(async (res) => {
        // a body the page never reads never "finishes" in Chromium (and cannot be fetched at all), so landed waits at most 1 s past the headers
        if (pred.landed) await Promise.race([res.finished(), new Promise((r) => setTimeout(r, LANDED_BOUND_MS))]);
        return res;
      }));
    }
    if ("fn" in pred) return done(this.page.waitForFunction(pred.fn as any, pred.arg, { timeout, polling: 100 }));
    return Promise.reject(new Error("unknown predicate " + JSON.stringify(pred)));
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
export function describe(p: Pred): string {
  if ("any" in p) return "any(" + p.any.map(describe).join(", ") + ")";
  if ("all" in p) return "all(" + p.all.map(describe).join(", ") + ")";
  if ("selector" in p) return (p.visible ? "visible " : "") + p.selector + (p.frame ? ` in ${p.frame}` : "");
  if ("gone" in p) return "gone " + p.gone;
  if ("text" in p) return `text "${p.text}"`;
  if ("url" in p) return "url " + String(p.url);
  if ("request" in p) return "request " + String(p.request) + (p.landed ? " landed" : "");
  if ("fn" in p) return "fn " + (typeof p.fn === "string" ? p.fn : p.fn.name || "…").slice(0, 60);
  return JSON.stringify(p);
}

/** Throw unless the action was performed and its `until` (if any) held. The message carries the diagnosis. */
export function reached(r: Report, what?: string): Report {
  if (r.ok && (!r.until || r.until.ok)) return r;
  const d = r.diagnosis ?? r.until?.diagnosis;
  throw new Error(`${what ?? r.action}: ${r.ok ? `until failed after ${r.until?.elapsedMs}ms` : r.diagnosis?.reason}${d ? ` — ${d.message}${d.dialogs?.length ? ` (open: ${d.dialogs.join("; ")})` : ""}${d.shot ? ` [shot ${d.shot.slice(0, 12)}]` : ""}` : ""}`);
}

function firstFulfilled<T>(ps: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let rejected = 0; const errors: unknown[] = [];
    ps.forEach((p, i) => p.then(resolve, (e) => { errors[i] = e; if (++rejected === ps.length) reject(new Error("none matched: " + errors.map(firstLine).join(" / "))); }));
  });
}
function firstLine(e: unknown): string { return String((e as any)?.message ?? e).split("\n")[0].slice(0, 200); }
function ms(a: number, b: number): number { return Math.round(b - a); }
function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
function sleep(n: number) { return new Promise((r) => setTimeout(r, n)); }
function pathOf(url: string, path: string | null): string { try { const u = new URL(url); return u.pathname + u.search; } catch { return path ?? url; } }
function shortMime(m: string | null): string | null { if (!m) return null; const b = m.split(";")[0].trim(); return b.replace(/^application\//, "").replace(/^text\//, "text/"); }

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
