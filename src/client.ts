// The agent-facing library (GUIDANCE §3.1): a Bun process connects to the daemon over the unix socket;
// the store is opened in-process for reads (no daemon round trip). Anywhere a function is accepted it is
// stringified and runs IN PAGE — closures do not transfer (BRIEF §1.4); see README.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcClient } from "./rpc.ts";
import { openStore, type StoreReader } from "./store.ts";
import type { Report } from "./report.ts";
import type { ActParams } from "./act.ts";

export type PageFn = ((...args: any[]) => unknown) | string;
const src = (f: PageFn): string => (typeof f === "string" ? f : f.toString());

export interface ActOptions { frame?: string; targetId?: string; budgetMs?: number; quietMs?: number; noEffectMs?: number; maxBudgetMs?: number; evaluateAfter?: PageFn; evaluateAfterArg?: unknown; world?: "main" | "disco" }

export function resolveSessionDir(nameOrDir?: string): string {
  const sessionsDir = resolve(process.env.DISCO_SESSIONS_DIR ?? join(process.cwd(), "sessions"));
  const s = nameOrDir ?? process.env.DISCO_SESSION;
  if (s) {
    if (existsSync(join(s, "manifest.json"))) return resolve(s);
    const d = join(sessionsDir, s);
    if (existsSync(join(d, "manifest.json"))) return d;
    throw new Error(`no session "${s}" under ${sessionsDir}`);
  }
  const cur = join(sessionsDir, ".current");
  if (existsSync(cur)) { const d = join(sessionsDir, readFileSync(cur, "utf8").trim()); if (existsSync(join(d, "manifest.json"))) return d; }
  throw new Error(`no current session (run disco session new, or pass a name/dir, or set DISCO_SESSION)`);
}

export class Session {
  private _store: StoreReader | null = null;
  private constructor(public rpc: RpcClient, public dir: string) {}

  /** Connect to a running session's daemon. `nameOrDir` optional — defaults like the CLI. */
  static async connect(nameOrDir?: string): Promise<Session> {
    const dir = resolveSessionDir(nameOrDir);
    const sock = join(dir, "daemon.sock");
    if (!existsSync(sock)) throw new Error(`daemon not running for ${dir}; store-only reads still work via openStore(dir)`);
    return new Session(await RpcClient.connect(sock), dir);
  }

  /** Direct read-only store access, in-process (GUIDANCE §6.2). Works even after the daemon stops. */
  get store(): StoreReader { return (this._store ??= openStore(this.dir)); }

  act(p: Omit<ActParams, "evaluateAfter"> & { evaluateAfter?: PageFn }): Promise<Report> {
    const q: any = { ...p };
    if (q.evaluateAfter) q.evaluateAfter = src(q.evaluateAfter);
    return this.rpc.call("act", q, (p.maxBudgetMs ?? 30000) + 30000);
  }
  click(target: string, o: ActOptions = {}) { return this.act({ kind: "click", target, ...o }); }
  rightclick(target: string, o: ActOptions = {}) { return this.act({ kind: "rightclick", target, ...o }); }
  dblclick(target: string, o: ActOptions = {}) { return this.act({ kind: "dblclick", target, ...o }); }
  hover(target: string, o: ActOptions = {}) { return this.act({ kind: "hover", target, ...o }); }
  type(target: string, text: string, o: ActOptions = {}) { return this.act({ kind: "type", target, text, ...o }); }
  press(key: string, o: ActOptions = {}) { return this.act({ kind: "press", key, ...o }); }
  scroll(o: ActOptions & { target?: string; deltaY?: number } = {}) { return this.act({ kind: "scroll", ...o }); }
  select(target: string, value: string, o: ActOptions = {}) { return this.act({ kind: "select", target, value, ...o }); }
  navigate(url: string, o: ActOptions = {}) { return this.act({ kind: "navigate", url, ...o }); }
  drag(target: string, to: string | { dx: number; dy: number }, o: ActOptions = {}) {
    return this.act({ kind: "drag", target, ...(typeof to === "string" ? { to } : { toOffset: to }), ...o });
  }
  awaitSettlement(o: { action?: string; budgetMs?: number; frame?: string } = {}): Promise<Report> { return this.rpc.call("settle", o, (o.budgetMs ?? 30000) + 30000); }
  watch(pred: { selector?: string; fn?: PageFn; urlLike?: string }, o: { budgetMs?: number; frame?: string } = {}) {
    return this.rpc.call("watch", { ...pred, fn: pred.fn ? src(pred.fn) : undefined, ...o }, (o.budgetMs ?? 30000) + 30000);
  }
  /** Run a self-contained function in a frame. world "main" sees the page's globals; "disco" is our isolated world. */
  async evaluate<T = unknown>(fn: PageFn, o: { frame?: string; targetId?: string; args?: unknown[]; world?: "main" | "disco" } = {}): Promise<T> {
    const r = await this.rpc.call("evaluate", { fn: src(fn), frame: o.frame, targetId: o.targetId, args: o.args ?? [], world: o.world ?? "main" });
    return r.value as T;
  }
  note(text: string, o: { kind?: "state" | "transition" | "ledger" | "note"; name?: string; action?: string; data?: unknown } = {}) { return this.rpc.call("note", { text, ...o }); }
  cdp<T = any>(method: string, params: object = {}, o: { targetId?: string; browser?: boolean } = {}): Promise<T> { return this.rpc.call("cdp.send", { method, params, ...o }); }
  targets() { return this.rpc.call("targets"); }
  info() { return this.rpc.call("session.info"); }
  screenshot(o: { targetId?: string } = {}) { return this.rpc.call("screenshot", o); }
  families() { return this.rpc.call("families"); }
  idle(ms?: number) { return this.rpc.call("idle", { ms }, (ms ?? 30000) + 10000); }
  focusTarget(targetId: string) { return this.rpc.call("focus", { targetId }); }
  /** Subscribe to the live event stream (sentinels, settlements, notable requests). */
  onEvent(fn: (ev: any) => void): Promise<() => void> { const off = this.rpc.onEvent(fn); return this.rpc.call("subscribe").then(() => off); }
  end() { return this.rpc.call("session.end"); }
  close() { this.rpc.close(); this._store?.close(); }
}
export const connect = Session.connect;
export { openStore } from "./store.ts";
