// The recorder: Playwright context/page events and one CDP Network session per page → store rows and an
// in-process event stream. Passive: nothing in the page is touched. Every handler is guarded — a write
// that fails must never take the recorder down with it.
import type { BrowserContext, CDPSession, Page, Request, Response } from "playwright-core";
import { Store, REQ_BODY_CAP, WS_PAYLOAD_CAP } from "./store.ts";

export type DialogPolicy = "accept" | "dismiss";
/** How long after the headers a body may stay `pending`, with no bytes arriving, before it is marked missing (the page never read it). */
export const UNREAD_BODY_MS = 1500;

export type EventKind = "request" | "response" | "ws" | "console" | "dialog" | "page" | "nav";
export interface Events {
  request: { id: string; method: string; url: string; resourceType: string; t: number };
  response: { id: string; method: string; url: string; status: number; mime: string | null; t: number; response: Response };
  ws: { dir: "in" | "out"; payload: string; url: string; t: number };
  console: { level: string; text: string; t: number };
  dialog: { type: string; message: string; t: number };
  page: { url: string; page: Page; t: number };
  nav: { url: string; t: number };
}

export interface Recorder {
  /** Wait (bounded) for in-flight async writes — response headers and bodies — so a report sees them. */
  flush(maxMs: number): Promise<void>;
  detach(): void;
  /** Subscribe to the live stream (every page, including sockets opened before this session joined). Returns the unsubscribe. */
  on<K extends EventKind>(kind: K, cb: (e: Events[K]) => void): () => void;
  /** The log id of a Playwright Request. */
  idOf(r: Request): string | undefined;
  /** `store.now()` of the most recent event — network events only from hosts `relevant` accepts (so telemetry does not keep an act awake). */
  lastActivity(relevant?: (host: string | null) => boolean): number;
  /** Have response bytes for `url` arrived within the last `withinMs`? (Distinguishes "still downloading" from "never read".) */
  flowing(url: string, withinMs: number): boolean;
  /** A scratch page of ours (look's overlay): record nothing from it. */
  ignore(page: Page): void;
  /** Start (or stop) writing rows — a silent session takes over when the browser's recorder is gone. */
  setSilent(silent: boolean): void;
  /** Resolves once the initial listeners (including the CDP sessions of existing pages) are in place. */
  ready: Promise<void>;
}

const warned = new Set<string>();
function warn(where: string, e: unknown): void {
  const msg = `${where}: ${String((e as Error)?.message ?? e).split("\n")[0]}`;
  if (warned.has(msg)) return;
  warned.add(msg);
  process.stderr.write(`disco recorder: ${msg}\n`);
}

