// The daemon (GUIDANCE §3, BRIEF §1.16): owns the CDP connection, attaches scoped targets, installs
// always-on instrumentation, writes the store, serves the unix-socket RPC, streams events.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, discoverBrowser, type CdpEvent } from "./cdp.ts";
import { Store, type SessionManifest } from "./store.ts";
import { serveRpc, RpcError, type RpcConn } from "./rpc.ts";
import { Attributor, type WindowInfo, type FamilyState } from "./attribute.ts";
import { handleNetwork, type InflightRequest } from "./instrument/network.ts";
import { handlePage } from "./instrument/page.ts";
import { observerSource, BINDING, WORLD, type ObserverTaskMsg } from "./instrument/observer.ts";
import { fireSentinel } from "./sentinels.ts";
import { defaults } from "../defaults.ts";
import type { IgnoreMask, Box, TileSig } from "./visual.ts";
import type { AttachedToTarget, TargetInfo } from "./protocol.ts";
import { registerActions } from "./act.ts";
import { AmbientDom } from "./ambient-dom.ts";

export interface FrameInfo { frameId: string; targetId: string; parentFrameId: string | null; url: string; name?: string; contexts: Map<string, number>; observerReady: boolean }
export interface CastState { lastHash: string | null; lastSig: TileSig | null; lastChangedT: number; lastPersistT: number; lastDecodeT: number; lastBytes: Uint8Array | null; lastT: number; ignore: IgnoreMask; boxes: Box[]; frames: number; decoded: number; w: number; h: number; viewW: number; viewH: number; pending: { bytes: Uint8Array; hash: string; at: number } | null; decodeTimer: ReturnType<typeof setTimeout> | null }
export interface TargetState {
  targetId: string; sessionId: string; type: string; url: string; title: string;
  parentTargetId: string | null; openerId: string | null; rootTargetId: string;
  scoped: boolean; late: boolean; isPage: boolean; attachedT: number; mainFrameId: string | null;
  contexts: Map<number, { frameId: string | null; name: string; isDefault: boolean }>;
  cast: CastState | null; castVisible: boolean; detached: boolean;
}
export interface DaemonEvent { kind: string; t: number; targetId?: string; frameId?: string; actionId?: string | null; ref?: string | number | null; summary?: unknown; seq?: number }
export interface ActionWindow extends WindowInfo { taskSpans: Array<{ t0: number; t2: number }>; rootTargetId: string; bg?: () => void /* cancels the background settler that owns this still-active window */ }
export interface DaemonOptions {
  dir: string; name: string; product?: string; mode: "attach" | "launch"; port?: number; host?: string; wsUrl?: string; scope?: string; scopeTarget?: string; allTargets?: boolean;
  dialogPolicy?: "accept" | "dismiss"; contract?: unknown; launched?: SessionManifest["launched"]; log?: (line: string) => void;
}

export class Daemon {
  store!: Store;
  cdp!: Cdp;
  manifest!: SessionManifest;
  targets = new Map<string, TargetState>();
  bySession = new Map<string, TargetState>();
  frames = new Map<string, FrameInfo>();
  inflight = new Map<string, InflightRequest>();
  reqAlias = new Map<string, string>();
  redirectCount = new Map<string, number>();
  wsUrls = new Map<string, string>();
  windows = new Map<string, ActionWindow>(); // rootTargetId → open causality window
  lastClosed = new Map<string, { actionId: string; tClosed: number }>(); // for trailing attribution (friction #3)
  attrib!: Attributor;
  ambientDom = new AmbientDom();
  primaryTargetId: string | null = null;
  private listeners = new Set<(ev: DaemonEvent) => void>();
  private rpc!: ReturnType<typeof serveRpc>;
  private monoOffsetMs: number | null = null;
  private streamPath!: string;
  private logPath!: string;
  private scopeRe: RegExp | null = null;
  private scopeSub: string | null = null;
  scopeTargetId: string | null = null;
  private idleAccumMs = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private extraRpc = new Map<string, (params: any, conn: RpcConn) => Promise<unknown> | unknown>();
  private observerSrc = observerSource(defaults.observerBatchMs);
  connected = false;
  resumed = false;
  run = 1;

