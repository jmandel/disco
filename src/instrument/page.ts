// Page-level capture: console/exceptions, JS dialogs (policy-handled, always recorded), navigation and
// frame lifecycle, downloads, screencast → visual signal, and the in-page observer's binding messages.
import type { CdpEvent } from "../cdp.ts";
import type { Daemon, TargetState } from "../daemon.ts";
import type { JavascriptDialogOpening, ScreencastFrame, ExecutionContextDescription } from "../protocol.ts";
import { defaults } from "../../defaults.ts";
import { BINDING, WORLD, type ObserverMsg } from "./observer.ts";
import { tileSignature, diffTiles, tileBoxes, IgnoreMask } from "../visual.ts";
import { fireSentinel } from "../sentinels.ts";
import { short } from "./network.ts";

export function handlePage(d: Daemon, t: TargetState, e: CdpEvent): void {
  const p = e.params;
  switch (e.method) {
    // ---------------- console ----------------
    case "Runtime.consoleAPICalled": {
      const level = ({ log: "log", info: "info", warning: "warning", error: "error", debug: "log", trace: "log", assert: "error", dir: "log", table: "log" } as Record<string, string>)[p.type] ?? "log";
      const text = (p.args ?? []).map(previewArg).join(" ").slice(0, 2000);
      const at = d.monoToT(p.timestamp / 1000); // consoleAPICalled.timestamp is epoch ms
      const cf = p.stackTrace?.callFrames?.[0];
      recordConsole(d, t, { t: d.store.fromEpochMs(p.timestamp), level, text, url: cf?.url, line: cf?.lineNumber, stack: null });
      void at;
      return;
    }
    case "Runtime.exceptionThrown": {
      const ex = p.exceptionDetails;
      const text = (ex.exception?.description ?? ex.text ?? "exception").slice(0, 2000);
      const at = d.store.fromEpochMs(p.timestamp);
      recordConsole(d, t, { t: at, level: "exception", text, url: ex.url, line: ex.lineNumber, stack: ex.stackTrace ? JSON.stringify(ex.stackTrace.callFrames?.slice(0, 8)) : null });
      void fireSentinel(d, t, "error", { level: "exception", message: text.slice(0, 300), url: ex.url }, { t: at, shot: false });
      return;
    }
    case "Log.entryAdded": {
      const en = p.entry;
      if (en.source === "console-api") return; // already captured via Runtime
      const level = en.level === "verbose" ? "log" : en.level;
      recordConsole(d, t, { t: d.store.fromEpochMs(en.timestamp), level, text: `[${en.source}] ${String(en.text).slice(0, 2000)}`, url: en.url, line: en.lineNumber, stack: null });
      return;
    }
    // ---------------- dialogs ----------------
    case "Page.javascriptDialogOpening": {
      const dlg = p as JavascriptDialogOpening;
      const at = d.now();
      const accept = dlg.type === "beforeunload" ? true : d.manifest.dialogPolicy === "accept";
      d.send(t, "Page.handleJavaScriptDialog", { accept, promptText: dlg.type === "prompt" ? dlg.defaultPrompt ?? "" : undefined }).catch((err) => d.log(`handleJavaScriptDialog failed: ${err.message}`));
      const actionId = d.windowFor(t.targetId, at)?.actionId ?? null;
      const seq = d.store.insert("dialogs", { t: at, target_id: t.targetId, type: dlg.type, message: dlg.message, handled: accept ? "accept" : "dismiss", action_id: actionId });
      d.publish({ kind: "dialog", t: at, targetId: t.targetId, actionId, ref: seq, summary: { type: dlg.type, message: short(dlg.message, 160), handled: accept ? "accept" : "dismiss" } });
      return;
    }
    // ---------------- navigation & frames ----------------
    case "Page.frameNavigated": {
      const f = p.frame;
      const at = d.now();
      const isMain = !f.parentId || f.id === t.targetId; // OOPIF main frames carry a parentId but their frame id equals their target id
      d.frames.set(f.id, { frameId: f.id, targetId: t.targetId, parentFrameId: f.parentId ?? null, url: f.url, name: f.name, contexts: d.frames.get(f.id)?.contexts ?? new Map(), observerReady: false });
      d.store.upsert("frames", { frame_id: f.id, target_id: t.targetId, parent_frame_id: f.parentId ?? null, url: f.url, name: f.name ?? null, t: at });
      if (isMain) { t.mainFrameId = f.id; t.url = f.url; d.store.update("targets", { url: f.url }, "target_id=?", [t.targetId]); }
      const actionId = d.windowFor(t.targetId, at)?.actionId ?? null;
      const seq = d.store.insert("nav", { t: at, target_id: t.targetId, frame_id: f.id, kind: "navigated", url: f.url, action_id: actionId });
      d.publish({ kind: "nav", t: at, targetId: t.targetId, frameId: f.id, actionId, ref: seq, summary: { kind: "navigated", url: short(f.url), main: isMain } });
      if (isMain && t.isPage && d.isAuthRedirect(f.url, t)) void fireSentinel(d, t, "session_expiry", { type: "auth_redirect", url: short(f.url) }, { t: at });
      return;
    }
    case "Page.navigatedWithinDocument": {
      const at = d.now();
      const fr = d.frames.get(p.frameId); if (fr) fr.url = p.url;
      if (p.frameId === t.mainFrameId) t.url = p.url;
      const actionId = d.windowFor(t.targetId, at)?.actionId ?? null;
      const seq = d.store.insert("nav", { t: at, target_id: t.targetId, frame_id: p.frameId, kind: "same_document", url: p.url, action_id: actionId });
      d.publish({ kind: "nav", t: at, targetId: t.targetId, frameId: p.frameId, actionId, ref: seq, summary: { kind: "same_document", url: short(p.url) } });
      return;
    }
    case "Page.lifecycleEvent": {
      if (p.name !== "load" && p.name !== "DOMContentLoaded" && p.name !== "networkIdle") return;
      const at = d.monoToT(p.timestamp);
      const kind = p.name === "load" ? "load" : p.name === "DOMContentLoaded" ? "domcontentloaded" : "networkidle";
      const actionId = d.windowFor(t.targetId, at)?.actionId ?? null;
      const seq = d.store.insert("nav", { t: at, target_id: t.targetId, frame_id: p.frameId, kind, url: d.frames.get(p.frameId)?.url ?? null, action_id: actionId });
      d.publish({ kind: "nav", t: at, targetId: t.targetId, frameId: p.frameId, actionId, ref: seq, summary: { kind } }, { stream: kind === "load" });
      return;
    }
    case "Page.frameAttached": {
      const at = d.now();
      d.frames.set(p.frameId, { frameId: p.frameId, targetId: t.targetId, parentFrameId: p.parentFrameId ?? null, url: "", contexts: new Map(), observerReady: false });
      d.store.insert("nav", { t: at, target_id: t.targetId, frame_id: p.frameId, kind: "frame_attached", url: null, action_id: d.windowFor(t.targetId, at)?.actionId ?? null });
      return;
    }
    case "Page.frameDetached": {
      const at = d.now();
      if (p.reason !== "swap") d.frames.delete(p.frameId); // "swap" = became an OOPIF; the child target re-reports it
      d.store.insert("nav", { t: at, target_id: t.targetId, frame_id: p.frameId, kind: "frame_detached", url: null, action_id: d.windowFor(t.targetId, at)?.actionId ?? null });
      return;
    }
    case "Page.downloadWillBegin": {
      const at = d.now();
      const seq = d.store.insert("downloads", { t: at, target_id: t.targetId, guid: p.guid, url: p.url, filename: p.suggestedFilename, state: "begin" });
      d.publish({ kind: "download", t: at, targetId: t.targetId, ref: seq, summary: { url: short(p.url), filename: p.suggestedFilename, state: "begin" } });
      return;
    }
    case "Page.downloadProgress": {
      if (p.state === "inProgress") return;
      const at = d.now();
      d.store.insert("downloads", { t: at, target_id: t.targetId, guid: p.guid, url: null, filename: null, state: p.state });
      d.publish({ kind: "download", t: at, targetId: t.targetId, summary: { guid: p.guid, state: p.state } });
      return;
    }
    // ---------------- execution contexts & observer binding ----------------
    case "Runtime.executionContextCreated": {
      const c = p.context as ExecutionContextDescription;
      const frameId = c.auxData?.frameId;
      t.contexts.set(c.id, { frameId: frameId ?? null, name: c.name, isDefault: !!c.auxData?.isDefault });
      if (frameId) {
        let fr = d.frames.get(frameId);
        if (!fr) { fr = { frameId, targetId: t.targetId, parentFrameId: null, url: "", contexts: new Map(), observerReady: false }; d.frames.set(frameId, fr); }
        if (c.auxData?.isDefault) fr.contexts.set("main", c.id);
        else if (c.name === WORLD) fr.contexts.set(WORLD, c.id);
      }
      return;
    }
    case "Runtime.executionContextDestroyed": {
      const id = p.executionContextId ?? p.executionContextUniqueId;
      const info = t.contexts.get(id);
      t.contexts.delete(id);
      if (info?.frameId) { const fr = d.frames.get(info.frameId); if (fr) for (const [k, v] of fr.contexts) if (v === id) { fr.contexts.delete(k); if (k === WORLD) fr.observerReady = false; } }
      return;
    }
    case "Runtime.executionContextsCleared": {
      for (const [, info] of t.contexts) if (info.frameId) { const fr = d.frames.get(info.frameId); if (fr) { fr.contexts.clear(); fr.observerReady = false; } }
      t.contexts.clear();
      return;
    }
    case "Runtime.bindingCalled": {
      if (p.name !== BINDING) return;
      let msg: ObserverMsg; try { msg = JSON.parse(p.payload); } catch { return; }
      const frameId = t.contexts.get(p.executionContextId)?.frameId ?? t.mainFrameId;
      onObserverMsg(d, t, frameId, msg);
      return;
    }
    // ---------------- screencast ----------------
    case "Page.screencastFrame": { void onScreencastFrame(d, t, p as ScreencastFrame); return; }
    case "Page.screencastVisibilityChanged": { t.castVisible = !!p.visible; d.publish({ kind: "cast_visibility", t: d.now(), targetId: t.targetId, summary: { visible: !!p.visible } }, { store: false }); return; }
  }
}

