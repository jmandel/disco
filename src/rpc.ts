// Daemon ⇄ client transport (BRIEF §1.3): unix socket, newline-delimited JSON-RPC 2.0, hand-rolled framing.
// Server pushes `{"jsonrpc":"2.0","method":"event","params":{...}}` notifications to subscribed connections.
import { defaults } from "../defaults.ts";

export interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params?: any }
export interface RpcNotification { jsonrpc: "2.0"; method: string; params?: any }
export class RpcError extends Error { constructor(public code: number, message: string, public data?: unknown) { super(message); } }

type Frame = (line: string) => void;
/** Accumulates bytes and yields complete newline-delimited lines. The decoder is streaming: a multi-byte
 *  UTF-8 sequence split across socket chunks must not become U+FFFD (exported for the unit test). */
export function framer(onLine: Frame) {
  let buf = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array | string) => {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

export interface RpcConn { id: number; send(obj: object): void; subscribed: boolean; close(): void }

/** Byte-accurate outgoing queue for a Bun socket. `write()` takes what the kernel buffer will hold and
 *  returns the byte count — ignoring it TRUNCATES anything larger (≈ tens of KB on a unix socket): the peer
 *  never sees the line's newline and the call "hangs" until its timeout (a ~500KB evaluate result did
 *  exactly that — DECISIONS #50). Flush the remainder on `drain`. */
class Outbox {
  private chunks: Uint8Array[] = [];
  private off = 0;
  private enc = new TextEncoder();
  push(sock: { write(d: Uint8Array): number }, line: string) { this.chunks.push(this.enc.encode(line)); this.flush(sock); }
  flush(sock: { write(d: Uint8Array): number }) {
    while (this.chunks.length) {
      const c = this.chunks[0];
      const n = sock.write(this.off ? c.subarray(this.off) : c);
      if (n < 0) return; // socket gone; close() will clean up
      this.off += n;
      if (this.off < c.length) return; // kernel buffer full — the rest goes out on drain
      this.chunks.shift(); this.off = 0;
    }
  }
}
export type RpcHandler = (method: string, params: any, conn: RpcConn) => Promise<unknown> | unknown;

/** Serve JSON-RPC on a unix socket. Returns a stop function. */
export function serveRpc(sockPath: string, handler: RpcHandler, opts: { onClose?: (c: RpcConn) => void } = {}) {
  const conns = new Set<RpcConn>();
  let nextConn = 1;
  const server = Bun.listen<{ conn: RpcConn; feed: (c: Uint8Array) => void; out: Outbox }>({
    unix: sockPath,
    socket: {
      open(sock) {
        const out = new Outbox();
        const conn: RpcConn = {
          id: nextConn++,
          subscribed: false,
          send(obj) { try { out.push(sock, JSON.stringify(obj) + "\n"); } catch {} },
          close() { try { sock.end(); } catch {} },
        };
        conns.add(conn);
        const feed = framer(async (line) => {
          let msg: RpcRequest;
          try { msg = JSON.parse(line); } catch { return conn.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
          try {
            const result = await handler(msg.method, msg.params ?? {}, conn);
            if (msg.id !== undefined) conn.send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
          } catch (e: any) {
            const err = e instanceof RpcError ? { code: e.code, message: e.message, data: e.data } : { code: -32000, message: String(e?.message ?? e), data: e?.stack };
            if (msg.id !== undefined) conn.send({ jsonrpc: "2.0", id: msg.id, error: err });
          }
        });
        sock.data = { conn, feed, out };
      },
      data(sock, chunk) { sock.data.feed(chunk); },
      drain(sock) { sock.data?.out.flush(sock); },
      close(sock) { const c = sock.data?.conn; if (c) { conns.delete(c); opts.onClose?.(c); } },
      error(sock, err) { console.error("rpc socket error", err); },
    },
  });
  return {
    conns,
    broadcast(params: any) { for (const c of conns) if (c.subscribed) c.send({ jsonrpc: "2.0", method: "event", params }); },
    stop() { for (const c of conns) c.close(); server.stop(true); },
  };
}

/** Client side: connect to the daemon socket; `call` awaits a response; `onEvent` receives notifications. */
export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private eventHandlers = new Set<(params: any) => void>();
  private sock!: Awaited<ReturnType<typeof Bun.connect>>;
  closed = false;
  private constructor(public sockPath: string) {}

  private out = new Outbox();
  static async connect(sockPath: string): Promise<RpcClient> {
    const c = new RpcClient(sockPath);
    const feed = framer((line) => c.onLine(line));
    c.sock = await Bun.connect({
      unix: sockPath,
      socket: {
        data(_s, chunk) { feed(chunk); },
        drain(s) { c.out.flush(s); },
        close() { c.onClose(); },
        error(_s, err) { c.onClose(err); },
        open() {},
      },
    });
    return c;
  }

  call<T = any>(method: string, params: any = {}, timeoutMs = defaults.rpcTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new Error("rpc closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc ${method}: no response within ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.out.push(this.sock, JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  onEvent(fn: (params: any) => void): () => void { this.eventHandlers.add(fn); return () => this.eventHandlers.delete(fn); }
  close() { if (!this.closed) { this.closed = true; try { this.sock.end(); } catch {} } }

  private onLine(line: string) {
    let msg: any; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id); if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data)); else p.resolve(msg.result);
    } else if (msg.method === "event") {
      for (const h of this.eventHandlers) { try { h(msg.params); } catch (e) { console.error("event handler error", e); } }
    }
  }
  private onClose(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err ?? new Error("rpc connection closed")); }
    this.pending.clear();
  }
}