  static async start(opts: DaemonOptions): Promise<Daemon> {
    const d = new Daemon();
    mkdirSync(opts.dir, { recursive: true });
    d.logPath = join(opts.dir, "daemon.log");
    d.streamPath = join(opts.dir, "stream.jsonl");
    if (opts.log) d.extLog = opts.log;
    if (opts.scope) { const m = opts.scope.match(/^\/(.+)\/([a-z]*)$/); if (m) d.scopeRe = new RegExp(m[1], m[2]); else d.scopeSub = opts.scope; }
    d.scopeTargetId = opts.scopeTarget ?? null;
    // GUIDANCE §3.2: recording an unscoped desktop browser is never the default (review F2).
    if ((opts.mode ?? "attach") === "attach" && !opts.scope && !opts.scopeTarget && !opts.allTargets && !opts.launched) throw new Error("attach mode requires --scope <url-part> or --pick <target> (or explicit --all-targets)");
    // The store is the product's whole history; begin a new run (or resume the last still-open one).
    d.store = new Store(opts.dir);
    const runInfo = d.store.beginOrResumeRun({ name: opts.name, mode: opts.mode, scope: opts.scope, contract: opts.contract, dialogPolicy: opts.dialogPolicy });
    d.run = runInfo.run; d.resumed = runInfo.resumed;
    d.manifest = { name: opts.name, dir: opts.dir, product: opts.product, run: runInfo.run, anchorEpochMs: runInfo.anchorEpochMs, startedWall: new Date(runInfo.anchorEpochMs).toISOString(), mode: opts.mode, scope: opts.scope, endpoint: { port: opts.port, wsUrl: opts.wsUrl }, dialogPolicy: opts.dialogPolicy ?? "accept", contract: opts.contract, pid: process.pid, launched: opts.launched };
    let wsUrl = opts.wsUrl;
    if (!wsUrl) {
      if (opts.port === undefined) throw new Error("attach mode needs --attach <port> (or wsUrl)");
      const disc = await discoverBrowser(opts.port, opts.host);
      wsUrl = disc.wsUrl; d.manifest.browser = disc.browser; d.store.setRunBrowser(disc.browser);
    }
    d.writeManifest();
    d.attrib = new Attributor({ now: () => d.now(), windowFor: (tid, t) => d.windowFor(tid, t), onFamily: (f) => d.persistFamily(f), startT: 0, idleObservedMs: () => d.idleObservedMs() });
    d.cdp = await Cdp.connect(wsUrl);
    d.connected = true;
    d.cdp.on((e) => d.route(e));
    d.cdp.onClose(() => { d.connected = false; d.log("CDP connection closed"); d.publish({ kind: "browser", t: d.now(), summary: { state: "disconnected" } }); });
    const sock = join(opts.dir, "daemon.sock");
    if (existsSync(sock)) unlinkSync(sock);
    d.rpc = serveRpc(sock, (m, p, c) => d.handleRpc(m, p, c));
    await d.cdp.send("Target.setDiscoverTargets", { discover: true });
    await d.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await d.cdp.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true }).catch(() => {});
    registerActions(d);
    d.idleTimer = setInterval(() => { if (d.windows.size === 0) d.idleAccumMs += 500; }, 500);
    d.log(`daemon started: session=${opts.name} mode=${opts.mode} scope=${opts.scope ?? "(all)"} ws=${wsUrl}`);
    d.publish({ kind: "session", t: d.now(), summary: { state: d.resumed ? "resumed" : "started", name: d.manifest.name, mode: d.manifest.mode, scope: d.manifest.scope ?? null } });
    return d;
  }

  private extLog: ((l: string) => void) | null = null;
  log(line: string) { const s = `${new Date().toISOString()} ${line}`; try { appendFileSync(this.logPath, s + "\n"); } catch {} this.extLog?.(s); }
  writeManifest() { writeFileSync(join(this.manifest.dir, "manifest.json"), JSON.stringify(this.manifest, null, 2)); }
  now(): number { return this.store.now(); }
  /** CDP MonotonicTime (seconds) → session clock, via the offset learned from (timestamp, wallTime) pairs. */
  monoToT(ts: number): number { return this.monoOffsetMs === null ? this.now() : this.store.fromEpochMs(ts * 1000 + this.monoOffsetMs); }
  learnClock(ts: number, wall: number) {
    if (!ts || !wall) return;
    const next = wall * 1000 - ts * 1000;
    // Learn once; re-learn only on a large step (suspend/resume, NTP jump) so per-request wall jitter
    // cannot slide network timestamps relative to the other channels (review F13).
    if (this.monoOffsetMs === null || Math.abs(next - this.monoOffsetMs) > 1500) this.monoOffsetMs = next;
  }
  send<T = any>(t: TargetState | null, method: string, params: object = {}): Promise<T> { return this.cdp.send<T>(method, params, t?.sessionId); }

  // ---------------- events ----------------
  publish(ev: DaemonEvent, opts: { store?: boolean; stream?: boolean } = {}): number | undefined {
    let seq: number | undefined;
    if (opts.store !== false) seq = this.store.event(ev.kind, { t: ev.t, target_id: ev.targetId ?? null, frame_id: ev.frameId ?? null, action_id: ev.actionId ?? null, ref: ev.ref ?? null, summary: ev.summary });
    ev.seq = seq;
    if (opts.stream !== false) {
      const line = JSON.stringify({ seq, t: Math.round(ev.t), kind: ev.kind, target: ev.targetId?.slice(0, 8), frame: ev.frameId?.slice(0, 8), action: ev.actionId ?? undefined, ref: ev.ref ?? undefined, ...(ev.summary && typeof ev.summary === "object" ? ev.summary : { summary: ev.summary }) });
      try { appendFileSync(this.streamPath, line + "\n"); } catch {}
      this.rpc?.broadcast(JSON.parse(line));
    }
    for (const fn of this.listeners) { try { fn(ev); } catch (e) { this.log(`listener error: ${(e as Error).message}`); } }
    return seq;
  }
  listen(fn: (ev: DaemonEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---------------- causality windows ----------------
  windowFor(targetId: string, t: number): ActionWindow | null {
    const root = this.targets.get(targetId)?.rootTargetId ?? targetId;
    const w = this.windows.get(root);
    return w && t >= w.tStart - 1 ? w : null;
  }
  openWindow(rootTargetId: string, actionId: string, tStart: number): ActionWindow {
    const w: ActionWindow = { actionId, tStart, targetId: rootTargetId, rootTargetId, taskSpans: [] };
    this.windows.set(rootTargetId, w); return w;
  }
  closeWindow(rootTargetId: string) {
    const w = this.windows.get(rootTargetId);
    if (w) this.lastClosed.set(rootTargetId, { actionId: w.actionId, tClosed: this.now() });
    this.windows.delete(rootTargetId);
  }
  onTaskMarker(t: TargetState, msg: ObserverTaskMsg) {
    const w = this.windows.get(t.rootTargetId); if (!w) return;
    const span = { t0: this.store.fromEpochMs(msg.t0), t2: this.store.fromEpochMs(msg.t2) };
    w.taskSpans.push(span);
    const rows = this.store.all<{ id: string }>("SELECT id FROM requests WHERE action_id=? AND attribution='window' AND t_start BETWEEN ? AND ?", w.actionId, span.t0 - 2, span.t2 + defaults.taskTierSlackMs);
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      this.store.run(`UPDATE requests SET attribution='task' WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
      this.attrib.reattributeTask(ids);
      for (const id of ids) { const inf = this.inflight.get(id); if (inf) inf.attribution = "task"; }
    }
    this.publish({ kind: "task", t: span.t0, targetId: t.targetId, actionId: w.actionId, summary: { type: msg.type, ms: Math.round(span.t2 - span.t0), upgraded: rows.length } }, { stream: false });
  }
  persistFamily(f: FamilyState) {
    this.store.upsert("families", { family: f.family, method: f.method, host: f.host, path_shape: f.pathShape, count: f.count, first_t: f.firstT, last_t: f.lastT, ambient: f.ambient ? 1 : 0, ambient_reason: f.ambientReason, evidence: JSON.stringify(f.evidence), write_kind: f.writeKind });
  }
  isAuthRedirect(url: string, t: TargetState): boolean { return /\/(login|signin|sign-in|auth|sso|logout|session-expired|timeout)\b/i.test(url) && !/\/(login|signin|sign-in|auth|sso)\b/i.test(t.url || ""); }

  // ---------------- targets ----------------
  private matchesScope(url: string, targetId?: string): boolean {
    if (this.scopeTargetId) return targetId === this.scopeTargetId; // children/popups still adopt via opener logic
    if (!this.scopeRe && !this.scopeSub) return true; // launch mode / explicit --all-targets
    if (!url || url === "about:blank") return false;
    return this.scopeRe ? this.scopeRe.test(url) : url.includes(this.scopeSub!);
  }
  /** Observed idle time: ms with no causality window open anywhere (review F8). */
  idleObservedMs(): number { return this.idleAccumMs; }
  /** Target ids in a root tree (review F15). */
  treeIds(rootId: string): string[] { return [...this.targets.keys()].filter((id) => this.targets.get(id)!.rootTargetId === rootId || id === rootId); }
  /** Bound the write-path maps (review F12): insertion-ordered eviction. */
  capMap(m: Map<string, unknown>, cap = 8000) { while (m.size > cap) { const k = m.keys().next().value; if (k === undefined) break; m.delete(k); } }
  private route(e: CdpEvent) {
    if (this.stopping || this.store.closed) return;
    if (e.method.startsWith("Target.")) { void this.onTargetEvent(e); return; }
    if (e.method.startsWith("Browser.")) { this.onBrowserEvent(e); return; }
    const t = e.sessionId ? this.bySession.get(e.sessionId) : undefined;
    if (!t || t.detached) return;
    try { handleNetwork(this, t, e); handlePage(this, t, e); } catch (err) { this.log(`handler error ${e.method}: ${(err as Error).stack}`); }
  }
  private onBrowserEvent(e: CdpEvent) {
    const p = e.params;
    if (e.method === "Browser.downloadWillBegin") {
      const at = this.now();
      const seq = this.store.insert("downloads", { t: at, target_id: this.frames.get(p.frameId)?.targetId ?? null, guid: p.guid, url: p.url, filename: p.suggestedFilename, state: "begin" });
      this.publish({ kind: "download", t: at, targetId: this.frames.get(p.frameId)?.targetId, ref: seq, summary: { url: p.url, filename: p.suggestedFilename, state: "begin" } });
    } else if (e.method === "Browser.downloadProgress" && p.state !== "inProgress") {
      const at = this.now();
      this.store.insert("downloads", { t: at, target_id: null, guid: p.guid, url: null, filename: null, state: p.state });
      this.publish({ kind: "download", t: at, summary: { guid: p.guid, state: p.state } });
    }
  }
  private async onTargetEvent(e: CdpEvent) {
    const p = e.params;
    switch (e.method) {
      case "Target.attachedToTarget": return this.onAttached(p as AttachedToTarget, e.sessionId);
      case "Target.detachedFromTarget": { const t = this.bySession.get(p.sessionId); if (t) { t.detached = true; this.bySession.delete(p.sessionId); } return; }
      case "Target.targetInfoChanged": {
        const info = p.targetInfo as TargetInfo;
        const t = this.targets.get(info.targetId);
        if (t && t.scoped && !t.detached) {
          const changed = t.url !== info.url || t.title !== info.title; t.url = info.url; t.title = info.title;
          if (changed) this.store.update("targets", { url: info.url, title: info.title }, "target_id=?", [t.targetId]);
        } else if (info.type === "page" && !info.attached && !this.stopping && this.matchesScope(info.url, info.targetId)) {
          // A page we previously ignored (or never saw attached) now matches the scope: adopt it late.
          // Auto-attach handles brand-new targets; `info.attached` guards against attaching a second session.
          this.log(`adopting target ${info.targetId} (${info.url})`);
          await this.cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true }).catch((err) => this.log(`adopt failed: ${err.message}`));
        }
        return;
      }
      case "Target.targetDestroyed": {
        const t = this.targets.get(p.targetId);
        if (t && !t.detached) { t.detached = true; this.bySession.delete(t.sessionId); }
        for (const [fid, fr] of this.frames) if (fr.targetId === p.targetId) this.frames.delete(fid); // review F12
        if (t?.scoped) { const at = this.now(); this.store.update("targets", { detached_t: at }, "target_id=?", [p.targetId]); this.publish({ kind: "target", t: at, targetId: p.targetId, summary: { state: "destroyed", url: t.url } }); }
        return;
      }
      case "Target.targetCrashed": { const t = this.targets.get(p.targetId); if (t?.scoped) this.publish({ kind: "target", t: this.now(), targetId: p.targetId, summary: { state: "crashed", status: p.status } }); return; }
    }
  }
  private async onAttached(p: AttachedToTarget, parentSessionId?: string) {
    const info = p.targetInfo;
    const parent = parentSessionId ? this.bySession.get(parentSessionId) : undefined;
    const existing = this.targets.get(info.targetId);
    if (existing && existing.scoped && !existing.detached && existing.sessionId !== p.sessionId) {
      // Duplicate session for an already-instrumented target (race between auto-attach and adoption): drop it.
      await this.send({ ...existing, sessionId: p.sessionId } as TargetState, "Runtime.runIfWaitingForDebugger").catch(() => {});
      await this.cdp.send("Target.detachFromTarget", { sessionId: p.sessionId }).catch(() => {});
      return;
    }
    const late = !p.waitingForDebugger;
    const isPage = info.type === "page";
    const isFrame = info.type === "iframe";
    let scoped: boolean;
    if (isPage) scoped = this.matchesScope(info.url, info.targetId) || (!!info.openerId && !!this.targets.get(info.openerId)?.scoped);
    else if (isFrame) scoped = !!parent?.scoped;
    else scoped = false; // workers, service workers, etc.: run, but don't instrument (v1)
    const t: TargetState = {
      targetId: info.targetId, sessionId: p.sessionId, type: info.type, url: info.url, title: info.title,
      parentTargetId: parent?.targetId ?? null, openerId: info.openerId ?? null,
      rootTargetId: isFrame && parent ? parent.rootTargetId : info.targetId,
      scoped, late, isPage, attachedT: this.now(), mainFrameId: null, contexts: new Map(), cast: null, castVisible: true, detached: false,
    };
    this.targets.set(info.targetId, t);
    this.bySession.set(p.sessionId, t);
    if (!scoped) {
      await this.send(t, "Runtime.runIfWaitingForDebugger").catch(() => {});
      if (isPage || isFrame) { await this.cdp.send("Target.detachFromTarget", { sessionId: p.sessionId }).catch(() => {}); t.detached = true; this.bySession.delete(p.sessionId); }
      else await this.cdp.send("Target.detachFromTarget", { sessionId: p.sessionId }).catch(() => {});
      return;
    }
    try {
      await this.instrument(t, late);
    } catch (err) { this.log(`instrument failed for ${info.targetId}: ${(err as Error).message}`); }
    await this.send(t, "Runtime.runIfWaitingForDebugger").catch(() => {});
    const at = this.now();
    this.store.upsert("targets", { target_id: t.targetId, type: t.type, url: t.url, title: t.title, opener_id: t.openerId, parent_id: t.parentTargetId, scoped: 1, attached_t: t.attachedT, observed_from: at, late: late ? 1 : 0, detached_t: null });
    if (isPage && !this.primaryTargetId) this.primaryTargetId = t.targetId;
    this.publish({ kind: "target", t: at, targetId: t.targetId, summary: { state: existing ? "reattached" : "attached", type: t.type, url: t.url, late, opener: t.openerId, parent: t.parentTargetId } });
    if (isPage && !existing && t.openerId && this.targets.get(t.openerId)?.scoped) void fireSentinel(this, t, "new_target", { url: t.url, opener: t.openerId, type: t.type }, { shot: false });
  }

  /** BRIEF §1.16 order. Called before Runtime.runIfWaitingForDebugger. */
  private async instrument(t: TargetState, late: boolean) {
    await this.send(t, "Network.enable", { maxTotalBufferSize: defaults.networkBufferTotal, maxResourceBufferSize: defaults.networkBufferPerResource, maxPostDataSize: 1_000_000 });
    await this.send(t, "Page.enable");
    await this.send(t, "Page.setLifecycleEventsEnabled", { enabled: true });
    await this.send(t, "Runtime.enable");
    await this.send(t, "Log.enable").catch(() => {});
    await this.send(t, "Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
    await this.send(t, "Page.addScriptToEvaluateOnNewDocument", { source: this.observerSrc, worldName: WORLD, runImmediately: true }).catch(async () => {
      await this.send(t, "Page.addScriptToEvaluateOnNewDocument", { source: this.observerSrc, worldName: WORLD });
    });
    if (t.isPage) await this.send(t, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await this.send(t, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
    // frame tree (also installs the observer into already-existing documents — idempotent)
    try {
      const { frameTree } = await this.send<{ frameTree: any }>(t, "Page.getFrameTree");
      const walk = async (node: any, parentId: string | null) => {
        const f = node.frame;
        if (!parentId) { t.mainFrameId = f.id; t.url = f.url || t.url; }
        this.frames.set(f.id, { frameId: f.id, targetId: t.targetId, parentFrameId: parentId, url: f.url, name: f.name, contexts: new Map(), observerReady: false });
        this.store.upsert("frames", { frame_id: f.id, target_id: t.targetId, parent_frame_id: parentId, url: f.url, name: f.name ?? null, t: this.now() });
        if (late || f.url !== "about:blank") await this.ensureObserver(f.id, t).catch(() => {});
        for (const c of node.childFrames ?? []) await walk(c, f.id);
      };
      await walk(frameTree, null);
    } catch (err) { this.log(`getFrameTree failed: ${(err as Error).message}`); }
    if (t.isPage && t.rootTargetId === t.targetId) {
      await this.send(t, "Page.startScreencast", { ...defaults.screencast }).catch((err) => this.log(`screencast failed: ${err.message}`));
    }
  }

  /** Make sure the isolated-world observer is installed in a frame; returns its execution context id. */
  async ensureObserver(frameId: string, t?: TargetState): Promise<number> {
    const fr = this.frames.get(frameId);
    if (!fr) throw new RpcError(-32602, `unknown frame ${frameId}`);
    const target = t ?? this.targets.get(fr.targetId);
    if (!target) throw new RpcError(-32602, `frame ${frameId} has no target`);
    let ctx = fr.contexts.get(WORLD);
    if (ctx === undefined) {
      const r = await this.send<{ executionContextId: number }>(target, "Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: true });
      ctx = r.executionContextId;
      fr.contexts.set(WORLD, ctx);
      target.contexts.set(ctx, { frameId, name: WORLD, isDefault: false });
    }
    if (!fr.observerReady) {
      await this.send(target, "Runtime.evaluate", { expression: this.observerSrc, contextId: ctx, returnByValue: true });
      fr.observerReady = true;
    }
    return ctx;
  }

  // ---------------- frames & evaluation ----------------
  primary(): TargetState {
    const t = this.primaryTargetId ? this.targets.get(this.primaryTargetId) : undefined;
    if (t && !t.detached) return t;
    for (const x of this.targets.values()) if (x.scoped && x.isPage && !x.detached) { this.primaryTargetId = x.targetId; return x; }
    throw new RpcError(-32001, "no scoped page target is attached (is the browser showing a page matching the session scope?)");
  }
  /** Resolve a frame spec: undefined/"main" → primary target's main frame; a frame id; or a URL substring. */
  resolveFrame(spec?: string | null, targetId?: string | null): FrameInfo {
    const t = targetId ? this.targets.get(targetId) : this.primary();
    if (!t) throw new RpcError(-32602, `unknown target ${targetId}`);
    if (!spec || spec === "main") { const f = t.mainFrameId && this.frames.get(t.mainFrameId); if (f) return f; throw new RpcError(-32001, "main frame not known yet"); }
    const byId = this.frames.get(spec); if (byId) return byId;
    for (const f of this.frames.values()) if (f.url.includes(spec) && this.targets.get(f.targetId)?.rootTargetId === t.rootTargetId) return f;
    for (const f of this.frames.values()) if (f.name === spec) return f;
    throw new RpcError(-32602, `no frame matches "${spec}" (frames: ${[...this.frames.values()].map((f) => `${f.frameId.slice(0, 6)}:${f.url.slice(0, 40)}`).join(", ")})`);
  }
  targetOfFrame(f: FrameInfo): TargetState { const t = this.targets.get(f.targetId); if (!t) throw new RpcError(-32001, "frame's target is gone"); return t; }
  /** Run a stringified function in a frame (isolated world by default, or main). */
  async callInFrame<T = any>(frame: FrameInfo, fn: string, args: unknown[] = [], world: "disco" | "main" = "disco", opts: { returnByValue?: boolean; awaitPromise?: boolean } = {}): Promise<{ value?: T; objectId?: string }> {
    const t = this.targetOfFrame(frame);
    let ctx: number | undefined;
    if (world === "main") { ctx = frame.contexts.get("main"); if (ctx === undefined) { const r = await this.send<{ executionContextId: number }>(t, "Page.createIsolatedWorld", { frameId: frame.frameId, worldName: "", grantUniveralAccess: true }).catch(() => null); if (r) ctx = r.executionContextId; } }
    else ctx = await this.ensureObserver(frame.frameId, t);
    const res = await this.send<{ result: any; exceptionDetails?: any }>(t, "Runtime.callFunctionOn", {
      functionDeclaration: fn, arguments: args.map((a) => ({ value: a })), executionContextId: ctx, returnByValue: opts.returnByValue ?? true, awaitPromise: opts.awaitPromise ?? true, userGesture: false,
    });
    if (res.exceptionDetails) throw new RpcError(-32010, `in-page error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return opts.returnByValue === false ? { objectId: res.result.objectId } : { value: res.result.value };
  }

  /** Screenshot now: latest screencast frame if fresh, else Page.captureScreenshot. Persists a `shots` row. */
  async captureShot(t: TargetState, reason: string): Promise<{ hash: string; t: number; seq: number }> {
    const root = this.targets.get(t.rootTargetId) ?? t;
    const now = this.now();
    let bytes: Uint8Array | null = null, at = now, kind = "shot";
    // Reuse the last screencast frame when it is fresh OR nothing changed since it was pushed —
    // on a static page the last frame IS the current screen, and this keeps no-op reports fast.
    const c0 = root.cast;
    if (c0?.lastBytes && (now - c0.lastT < 400 || (root.castVisible && c0.lastChangedT <= c0.lastT))) { bytes = c0.lastBytes; at = c0.lastT; kind = "cast"; }
    else {
      const r = await this.send<{ data: string }>(root, "Page.captureScreenshot", { format: "jpeg", quality: 60 });
      bytes = new Uint8Array(Buffer.from(r.data, "base64")); at = this.now();
    }
    const hash = this.store.writeBlob(bytes);
    const dup = this.store.get<{ seq: number; t: number }>("SELECT seq, t FROM shots WHERE target_id=? AND hash=? ORDER BY seq DESC LIMIT 1", root.targetId, hash);
    if (dup) return { hash, t: dup.t, seq: dup.seq }; // static page: same frame re-captured — one row is enough
    const seq = this.store.insert("shots", { t: at, target_id: root.targetId, hash, w: root.cast?.w ?? null, h: root.cast?.h ?? null, kind, reason, changed_tiles: null });
    return { hash, t: at, seq };
  }

  // ---------------- RPC ----------------
  /** Slices 2+ register `act`, `settle`, `watch` here without touching this file's switch. */
  register(method: string, fn: (params: any, conn: RpcConn) => Promise<unknown> | unknown) { this.extraRpc.set(method, fn); }

  private async handleRpc(method: string, p: any, conn: RpcConn): Promise<unknown> {
    const ext = this.extraRpc.get(method);
    if (ext) return ext(p, conn);
    switch (method) {
      case "ping": return { pong: true, t: this.now() };
      case "session.info": return { manifest: this.manifest, resumed: this.resumed, run: this.run, connected: this.connected, targets: this.targetList(), counts: this.counts(), classifier: { immature: this.attrib.immature(), families: this.attrib.families.size, ambient: [...this.attrib.families.values()].filter((f) => f.ambient).length }, lastSeq: this.store.lastSeq() };
      case "session.end": this.store.endRun(); setTimeout(() => void this.stop(), 20); return { ok: true };
      case "pick.list": return (await this.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets")).targetInfos.filter((x) => x.type === "page").map((x, i) => ({ n: i + 1, targetId: x.targetId, url: x.url, title: x.title }));
      case "subscribe": conn.subscribed = true; return { ok: true, lastSeq: this.store.lastSeq() };
      case "targets": return this.targetList();
      case "focus": { const t = this.targets.get(p.targetId); if (!t?.scoped || t.detached) throw new RpcError(-32602, "unknown/unscoped target"); this.primaryTargetId = t.targetId; return { ok: true }; }
      case "note": {
        const at = this.now();
        const seq = this.store.insert("notes", { t: at, kind: p.kind ?? "note", action_id: p.action ?? p.action_id ?? null, name: p.name ?? null, text: p.text ?? null, data: p.data === undefined ? null : JSON.stringify(p.data) });
        this.publish({ kind: "note", t: at, actionId: p.action ?? null, ref: seq, summary: { kind: p.kind ?? "note", name: p.name, text: String(p.text ?? "").slice(0, 200) } }, { store: false });
        return { seq, t: at };
      }
      case "screenshot": { const t = p.targetId ? this.targets.get(p.targetId) : this.primary(); if (!t) throw new RpcError(-32602, "unknown target"); return this.captureShot(t, p.reason ?? "manual"); }
      case "evaluate": {
        const frame = this.resolveFrame(p.frame, p.targetId);
        const r = await this.callInFrame(frame, p.fn, p.args ?? [], p.world === "main" ? "main" : "disco");
        return { value: r.value, frame: frame.frameId, target: frame.targetId };
      }
      case "cdp.send": { const t = p.targetId ? this.targets.get(p.targetId) : p.browser ? null : this.primary(); return this.cdp.send(p.method, p.params ?? {}, t?.sessionId); }
      case "state.save": {
        const { cookies } = await this.cdp.send<{ cookies: unknown[] }>("Storage.getCookies", {});
        const origins: Array<{ origin: string; localStorage: Record<string, string> }> = [];
        const seen = new Set<string>();
        for (const t of this.targets.values()) {
          if (!t.scoped || !t.isPage || t.detached) continue;
          let origin: string; try { origin = new URL(t.url).origin; } catch { continue; }
          if (seen.has(origin)) continue; seen.add(origin);
          try {
            const fr = t.mainFrameId ? this.frames.get(t.mainFrameId) : null;
            if (!fr) continue;
            const r = await this.callInFrame(fr, "function(){ const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; }", [], "main");
            origins.push({ origin, localStorage: (r.value as Record<string, string>) ?? {} });
          } catch {}
        }
        return { cookies, origins, savedAt: new Date().toISOString() };
      }
      case "state.restore": {
        const st = p.state as { cookies?: unknown[]; origins?: Array<{ origin: string; localStorage: Record<string, string> }> };
        if (st.cookies?.length) await this.cdp.send("Storage.setCookies", { cookies: st.cookies });
        for (const o of st.origins ?? []) {
          if (!Object.keys(o.localStorage ?? {}).length) continue;
          try {
            const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url: o.origin });
            await new Promise((r) => setTimeout(r, 600));
            const t = this.targets.get(targetId);
            const fr = t?.mainFrameId ? this.frames.get(t.mainFrameId) : null;
            if (fr) await this.callInFrame(fr, "function(items){ for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v); return true; }", [o.localStorage], "main");
            await this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
          } catch (e) { this.log("state.restore origin failed: " + (e as Error).message); }
        }
        return { ok: true };
      }
      case "families": return [...this.attrib.families.values()].map((f) => ({ family: f.family, count: f.count, ambient: f.ambient, reason: f.ambientReason, writeKind: f.writeKind, evidence: f.evidence }));
      case "family.mark": { if (p.read !== undefined && p.read) this.attrib.markRead(p.family); if (p.ambient !== undefined) this.attrib.markAmbient(p.family, !!p.ambient); return { ok: true }; }
      case "idle": {
        const ms = Number(p.ms ?? defaults.idleObserveMs);
        const t0 = this.now();
        this.publish({ kind: "idle", t: t0, summary: { state: "begin", ms } }, { store: false });
        await new Promise((r) => setTimeout(r, ms));
        const fams = [...this.attrib.families.values()];
        this.publish({ kind: "idle", t: this.now(), summary: { state: "end", families: fams.length, ambient: fams.filter((f) => f.ambient).length } }, { store: false });
        return { ms, families: fams.map((f) => ({ family: f.family, count: f.count, ambient: f.ambient, reason: f.ambientReason })), immature: this.attrib.immature() };
      }
      default: throw new RpcError(-32601, `unknown method ${method}`);
    }
  }
  targetList() { return [...this.targets.values()].filter((t) => t.scoped && !t.detached).map((t) => ({ targetId: t.targetId, type: t.type, url: t.url, title: t.title, root: t.rootTargetId, primary: t.targetId === this.primaryTargetId, mainFrameId: t.mainFrameId, frames: [...this.frames.values()].filter((f) => f.targetId === t.targetId).map((f) => ({ frameId: f.frameId, url: f.url, parent: f.parentFrameId })) })); }
  counts() { const c: Record<string, number> = {}; for (const tbl of ["requests", "ws_frames", "console", "dialogs", "nav", "shots", "mutations", "sentinels", "actions", "notes", "sse_events"]) c[tbl] = this.store.get<{ n: number }>(`SELECT COUNT(*) n FROM ${tbl}`)?.n ?? 0; return c; }

  async stop(): Promise<void> {
    if (this.stopping) return; this.stopping = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.log("stopping");
    this.publish({ kind: "session", t: this.now(), summary: { state: "ending" } });
    if (this.connected) {
      for (const t of this.targets.values()) if (t.scoped && t.isPage && !t.detached && t.cast) await this.send(t, "Page.stopScreencast").catch(() => {});
      await this.cdp.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      for (const t of this.targets.values()) if (t.scoped && !t.detached) await this.cdp.send("Target.detachFromTarget", { sessionId: t.sessionId }).catch(() => {});
      this.cdp.close();
    }
    this.rpc.stop();
    try { unlinkSync(join(this.manifest.dir, "daemon.sock")); } catch {}
    this.manifest.endedWall = new Date().toISOString();
    this.writeManifest();
    this.store.close();
    if (this.manifest.launched?.pid) { try { process.kill(this.manifest.launched.pid, "SIGTERM"); } catch {} }
    this.log("stopped");
  }
}

// ---------------- run as a process: `bun src/daemon.ts --dir <sessionDir> --name <n> [--attach <port>] [--scope <s>] ...` ----------------
if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const has = (k: string) => args.includes(k);
  const dir = get("--dir"); const name = get("--name") ?? "session";
  if (!dir) { console.error("usage: bun src/daemon.ts --dir <sessionDir> --name <name> (--attach <port> | --ws <url>) [--scope <s>] [--dialogs accept|dismiss] [--launched-pid N]"); process.exit(2); }
  const port = get("--attach") ? Number(get("--attach")) : undefined;
  const launchedPid = get("--launched-pid");
  const d = await Daemon.start({
    dir, name, product: get("--product"), mode: (get("--mode") as any) ?? (launchedPid ? "launch" : "attach"), port, host: get("--host"), wsUrl: get("--ws"), scope: get("--scope"), scopeTarget: get("--scope-target"), allTargets: has("--all-targets"),
    dialogPolicy: (get("--dialogs") as any) ?? "accept",
    launched: launchedPid ? { pid: Number(launchedPid), userDataDir: get("--user-data-dir") ?? "", port: port ?? 0, headless: has("--headless") } : undefined,
    log: has("--fg") ? (l) => console.error(l) : undefined,
  });
  const bye = () => { void d.stop().then(() => process.exit(0)); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
  // `disco session end` calls stop() via RPC; exit once the socket is gone.
  const iv = setInterval(() => { if (!existsSync(join(dir, "daemon.sock"))) { clearInterval(iv); process.exit(0); } }, 500);
}
