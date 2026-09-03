// disco-lite: the runtime a pack needs outside disco. Plain Playwright; nothing is written to disk; there is no log.
// It has the shape a workflow was written against — open, reached, s.act, s.json, s.body, s.waitFor, s.look(selector),
// s.page, s.close — and none of the instruments: no recorder, no UI diff, no proposals, no diagnosis beyond Playwright's
// message, no evidence. `npm run export -- <app> <dir>` copies this file beside the pack as disco-lite.ts.
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page, type Locator, type WebSocket } from "playwright-core";

export interface WireLine { id: string; method: string; path: string; status?: number | null; ms?: number | null; mime?: string | null; body?: string | null; size?: number | null; state?: string | null }
export interface Report<T = unknown> {
  action: string; label: string; ok: boolean; value?: T;
  returned: "until" | "quiet" | "max" | "error";
  until?: { ok: boolean; elapsedMs: number; error?: string; value?: unknown };
  url: string; requests: WireLine[]; pending: string[]; error?: string;
  timing: { runMs: number; observeMs: number; totalMs: number; quiet: number; max: number };
}
export interface ActOptions { until?: () => Promise<unknown>; quiet?: number; max?: number }
export type EventKind = "request" | "response" | "ws" | "console" | "dialog" | "page" | "nav";

/** Throws unless the code ran and its until held. */
export function reached<T>(r: Report<T>, what?: string): Report<T> {
  if (!r.ok) throw new Error(`${what ?? r.label} (${r.action}) failed: ${r.error}`);
  if (r.until && !r.until.ok) throw new Error(`${what ?? r.label} (${r.action}): until failed: ${r.until.error}`);
  return r;
}

type Row = { id: string; t: number; tEnd?: number; method: string; url: string; status?: number; mime?: string; body?: string; size?: number; action: string | null; done: boolean };
const TEXTUAL = /json|xml|text\/|x-www-form-urlencoded|javascript|html/i;
const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];

export class Session {
  browser: Browser; context: BrowserContext; page: Page;
  #launched: boolean; #n = 0; #current: string | null = null; #rows = 0;
  #ring: Row[] = []; #blobs = new Map<string, string>(); #reads = new Set<Promise<unknown>>();
  #lastEvent = Date.now(); #wsListeners = new Set<(e: { dir: "in" | "out"; payload: string; url: string }) => void>();

