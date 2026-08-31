// The agent-facing library (GUIDANCE §3.1): a Bun process connects to the daemon over the unix socket;
// the store is opened in-process for reads (no daemon round trip). Anywhere a function is accepted it is
// stringified and runs IN PAGE — closures do not transfer (BRIEF §1.4); see README.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RpcClient } from "./rpc.ts";
import { openStore, type StoreReader } from "./store.ts";
import type { Report } from "./report.ts";
import type { ActParams, UntilSpec, WatchPred } from "./act.ts";
import { defaults } from "../defaults.ts";

export type PageFn = ((...args: any[]) => unknown) | string;
const src = (f: PageFn): string => (typeof f === "string" ? f : f.toString());

/** `until` (GUIDANCE §9): the postcondition act() must reach before returning — a selector, an in-page
 *  predicate (stringified; pass data via `fnArg`), or a request URL fragment. The verdict still reports
 *  what the page did; `report.until` says whether the state arrived. Automation should always pass one. */
export interface PredOptions extends Omit<WatchPred, "fn" | "any" | "all"> { fn?: PageFn; any?: PredOptions[]; all?: PredOptions[] }
export interface UntilOptions extends PredOptions { budgetMs?: number; tailMs?: number; frame?: string }
/** Page functions travel as source (README "closures do not transfer"); combinator arms recurse. */
const stringifyPred = (p: any): any => ({ ...p, fn: p.fn ? src(p.fn) : undefined, any: p.any?.map(stringifyPred), all: p.all?.map(stringifyPred) });
export interface ActOptions { frame?: string; targetId?: string; budgetMs?: number; quietMs?: number; noEffectMs?: number; maxBudgetMs?: number; evaluateAfter?: PageFn; evaluateAfterArg?: unknown; world?: "main" | "disco"; until?: UntilOptions; expect?: (report: Report) => boolean }

/** Resolve a selector to a product's STORE dir (apps/<product>/store). Accepts a product name, a path, or the current app. */
/** Candidate `apps/` directories: $DISCO_APPS_DIR, then `apps/` in the cwd and every parent, then the same walk
 *  from the running script's directory — a helper script in a scratch dir still finds the repo's apps/
 *  (stranger #3 friction #2). */
