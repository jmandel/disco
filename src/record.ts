// The recorder: Playwright context/page events → store rows. Passive; nothing in the page is touched.
// Records while the Session is open (a script) or while a CLI command runs (`disco record` for longer).
import type { BrowserContext, Page, Request, Response, WebSocket } from "playwright-core";
import { Store, REQ_BODY_CAP, WS_PAYLOAD_CAP } from "./store.ts";

export type DialogPolicy = "accept" | "dismiss";
/** How long after the headers a body may stay `pending` before it is marked missing (the page never read it). */
export const UNREAD_BODY_MS = 1500;

export interface Recorder {
  /** Wait (bounded) for in-flight async writes — response headers and bodies — so a report sees them. */
  flush(maxMs: number): Promise<void>;
  detach(): void;
}

export function attachRecorder(context: BrowserContext, store: Store, current: () => string | null, dialogs: DialogPolicy): Recorder {
  const ids = new WeakMap<Request, string>();
  let counter = store.get<{ n: number }>("SELECT COUNT(*) n FROM requests")?.n ?? 0;
  const pending = new Set<Promise<unknown>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const track = (p: Promise<unknown>) => { pending.add(p); p.catch(() => {}).finally(() => pending.delete(p)); };
  const idOf = (r: Request) => { let id = ids.get(r); if (!id) { id = `r${store.run}-${++counter}`; ids.set(r, id); } return id; };
  const cap = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? s.slice(0, n) : s);
  const hostPath = (url: string) => { try { const u = new URL(url); return { host: u.host, path: u.pathname }; } catch { return { host: null, path: null }; } };

  const onRequest = (r: Request) => {
    const id = idOf(r);
    let frameUrl: string | null = null; try { frameUrl = r.frame().url(); } catch {}
    store.insert("requests", {
      id, t_start: store.now(), method: r.method(), url: r.url(), ...hostPath(r.url()), resource_type: r.resourceType(), frame_url: frameUrl,
      req_headers: r.headers(), req_body: cap(r.postData(), REQ_BODY_CAP), body_state: "pending", action_id: current(),
    });
  };
  const onResponse = (res: Response) => {
    const id = idOf(res.request());
    const mime = res.headers()["content-type"] ?? null;
    const streaming = /event-stream/i.test(mime ?? "");
    store.update("requests", { t_response: store.now(), status: res.status(), mime, ...(streaming ? { body_state: "streaming" } : {}) }, "id=?", [id]);
    // a body the page never reads never finishes and cannot be fetched; stop calling it pending
    if (!streaming) { const timer = setTimeout(() => { store.update("requests", { body_state: "missing", error: "body not read by the page" }, "id=? AND body_state='pending'", [id]); }, UNREAD_BODY_MS); timers.add(timer); }
    track(res.allHeaders().then((h) => store.update("requests", { resp_headers: h }, "id=?", [id])));
  };
  const onFinished = (r: Request) => {
    const id = idOf(r);
    const tEnd = store.now();
    const rt = r.resourceType();
    if (rt === "websocket" || rt === "eventsource") { store.update("requests", { t_end: tEnd, body_state: "missing" }, "id=?", [id]); return; }
    const p = (async () => {
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
    })();
    track(p);
  };
  const onFailed = (r: Request) => {
    store.update("requests", { t_end: store.now(), body_state: "error", error: r.failure()?.errorText ?? "failed" }, "id=?", [idOf(r)]);
  };

  const pageCleanups = new Map<Page, () => void>();
  const onPage = (page: Page) => {
    const handlers = {
      console: (m: any) => store.insert("console", { t: store.now(), level: m.type(), text: cap(m.text(), 2000), url: m.location()?.url ?? null, action_id: current() }),
      pageerror: (e: Error) => store.insert("console", { t: store.now(), level: "exception", text: cap(String(e?.message ?? e), 2000), action_id: current() }),
      dialog: (d: any) => {
        store.insert("dialogs", { t: store.now(), type: d.type(), message: cap(d.message(), 2000), handled: dialogs, action_id: current() });
        (dialogs === "accept" ? d.accept() : d.dismiss()).catch(() => {});
      },
      framenavigated: (f: any) => { if (f === page.mainFrame()) store.insert("nav", { t: store.now(), kind: "navigated", url: f.url(), action_id: current() }); },
      close: () => store.insert("nav", { t: store.now(), kind: "closed", url: safeUrl(page), action_id: current() }),
      download: (d: any) => store.insert("nav", { t: store.now(), kind: "download", url: d.suggestedFilename?.() ?? d.url?.(), action_id: current() }),
      websocket: (ws: WebSocket) => {
        const url = ws.url();
        store.insert("ws_frames", { t: store.now(), url, dir: "open", action_id: current() });
        ws.on("framesent", (f) => store.insert("ws_frames", { t: store.now(), url, dir: "out", payload: cap(String(f.payload), WS_PAYLOAD_CAP), action_id: current() }));
        ws.on("framereceived", (f) => store.insert("ws_frames", { t: store.now(), url, dir: "in", payload: cap(String(f.payload), WS_PAYLOAD_CAP), action_id: current() }));
        ws.on("close", () => store.insert("ws_frames", { t: store.now(), url, dir: "close", action_id: current() }));
      },
    };
    for (const [ev, fn] of Object.entries(handlers)) page.on(ev as any, fn as any);
    pageCleanups.set(page, () => { for (const [ev, fn] of Object.entries(handlers)) page.off(ev as any, fn as any); });
  };
  const onNewPage = (page: Page) => {
    const seq = store.insert("nav", { t: store.now(), kind: "popup", url: safeUrl(page), action_id: current() });
    // a popup's URL is usually still about:blank when the event fires; fill it in once it commits
    track(page.waitForURL((u) => u.href !== "about:blank", { timeout: 3000, waitUntil: "commit" }).then(() => store.update("nav", { url: safeUrl(page) }, "seq=?", [seq])));
    onPage(page);
  };

  context.on("request", onRequest); context.on("response", onResponse); context.on("requestfinished", onFinished); context.on("requestfailed", onFailed);
  for (const p of context.pages()) onPage(p);
  context.on("page", onNewPage);

  return {
    async flush(maxMs) {
      if (!pending.size) return;
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, maxMs))]);
    },
    detach() {
      context.off("request", onRequest); context.off("response", onResponse); context.off("requestfinished", onFinished); context.off("requestfailed", onFailed);
      context.off("page", onNewPage);
      for (const c of pageCleanups.values()) c();
      for (const t of timers) clearTimeout(t);
    },
  };
}

function safeUrl(p: Page): string | null { try { return p.url(); } catch { return null; } }