  constructor(browser: Browser, context: BrowserContext, page: Page, launched: boolean) {
    this.browser = browser; this.context = context; this.page = page; this.#launched = launched;
    const bump = () => { this.#lastEvent = Date.now(); };
    context.on("request", (req) => {
      if (!["xhr", "fetch", "document", "other"].includes(req.resourceType())) return;
      bump();
      this.#ring.push({ id: `r:${++this.#rows}`, t: Date.now(), method: req.method(), url: req.url(), action: this.#current, done: false });
      if (this.#ring.length > 500) { const old = this.#ring.shift(); if (old?.body && !this.#ring.some((r) => r.body === old.body)) this.#blobs.delete(old.body); }
    });
    context.on("response", (res) => {
      const req = res.request(); if (!["xhr", "fetch", "document", "other"].includes(req.resourceType())) return;
      bump();
      const row = this.#ring.findLast((r) => !r.done && r.url === res.url() && r.method === req.method()); if (!row) return;
      row.status = res.status(); row.tEnd = Date.now(); row.mime = (res.headers()["content-type"] ?? "").split(";")[0] || undefined; row.done = true;
      if (TEXTUAL.test(row.mime ?? "")) {
        const p = res.text().then((text) => { const hash = createHash("sha256").update(text).digest("hex"); row.body = hash; row.size = text.length; this.#blobs.set(hash, text); }, () => {});
        this.#reads.add(p); p.finally(() => this.#reads.delete(p));
      }
    });
    context.on("requestfailed", (req) => { bump(); const row = this.#ring.findLast((r) => !r.done && r.url === req.url()); if (row) { row.done = true; row.tEnd = Date.now(); } });
    const watch = (p: Page) => {
      p.on("console", bump); p.on("framenavigated", (f) => { if (f === p.mainFrame()) bump(); });
      p.on("dialog", (d) => { bump(); d.accept().catch(() => {}); });
      p.on("websocket", (ws: WebSocket) => {
        const last: Record<string, string> = {};
        const frame = (dir: "in" | "out") => (f: { payload: string | Buffer }) => {
          const payload = String(f.payload);
          if (last[dir] !== payload) bump();   // a frame identical to the previous one in its direction is a heartbeat
          last[dir] = payload;
          for (const cb of this.#wsListeners) cb({ dir, payload, url: ws.url() });
        };
        ws.on("framereceived", frame("in")); ws.on("framesent", frame("out"));
      });
    };
    for (const p of context.pages()) watch(p);
    context.on("page", (p) => { bump(); watch(p); });
  }

  /** Run any Playwright code as one step. Returns when your `until` holds, when the app's traffic has paused for `quiet` ms, or at `max`. */
  async act<T = unknown>(label: string, run: (page: Page) => Promise<T> | T, o: ActOptions = {}): Promise<Report<T>> {
    const quiet = o.quiet ?? 500, max = o.max ?? 3000, id = `act:${++this.#n}`, t0 = Date.now();
    this.page.setDefaultTimeout(max); this.page.setDefaultNavigationTimeout(max); this.#current = id;
    const armed = { done: false, error: undefined as string | undefined, value: undefined as unknown, at: 0 };
    let untilP: Promise<unknown> | null = null;
    if (o.until) {
      try { untilP = Promise.resolve(o.until()); } catch (e) { untilP = Promise.reject(e); }
      untilP.then((v) => { armed.done = true; armed.value = v; armed.at = Date.now(); }, (e) => { armed.done = true; armed.error = firstLine(e); });
    }
    let ok = true, value: T | undefined, error: string | undefined;
    try { value = await run(this.page); } catch (e) { ok = false; error = firstLine(e); }
    const tRun1 = Date.now();
    let returned: Report["returned"] = "error"; let until: Report["until"];
    if (ok && untilP) {
      if (!armed.done) await Promise.race([untilP.catch(() => {}), new Promise((r) => setTimeout(r, Math.max(0, max - (Date.now() - t0))))]);
      if (armed.done && !armed.error) { returned = "until"; until = { ok: true, elapsedMs: armed.at - t0, ...(armed.value !== undefined ? { value: armed.value } : {}) }; }
      else { returned = "max"; until = { ok: false, elapsedMs: Date.now() - t0, error: armed.error ?? `did not hold within max (${max} ms)` }; }
    } else if (ok) {
      const deadline = t0 + max;
      for (;;) {
        await new Promise((r) => setTimeout(r, Math.min(quiet, 100)));
        const pending = this.#ring.filter((r) => r.t >= t0 && !r.done).length;
        if (Date.now() - this.#lastEvent >= quiet && pending === 0) { returned = "quiet"; break; }
        if (Date.now() >= deadline) { returned = "max"; break; }
      }
    }
    const tObs1 = Date.now();
    this.#current = null;
    if (this.#reads.size) await Promise.race([Promise.allSettled([...this.#reads]), new Promise((r) => setTimeout(r, 500))]);   // bodies still being read
    const mine = this.#ring.filter((r) => r.action === id);
    return {
      action: id, label, ok, ...(value !== undefined ? { value } : {}), returned, until, url: this.page.url(),
      requests: mine.map((r) => ({ id: r.id, method: r.method, path: pathOf(r.url), status: r.status ?? null, ms: r.tEnd != null ? r.tEnd - r.t : null, mime: r.mime ?? null, body: r.body ?? null, size: r.size ?? null, state: r.done ? "ok" : "pending" })),
      pending: mine.filter((r) => !r.done).map((r) => `${r.method} ${pathOf(r.url)}`),
      ...(error ? { error } : {}),
      timing: { runMs: tRun1 - t0, observeMs: tObs1 - tRun1, totalMs: Date.now() - t0, quiet, max },
    };
  }

  /** The newest JSON body whose URL path contains `urlPart`, scoped to an act and/or a method; waits up to 1 s; throws on none or ≥ 400. */
  async json<T = unknown>(urlPart: string, o: { action?: string; method?: string } = {}): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.#ring.findLast((r) => r.done && r.body != null && pathOf(r.url).includes(urlPart) && (!o.action || r.action === o.action) && (!o.method || r.method === o.method));
      if (hit) {
        if ((hit.status ?? 0) >= 400) throw new Error(`json("${urlPart}"): the newest match answered ${hit.status}`);
        const text = this.#blobs.get(hit.body!) ?? "";
        try { return JSON.parse(text) as T; } catch { throw new Error(`json("${urlPart}"): the newest match is not JSON (${hit.mime ?? "no content-type"}); read it with body("${hit.body!.slice(0, 16)}")`); }
      }
      if (Date.now() - t0 > 1000) throw new Error(`json("${urlPart}"): no body matched — what did answer: ${[...new Set(this.#ring.slice(-8).map((r) => `${r.method} ${pathOf(r.url)}`))].join(", ") || "nothing"}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** A response body by hash or 16-char prefix (the `body` on a wire row) — the last 500 textual responses of this session. */
  body(hash: string): string {
    const key = [...this.#blobs.keys()].find((k) => k === hash || k.startsWith(hash));
    if (!key) throw new Error(`body("${hash}"): not among this session's responses (outside disco, only bodies of the last 500 requests are kept, in memory)`);
    return this.#blobs.get(key)!;
  }

  /** The next event that satisfies `pred`. */
  waitFor(kind: EventKind, pred: (e: any) => boolean, timeout?: number): Promise<any> {
    const t = timeout ?? 3000;
    if (kind === "response") return this.page.waitForResponse((r) => pred({ method: r.request().method(), url: r.url(), status: r.status() }), { timeout: t }).then((r) => ({ method: r.request().method(), url: r.url(), status: r.status() }));
    if (kind === "request") return this.page.waitForRequest((r) => pred({ method: r.method(), url: r.url() }), { timeout: t }).then((r) => ({ method: r.method(), url: r.url() }));
    if (kind === "nav") return this.page.waitForEvent("framenavigated", { predicate: (f) => f === this.page.mainFrame() && pred({ url: f.url() }), timeout: t }).then((f) => ({ url: f.url() }));
    if (kind === "console") return this.page.waitForEvent("console", { predicate: (m) => pred({ level: m.type(), text: m.text() }), timeout: t }).then((m) => ({ level: m.type(), text: m.text() }));
    if (kind === "dialog") return this.page.waitForEvent("dialog", { predicate: (d) => pred({ type: d.type(), message: d.message() }), timeout: t }).then((d) => ({ type: d.type(), message: d.message() }));
    if (kind === "page") return this.context.waitForEvent("page", { predicate: (p) => pred({ url: p.url() }), timeout: t }).then((p) => ({ url: p.url() }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#wsListeners.delete(cb); reject(new Error(`waitFor("ws"): no matching frame within ${t} ms`)); }, t);
      const cb = (e: { dir: "in" | "out"; payload: string; url: string }) => { if (pred(e)) { clearTimeout(timer); this.#wsListeners.delete(cb); resolve(e); } };
      this.#wsListeners.add(cb);
    });
  }

  /** With a selector or Locator: `count` and each match's visibility, enabledness and ARIA state — what an anchor assertion needs. Without one: the url and the accessibility tree. */
  async look(target?: string | Locator): Promise<any> {
    if (!target) return { url: this.page.url(), aria: await this.page.locator("body").ariaSnapshot().catch(() => ""), controls: [], dialogs: [] };
    const loc = typeof target === "string" ? this.page.locator(target) : target;
    const count = await loc.count(); const matches = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      const m = loc.nth(i);
      matches.push({ n: i + 1, visible: await m.isVisible().catch(() => false), enabled: await m.isEnabled().catch(() => true), state: await m.evaluate((el: any) => [["checked", el.checked ?? el.getAttribute("aria-checked")], ["selected", el.selected ?? el.getAttribute("aria-selected")], ["expanded", el.getAttribute("aria-expanded")], ["value", el.value]].filter(([, v]) => v != null && v !== false && v !== "false" && v !== "").map(([k, v]) => (v === true || v === "true" ? k : `${k}="${v}"`))).catch(() => []) });
    }
    return { count, matches };
  }

  sql(): never { throw new Error("sql reads disco's discovery log; outside disco a workflow reads the server through json or body"); }

  /** Disconnects; a browser this runtime launched is closed either way. */
  async close(_o: { browser?: boolean } = {}): Promise<void> { await this.browser.close().catch(() => {}); void this.#launched; }
}

/** Launch a Chromium (`DISCO_CHROMIUM`, a known path, or the one `npx playwright install chromium` put in place) or attach to a debugging port; pick the page at `url`. */
export async function open(_app: string, o: { url?: string; attach?: string | number; headed?: boolean } = {}): Promise<Session> {
  const endpoint = o.attach == null ? null : /^\d+$/.test(String(o.attach)) ? `http://127.0.0.1:${o.attach}` : String(o.attach);
  const exe = process.env.DISCO_CHROMIUM ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
  const browser = endpoint ? await chromium.connectOverCDP(endpoint) : await chromium.launch({ headless: !o.headed, ...(exe ? { executablePath: exe } : {}) });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const host = (() => { try { return o.url ? new URL(o.url).host : null; } catch { return null; } })();
  const page = context.pages().find((p) => host && p.url().includes(host)) ?? context.pages()[0] ?? (await context.newPage());
  if (o.url && !page.url().startsWith(o.url)) await page.goto(o.url);
  return new Session(browser, context, page, !endpoint);
}