function appsDirCandidates(): string[] {
  const out: string[] = [];
  if (process.env.DISCO_APPS_DIR) out.push(resolve(process.env.DISCO_APPS_DIR));
  const walk = (from: string) => { let d = resolve(from); for (let i = 0; i < 8; i++) { out.push(join(d, "apps")); const up = dirname(d); if (up === d) break; d = up; } };
  walk(process.cwd());
  if (process.argv[1]) walk(dirname(resolve(process.argv[1])));
  return [...new Set(out)];
}
export function resolveSessionDir(nameOrDir?: string): string {
  const hasStore = (d: string) => existsSync(join(d, "store.sqlite")) || existsSync(join(d, "manifest.json"));
  const candidates = appsDirCandidates();
  const s = nameOrDir ?? process.env.DISCO_APP ?? process.env.DISCO_SESSION;
  if (s) {
    if (hasStore(s)) return resolve(s);                                 // a path to a store dir
    if (hasStore(join(s, "store"))) return resolve(join(s, "store"));   // a path to a product home
    for (const appsDir of candidates) { const d = join(appsDir, s, "store"); if (hasStore(d)) return d; } // a product name
    throw new Error(`no app "${s}" with a store under any of: ${candidates.filter((c) => existsSync(c)).join(", ") || candidates[0]} — start one with \`disco session new ${s} …\`, pass the product home's path, or set DISCO_APPS_DIR to the repo's apps/`);
  }
  for (const appsDir of candidates) {
    const cur = join(appsDir, ".current");
    if (existsSync(cur)) { const d = join(appsDir, readFileSync(cur, "utf8").trim(), "store"); if (hasStore(d)) return d; }
  }
  throw new Error(`no current app (run disco session new <product>, pass a product/path, or set DISCO_APP / DISCO_APPS_DIR)`);
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

  /** `expect` (GUIDANCE §4.1) runs CLIENT-side over the returned report (no daemon-side functions,
   *  BRIEF §1.4): a false expectation does not change waiting — it marks the report surprising and
   *  drops a ledger note, feeding the variability ledger (§7.5). */
  async act(p: Omit<ActParams, "evaluateAfter" | "until"> & { evaluateAfter?: PageFn; until?: UntilOptions; expect?: (report: Report) => boolean }): Promise<Report & { surprise?: boolean }> {
    const { expect: expectation, ...rest } = p;
    const q: any = { ...rest };
    if (q.evaluateAfter) q.evaluateAfter = src(q.evaluateAfter);
    if (q.until) q.until = stringifyPred(q.until);
    const timeout = (p.maxBudgetMs ?? defaults.maxBudgetMs) + (p.until ? (p.until.budgetMs ?? defaults.untilBudgetMs) + (p.until.tailMs ?? defaults.untilTailMs) : 0) + 30000;
    const report: Report & { surprise?: boolean } = await this.rpc.call("act", q, timeout);
    if (expectation) {
      let ok = false; try { ok = !!expectation(report); } catch { ok = false; }
      if (!ok) {
        report.surprise = true;
        await this.note(`surprise: expectation failed for ${report.action} (${report.kind} ${(p as any).target ?? ""} → ${report.verdict})`, { kind: "ledger", action: report.action }).catch(() => {});
      }
    }
    return report;
  }
  click(target: string, o: ActOptions = {}) { return this.act({ kind: "click", target, ...o }); }
  rightclick(target: string, o: ActOptions = {}) { return this.act({ kind: "rightclick", target, ...o }); }
  dblclick(target: string, o: ActOptions = {}) { return this.act({ kind: "dblclick", target, ...o }); }
  hover(target: string, o: ActOptions = {}) { return this.act({ kind: "hover", target, ...o }); }
  type(target: string, text: string, o: ActOptions = {}) { return this.act({ kind: "type", target, text, ...o }); }
  /** Replace an input's value (select-all + type; "" clears) with real key events — use for form fields. */
  fill(target: string, text: string, o: ActOptions = {}) { return this.act({ kind: "fill", target, text, ...o }); }
  press(key: string, o: ActOptions = {}) { return this.act({ kind: "press", key, ...o }); }
  scroll(o: ActOptions & { target?: string; deltaY?: number } = {}) { return this.act({ kind: "scroll", ...o }); }
  select(target: string, value: string, o: ActOptions = {}) { return this.act({ kind: "select", target, value, ...o }); }
  navigate(url: string, o: ActOptions = {}) { return this.act({ kind: "navigate", url, ...o }); }
  drag(target: string, to: string | { dx: number; dy: number }, o: ActOptions = {}) {
    return this.act({ kind: "drag", target, ...(typeof to === "string" ? { to } : { toOffset: to }), ...o });
  }
  awaitSettlement(o: { action?: string; budgetMs?: number; frame?: string } = {}): Promise<Report> { return this.rpc.call("settle", o, (o.budgetMs ?? 30000) + 30000); }
  /** Alias of awaitSettlement — the CLI verb is `disco settle`. */
  settle(o: { action?: string; budgetMs?: number; frame?: string } = {}): Promise<Report> { return this.awaitSettlement(o); }
  watch(pred: PredOptions, o: { budgetMs?: number; frame?: string } = {}): Promise<import("./report.ts").UntilResult> {
    return this.rpc.call("watch", { ...stringifyPred(pred), ...o }, (o.budgetMs ?? 30000) + 30000);
  }
  /** Per-app overrides (DECISIONS #43) — persist in the app's store across runs. */
  rules() { return this.rpc.call("rules.list"); }
  /** Treat every request whose URL contains `urlSubstring` as ambient: out of attribution AND the settlement race (third-party telemetry, a bursty poll the classifier can't learn). */
  ignore(urlSubstring: string, note?: string) { return this.rpc.call("rules.add", { kind: "ambient", match: urlSubstring, note }); }
  /** Never treat requests whose URL contains `urlSubstring` as ambient (a burst-refetched read the classifier mis-learned). */
  attend(urlSubstring: string, note?: string) { return this.rpc.call("rules.add", { kind: "not-ambient", match: urlSubstring, note }); }
  /** Mute a sentinel: same name and every given field a substring of the firing (recorded with muted=1, never reported/streamed). */
  mute(name: "dialog" | "toast" | "error" | "session_expiry" | "new_target", m: { selector?: string; text?: string; url?: string } = {}, note?: string) { return this.rpc.call("rules.add", { kind: "mute-sentinel", name, ...m, note }); }
  unrule(id: number) { return this.rpc.call("rules.remove", { id }); }
  /** Run a self-contained function in a frame. world "main" sees the page's globals; "disco" is our isolated world. */
  async evaluate<T = unknown>(fn: PageFn, o: { frame?: string; targetId?: string; args?: unknown[]; world?: "main" | "disco" } = {}): Promise<T> {
    if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error(`evaluate(fn, options): the second argument is an options object — pass data as { args: [${JSON.stringify(o)}] } (positional: fn(a, b) ← args: [a, b])`);
    if (o.args !== undefined && !Array.isArray(o.args)) throw new Error("evaluate: `args` must be an ARRAY of positional arguments — fn(a, b) ← args: [a, b]");
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
export { openStore, openApp } from "./store.ts";