function recordConsole(d: Daemon, t: TargetState, c: { t: number; level: string; text: string; url?: string; line?: number; stack: string | null }) {
  const actionId = d.windowFor(t.targetId, c.t)?.actionId ?? null;
  const seq = d.store.insert("console", { t: c.t, target_id: t.targetId, level: c.level, text: c.text, url: c.url ?? null, line: c.line ?? null, stack: c.stack, action_id: actionId });
  const notable = c.level === "error" || c.level === "warning" || c.level === "exception";
  d.publish({ kind: "console", t: c.t, targetId: t.targetId, actionId, ref: seq, summary: { level: c.level, text: short(c.text, 200) } }, { stream: notable });
}

function previewArg(a: any): string {
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  if (a.unserializableValue) return a.unserializableValue;
  if (a.preview?.properties) return `{${a.preview.properties.slice(0, 6).map((p: any) => `${p.name}: ${p.value ?? p.type}`).join(", ")}}`;
  return a.description ?? a.type ?? "";
}

function onObserverMsg(d: Daemon, t: TargetState, frameId: string | null, msg: ObserverMsg) {
  if (msg.kind === "ready") {
    if (frameId) { const fr = d.frames.get(frameId); if (fr) fr.observerReady = true; }
    d.publish({ kind: "observer", t: d.store.fromEpochMs(msg.t), targetId: t.targetId, frameId: frameId ?? undefined, summary: { url: short(msg.url) } }, { store: false, stream: false });
    return;
  }
  if (msg.kind === "task") { d.onTaskMarker(t, msg); return; }
  if (msg.kind === "mutation") {
    const at = d.store.fromEpochMs(msg.t);
    const actionId = d.windowFor(t.targetId, at)?.actionId ?? null;
    if (msg.count > 0) {
      const seq = d.store.insert("mutations", { t: at, target_id: t.targetId, frame_id: frameId, count: msg.count, added: msg.added, removed: msg.removed, attrs: msg.attrs, text: msg.text, roots: JSON.stringify(msg.roots), action_id: actionId });
      d.publish({ kind: "mutation", t: at, targetId: t.targetId, frameId: frameId ?? undefined, actionId, ref: seq, summary: { n: msg.count, add: msg.added, rm: msg.removed, roots: msg.roots.slice(0, 4) } }, { stream: false });
    }
    for (const c of msg.dialogs) void fireSentinel(d, t, c.kind === "expiry" ? "session_expiry" : "dialog", { title: c.title, text: c.text, role: c.role, sel: c.sel, area: c.area, key: c.key }, { frameId, t: at });
    for (const c of msg.toasts) void fireSentinel(d, t, "toast", { title: c.title, text: c.text, role: c.role, sel: c.sel, area: c.area, key: c.key }, { frameId, t: at });
    if (msg.gone.length) d.publish({ kind: "overlay_gone", t: at, targetId: t.targetId, frameId: frameId ?? undefined, actionId, summary: { keys: msg.gone } }, { store: false, stream: false });
  }
}