/** `silent`: handle dialogs and feed the event stream but write nothing — another process is recording this browser. */
export function attachRecorder(context: BrowserContext, store: Store, current: () => string | null, dialogs: DialogPolicy, opts: { silent?: boolean } = {}): Recorder {
  let silent = opts.silent === true;
  const ids = new WeakMap<Request, string>();
  let counter = store.get<{ n: number }>("SELECT COUNT(*) n FROM requests")?.n ?? 0;
  const pending = new Set<Promise<unknown>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const listeners: { [K in EventKind]: Set<(e: any) => void> } = { request: new Set(), response: new Set(), ws: new Set(), console: new Set(), dialog: new Set(), page: new Set(), nav: new Set() };
  const ignored = new WeakSet<Page>();
  const lastData = new Map<string, number>();
  let lastOther = store.now();
  const lastNet = new Map<string, number>();   // host → t of its last network event
  const netAt = (url: string) => { let h = ""; try { h = new URL(url).host; } catch {} lastNet.set(h, store.now()); };

  const track = (p: Promise<unknown>) => { pending.add(p); p.catch((e) => warn("async write", e)).finally(() => pending.delete(p)); };
  const emit = <K extends EventKind>(kind: K, e: Events[K]) => { if (kind === "request" || kind === "response") netAt((e as any).url); else lastOther = store.now(); for (const cb of listeners[kind]) { try { cb(e); } catch (err) { warn(`listener ${kind}`, err); } } };
  const guard = <A extends unknown[]>(where: string, fn: (...a: A) => unknown) => (...a: A) => { try { const r = fn(...a); if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch((e) => warn(where, e)); } catch (e) { warn(where, e); } };
  const idOf = (r: Request) => { let id = ids.get(r); if (!id) { id = `r${store.run}-${++counter}`; ids.set(r, id); } return id; };
  const cap = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? s.slice(0, n) : s);
  const hostPath = (url: string) => { try { const u = new URL(url); return { host: u.host, path: u.pathname }; } catch { return { host: null, path: null }; } };
  const scratch = (page: Page | null | undefined): boolean => { if (!page) return false; if (ignored.has(page)) return true; try { return page.url().startsWith("data:"); } catch { return false; } };
  const pageOf = (r: Request): Page | null => { try { return r.frame().page(); } catch { return null; } };
  const flowing = (url: string, withinMs: number) => store.now() - (lastData.get(url) ?? -Infinity) <= withinMs;

  const onRequest = guard("request", (r: Request) => {
    if (scratch(pageOf(r))) return;
    const id = idOf(r); const t = store.now();
    let frameUrl: string | null = null; try { frameUrl = r.frame().url(); } catch {}
    if (!silent) store.insert("requests", {
      id, t_start: t, method: r.method(), url: r.url(), ...hostPath(r.url()), resource_type: r.resourceType(), frame_url: frameUrl,
      req_headers: r.headers(), req_body: cap(r.postData(), REQ_BODY_CAP), body_state: "pending", action_id: current(),
    });
    emit("request", { id, method: r.method(), url: r.url(), resourceType: r.resourceType(), t });
  });
  // a body the page never reads never finishes and cannot be fetched; once no bytes have arrived for a while, stop calling it pending
  const armMissing = (id: string, url: string, wait = UNREAD_BODY_MS) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      const since = store.now() - (lastData.get(url) ?? -Infinity);
      if (since < UNREAD_BODY_MS) { armMissing(id, url, Math.max(50, UNREAD_BODY_MS - since)); return; }
      try { store.update("requests", { body_state: "missing", error: "body not read by the page" }, "id=? AND body_state='pending'", [id]); } catch (e) { warn("missing sweep", e); }
    }, wait);
    timers.add(timer);
  };
  const onResponse = guard("response", (res: Response) => {
    const req = res.request();
    if (scratch(pageOf(req))) return;
    const id = idOf(req); const t = store.now();
    const mime = res.headers()["content-type"] ?? null;
    const streaming = /event-stream/i.test(mime ?? "");
    if (!silent) {
      store.update("requests", { t_response: t, status: res.status(), mime, ...(streaming ? { body_state: "streaming" } : {}) }, "id=?", [id]);
      if (!streaming) armMissing(id, req.url());
      track(res.allHeaders().then((h) => store.update("requests", { resp_headers: h }, "id=?", [id])));
    }
    emit("response", { id, method: req.method(), url: req.url(), status: res.status(), mime, t, response: res });
  });
  const onFinished = guard("requestfinished", (r: Request) => {
    if (scratch(pageOf(r))) return;
    netAt(r.url());
    if (silent) return;
    const id = idOf(r);
    const tEnd = store.now();
    const rt = r.resourceType();
    if (rt === "websocket" || rt === "eventsource") { store.update("requests", { t_end: tEnd, body_state: "missing" }, "id=?", [id]); return; }
    track((async () => {
      const res = await r.response();
      if (!res) { store.update("requests", { t_end: tEnd, body_state: "missing" }, "id=?", [id]); return; }
      const mime = res.headers()["content-type"] ?? null;
      try {
        const buf = await Promise.race([res.body(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("body timeout")), 3000))]);
        const b = store.storeBody(new Uint8Array(buf), mime);
        store.update("requests", { t_end: tEnd, body_hash: b.hash, body_size: b.size, body_state: b.truncated ? "truncated" : "ok" }, "id=?", [id]);
      } catch (e) {
        store.update("requests", { t_end: tEnd, body_state: "missing", error: cap(String((e as Error).message), 200) }, "id=?", [id]);
      }
    })());
  });
  const onFailed = guard("requestfailed", (r: Request) => {
    if (scratch(pageOf(r))) return;
    netAt(r.url());
    if (!silent) store.update("requests", { t_end: store.now(), body_state: "error", error: r.failure()?.errorText ?? "failed" }, "id=?", [idOf(r)]);
  });

  const pageCleanups = new Map<Page, () => void>();
  const cdpSessions = new Set<CDPSession>();
  // One CDP Network session per page: WebSocket frames (Playwright's `websocket` event only reports sockets created
  // after the listener exists; a script joining a live page must still see frames) and body-byte progress.
  const watchSockets = async (page: Page) => {
    let cdp: CDPSession;
    try { cdp = await context.newCDPSession(page); await cdp.send("Network.enable"); } catch { return; }
    cdpSessions.add(cdp);
    const urls = new Map<string, string>();
    const urlOf = (id: string) => urls.get(id) ?? "(opened before recording)";
    const frame = (dir: "in" | "out", id: string, payload: string) => {
      if (scratch(page)) return;
      const f = { dir, payload: String(payload), url: urlOf(id), t: store.now() };
      if (!silent) store.insert("ws_frames", { t: f.t, url: f.url, dir, payload: cap(f.payload, WS_PAYLOAD_CAP), action_id: current() });
      emit("ws", f);
    };
    cdp.on("Network.webSocketCreated", guard("ws created", (e: any) => { urls.set(e.requestId, e.url); if (!silent && !scratch(page)) store.insert("ws_frames", { t: store.now(), url: e.url, dir: "open", action_id: current() }); }));
    cdp.on("Network.webSocketFrameReceived", guard("ws frame", (e: any) => frame("in", e.requestId, e.response?.payloadData ?? "")));
    cdp.on("Network.webSocketFrameSent", guard("ws frame", (e: any) => frame("out", e.requestId, e.response?.payloadData ?? "")));
    cdp.on("Network.webSocketClosed", guard("ws closed", (e: any) => { if (!silent && !scratch(page)) store.insert("ws_frames", { t: store.now(), url: urlOf(e.requestId), dir: "close", action_id: current() }); urls.delete(e.requestId); }));
    const resUrls = new Map<string, string>();
    cdp.on("Network.responseReceived", (e: any) => { resUrls.set(e.requestId, e.response?.url ?? ""); });
    cdp.on("Network.dataReceived", (e: any) => { const u = resUrls.get(e.requestId); if (u) { lastData.set(u, store.now()); netAt(u); } });
    // downloads: Playwright's `download` event needs a context it configured; CDP tells us regardless
    try { await cdp.send("Page.enable"); } catch {}
    cdp.on("Page.downloadWillBegin", guard("download", (e: any) => { if (scratch(page)) return; const name = e.suggestedFilename || e.url || "download"; if (!silent) store.insert("nav", { t: store.now(), kind: "download", url: name, action_id: current() }); lastOther = store.now(); }));
    cdp.on("Network.loadingFinished", (e: any) => { resUrls.delete(e.requestId); });
    cdp.on("Network.loadingFailed", (e: any) => { resUrls.delete(e.requestId); });
    page.once("close", () => { cdpSessions.delete(cdp); cdp.detach().catch(() => {}); });
  };
  const onPage = (page: Page) => {
    const handlers = {
      console: guard("console", (m: any) => { if (scratch(page)) return; const e = { level: m.type(), text: cap(m.text(), 2000) ?? "", t: store.now() }; if (!silent) store.insert("console", { t: e.t, level: e.level, text: e.text, url: m.location()?.url ?? null, action_id: current() }); emit("console", e); }),
      pageerror: guard("pageerror", (err: Error) => { if (scratch(page)) return; const e = { level: "exception", text: cap(String(err?.message ?? err), 2000) ?? "", t: store.now() }; if (!silent) store.insert("console", { t: e.t, level: e.level, text: e.text, action_id: current() }); emit("console", e); }),
      dialog: guard("dialog", (d: any) => {
        const e = { type: d.type(), message: cap(d.message(), 2000) ?? "", t: store.now() };
        if (!silent && !scratch(page)) store.insert("dialogs", { t: e.t, type: e.type, message: e.message, handled: dialogs, action_id: current() });
        (dialogs === "accept" ? d.accept() : d.dismiss()).catch(() => {});
        emit("dialog", e);
      }),
      framenavigated: guard("framenavigated", (f: any) => { if (f !== page.mainFrame() || scratch(page)) return; const e = { url: f.url(), t: store.now() }; if (!silent) store.insert("nav", { t: e.t, kind: "navigated", url: e.url, action_id: current() }); emit("nav", e); }),
      close: guard("close", () => { if (!silent && !scratch(page)) store.insert("nav", { t: store.now(), kind: "closed", url: safeUrl(page), action_id: current() }); }),
      download: guard("download", (d: any) => { void d; /* recorded from CDP Page.downloadWillBegin, which fires for attached browsers too */ }),
    };
    for (const [ev, fn] of Object.entries(handlers)) page.on(ev as any, fn as any);
    track(watchSockets(page));
    pageCleanups.set(page, () => { for (const [ev, fn] of Object.entries(handlers)) page.off(ev as any, fn as any); });
  };
  const onNewPage = guard("page", (page: Page) => {
    onPage(page);
    // a popup's URL is usually still about:blank when the event fires; decide once it commits (a data: URL is a scratch page of ours)
    track(page.waitForURL((u) => u.href !== "about:blank", { timeout: 3000, waitUntil: "commit" }).catch(() => {}).then(() => {
      if (scratch(page)) return;
      const e = { url: safeUrl(page) ?? "", page, t: store.now() };
      if (!silent) store.insert("nav", { t: e.t, kind: "popup", url: e.url, action_id: current() });
      emit("page", e);
    }));
  });

  context.on("request", onRequest); context.on("response", onResponse); context.on("requestfinished", onFinished); context.on("requestfailed", onFailed);
  const initial: Promise<unknown>[] = [];
  for (const p of context.pages()) { onPage(p); initial.push(...[...pending].slice(-1)); }
  context.on("page", onNewPage);

  return {
    ready: Promise.allSettled(initial).then(() => {}),
    async flush(maxMs) {
      if (!pending.size) return;
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, maxMs))]);
    },
    on: (kind, cb) => { listeners[kind].add(cb as any); return () => { listeners[kind].delete(cb as any); }; },
    idOf: (req) => ids.get(req),
    lastActivity: (relevant) => { let t = lastOther; for (const [h, at] of lastNet) if (!relevant || relevant(h || null)) t = Math.max(t, at); return t; },
    flowing,
    ignore: (page) => { ignored.add(page); },
    setSilent: (v) => { if (silent && !v) counter = store.get<{ n: number }>("SELECT COUNT(*) n FROM requests")?.n ?? counter; silent = v; },
    detach() {
      for (const c of cdpSessions) c.detach().catch(() => {});
      cdpSessions.clear();
      context.off("request", onRequest); context.off("response", onResponse); context.off("requestfinished", onFinished); context.off("requestfailed", onFailed);
      context.off("page", onNewPage);
      for (const c of pageCleanups.values()) c();
      for (const t of timers) clearTimeout(t);
    },
  };
}

function safeUrl(p: Page): string | null { try { return p.url(); } catch { return null; } }
