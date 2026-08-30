// Thin hand-rolled CDP client (BRIEF §1.2): connect, send with id, await response, dispatch events,
// flattened session routing. No protocol package; we type only what we use (see protocol.ts).
export interface CdpEvent { method: string; params: any; sessionId?: string }
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

export class CdpError extends Error {
  constructor(public method: string, public code: number, message: string, public data?: unknown) {
    super(`${method}: ${message}${data ? " " + JSON.stringify(data) : ""}`);
  }
}

export class Cdp {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Set<(e: CdpEvent) => void>();
  private closeHandlers = new Set<() => void>();
  closed = false;

  private constructor(private ws: WebSocket, public url: string) {
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => this.handleClose());
    ws.addEventListener("error", () => this.handleClose());
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws, url)), { once: true });
      ws.addEventListener("error", (e) => reject(new Error(`CDP connect failed: ${url} ${(e as any).message ?? ""}`)), { once: true });
    });
  }

  /** Send a CDP command; `sessionId` routes to an attached (flattened) target session. */
  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP closed (${method})`));
    const id = this.nextId++;
    const msg: any = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(fn: (e: CdpEvent) => void): () => void { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  onClose(fn: () => void): void { this.closeHandlers.add(fn); }

  /** Wait for one event matching `pred` (with a budget, so callers never hang). */
  once(pred: (e: CdpEvent) => boolean, budgetMs = 10000): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("CDP once(): budget expired")); }, budgetMs);
      const off = this.on((e) => { if (pred(e)) { clearTimeout(timer); off(); resolve(e); } });
    });
  }

  close(): void { if (!this.closed) { this.closed = true; try { this.ws.close(); } catch {} } }

  private onMessage(text: string) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const e: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      for (const h of this.handlers) { try { h(e); } catch (err) { console.error("cdp handler error", msg.method, err); } }
    }
  }

  private handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(`CDP connection closed (${p.method})`));
    this.pending.clear();
    for (const h of this.closeHandlers) { try { h(); } catch {} }
  }
}

/** Browser-endpoint discovery for attach mode: http://host:port/json/version → webSocketDebuggerUrl. */
export async function discoverBrowser(port: number, host = "127.0.0.1"): Promise<{ wsUrl: string; browser: string; userAgent: string }> {
  const res = await fetch(`http://${host}:${port}/json/version`);
  if (!res.ok) throw new Error(`GET /json/version → ${res.status}`);
  const j: any = await res.json();
  return { wsUrl: j.webSocketDebuggerUrl, browser: j.Browser, userAgent: j["User-Agent"] };
}

/** List page targets via the HTTP endpoint (used by `disco session new --pick`). */
export async function listPages(port: number, host = "127.0.0.1"): Promise<Array<{ id: string; url: string; title: string; type: string }>> {
  const res = await fetch(`http://${host}:${port}/json/list`);
  return (await res.json()) as any;
}