async function onScreencastFrame(d: Daemon, t: TargetState, p: ScreencastFrame) {
  d.send(t, "Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  const bytes = new Uint8Array(Buffer.from(p.data, "base64"));
  const at = p.metadata?.timestamp ? d.store.fromEpochMs(p.metadata.timestamp * 1000) : d.now();
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const c = t.cast ?? (t.cast = { lastHash: null, lastSig: null, lastChangedT: -1, lastPersistT: -1, lastDecodeT: -1, lastBytes: null, lastT: -1, ignore: new IgnoreMask(), boxes: [], frames: 0, decoded: 0, w: p.metadata?.deviceWidth ?? 0, h: p.metadata?.deviceHeight ?? 0 });
  c.frames++;
  c.lastT = at; c.lastBytes = bytes;
  if (hash === c.lastHash) return;
  c.lastHash = hash;
  const now = d.now();
  if (c.lastSig && now - c.lastDecodeT < defaults.visualDecodeMinGapMs) return; // rate-capped: skip; not counted as change
  c.lastDecodeT = now;
  let changedTiles = 0, boxes = c.boxes;
  try {
    const sig = tileSignature(bytes);
    c.decoded++;
    if (c.lastSig) {
      const idle = !d.windowFor(t.targetId, at);
      const { changed, all } = diffTiles(c.lastSig, sig, defaults.visualTileDelta, c.ignore.mask());
      if (idle) c.ignore.observe(all, sig.cols * sig.rows);
      changedTiles = changed.length;
      if (changedTiles > 0) { c.lastChangedT = at; boxes = c.boxes = tileBoxes(sig, changed); }
    } else { changedTiles = -1; c.lastChangedT = at; }
    c.lastSig = sig; c.w = sig.w; c.h = sig.h;
  } catch (e) { d.log(`frame decode failed: ${(e as Error).message}`); changedTiles = -1; c.lastChangedT = at; }
  if (changedTiles !== 0) {
    d.publish({ kind: "visual", t: at, targetId: t.targetId, summary: { tiles: changedTiles, boxes } }, { store: false, stream: false });
    if (at - c.lastPersistT >= defaults.screencastPersistMinGapMs || c.lastPersistT < 0) {
      c.lastPersistT = at;
      const h = d.store.writeBlob(bytes);
      d.store.insert("shots", { t: at, target_id: t.targetId, hash: h, w: c.w, h: c.h, kind: "cast", reason: "changed", changed_tiles: changedTiles });
    }
  }
}
