// act(): resolve → snapshot → dispatch → settle → report (GUIDANCE §4.1). Plus awaitSettlement and
// watch-with-diagnosis (GUIDANCE §5.1–5.2). Registered onto the daemon's RPC surface.
import type { Daemon, FrameInfo, TargetState } from "./daemon.ts";
import { Selectors, type Resolved } from "./selectors.ts";
import { Settler, type SettleResult, type SettleSignal } from "./settle.ts";
import { buildReport, diagnose, type Report } from "./report.ts";
import { clickAt, hoverAt, wheelAt, dragFromTo, pressKey, typeText, pointToRoot } from "./input.ts";
import { RpcError } from "./rpc.ts";
import { defaults } from "../defaults.ts";

/** Settler deadlines must run on the SAME clock as t0 and the fed event times: the session clock. */
const sessionClock = (d: Daemon) => ({ now: () => d.now(), setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (h: unknown) => clearTimeout(h as any) });

export interface ActParams {
  kind: "click" | "rightclick" | "dblclick" | "middleclick" | "hover" | "type" | "press" | "scroll" | "select" | "navigate" | "drag";
  target?: string; frame?: string; targetId?: string;
  text?: string; key?: string; url?: string; value?: string; deltaY?: number; to?: string; toOffset?: { dx: number; dy: number };
  budgetMs?: number; quietMs?: number; noEffectMs?: number; maxBudgetMs?: number;
  evaluateAfter?: string; evaluateAfterArg?: unknown; world?: "main" | "disco";
}

const POINTER: Record<string, { button: "left" | "right" | "middle"; clickCount: number }> = {
  click: { button: "left", clickCount: 1 }, rightclick: { button: "right", clickCount: 1 },
  dblclick: { button: "left", clickCount: 2 }, middleclick: { button: "middle", clickCount: 1 },
};
const NEEDS_TARGET = new Set(["click", "rightclick", "dblclick", "middleclick", "hover", "type", "select", "drag"]);
const TASK_EVENT: Record<string, string> = { click: "click", rightclick: "contextmenu", dblclick: "click", middleclick: "auxclick", type: "input", press: "keydown", select: "change", scroll: "wheel", drag: "mouseup" };

export function registerActions(d: Daemon): Selectors {
  const sel = new Selectors(d);
  d.register("act", (p) => act(d, sel, p as ActParams));
  d.register("settle", (p) => awaitSettlement(d, sel, p));
  d.register("watch", (p) => watch(d, sel, p));
  return sel;
}

/** Self-feedback suppression (DECISIONS #23): a small clicked element repainting itself (pressed state,
 *  focus ring) is expected affordance feedback, not an effect. Visual changes confined to the target box
 *  are dropped from the feed; big targets (canvases, panels) keep their in-element pixel signal. */
function feedFromEvent(d: Daemon, rootId: string, actionId: string, s: Settler, selfBox?: { x: number; y: number; w: number; h: number } | null) {
  const selfContained = (ev: any): boolean => {
    if (!selfBox) return false;
    const boxes = ev.summary?.boxes as Array<{ x: number; y: number; w: number; h: number }> | undefined;
    if (!boxes?.length) return false;
    const cast = d.targets.get(rootId)?.cast;
    const scale = cast && cast.viewW > 0 && cast.w > 0 ? cast.w / cast.viewW : 1;
    // Changed regions are TILE-aligned (32px grid in cast pixels), so the tolerance must cover a full
    // tile in CSS pixels on every edge, or a button hugging a tile boundary escapes its own box.
    const pad = defaults.selfFeedbackInflatePx + defaults.visualTilePx / scale;
    return boxes.every((b) => b.x / scale >= selfBox.x - pad && b.y / scale >= selfBox.y - pad && (b.x + b.w) / scale <= selfBox.x + selfBox.w + pad && (b.y + b.h) / scale <= selfBox.y + selfBox.h + pad);
  };
  return d.listen((ev) => {
    const tin = ev.targetId ? d.targets.get(ev.targetId)?.rootTargetId === rootId || ev.targetId === rootId : false;
    switch (ev.kind) {
      case "request": if (ev.actionId === actionId && (ev.summary as any)?.a !== "ambient") s.feed({ kind: "request-start", t: ev.t, id: String(ev.ref) }); break;
      case "response": if (ev.actionId === actionId) s.feed({ kind: "request-end", t: ev.t, id: String(ev.ref) }); break;
      case "mutation": if (tin && !(ev.summary as any)?.amb) s.feed({ kind: "mutation", t: ev.t }); break;
      case "visual": if (tin && !selfContained(ev)) s.feed({ kind: "visual", t: ev.t }); break;
      case "nav": if (tin && (ev.summary as any)?.kind === "navigated" && (ev.summary as any)?.main) s.feed({ kind: "navigated", t: ev.t, url: (ev.summary as any).url }); break;
      case "dialog": if (tin) s.feed({ kind: "dialog", t: ev.t }); break;
      case "target": if ((ev.summary as any)?.state === "attached" && (ev.summary as any)?.opener && d.targets.get((ev.summary as any).opener)?.rootTargetId === rootId) s.feed({ kind: "new-target", t: ev.t, targetId: ev.targetId }); break;
      case "download": if (tin) s.feed({ kind: "download", t: ev.t }); break;
    }
  });
}

async function snapshot(d: Daemon, sel: Selectors, frame: FrameInfo, root: TargetState, which: "pre" | "post") {
  const out: { shot?: string; aria?: string; url?: string; focused?: string | null; ariaText?: string } = {};
  try { out.shot = (await d.captureShot(root, which)).hash; } catch {}
  try {
    const aria = await sel.ariaSnapshot(frame);
    out.ariaText = aria;
    out.aria = d.store.writeBlob(aria);
  } catch {}
  try {
    const c = (await d.callInFrame(frame, "function(){ return window.__discoApi ? window.__discoApi.census() : null; }")).value as any;
    out.url = c?.url; out.focused = c?.focused;
  } catch { out.url = frame.url; }
  return out;
}

export async function act(d: Daemon, sel: Selectors, p: ActParams): Promise<Report> {
  const frame = d.resolveFrame(p.frame, p.targetId);
  const root = d.targets.get(d.targetOfFrame(frame).rootTargetId) ?? d.primary();
  const n = d.store.nextActionN();
  const actionId = `act:${n}`;
  const seqStart = d.store.lastSeq() + 1;
  const spec = { ...p, evaluateAfter: p.evaluateAfter ? "(fn)" : undefined };

  // ---- resolve now; fail with a diagnosis, never wait (GUIDANCE §2.2) ----
  let resolved: Resolved | null = null;
  let detachedRetried = false;
  let didScroll = false;
  let point: { x: number; y: number } | null = null;
  if (NEEDS_TARGET.has(p.kind)) {
    if (!p.target) throw new RpcError(-32602, `act ${p.kind} needs a target selector`);
    const r = await sel.resolve(frame, p.target);
    if (!("objectId" in r)) return failReport(d, { actionId, n, kind: p.kind, spec, frame, root, seqStart, diagnosis: await diagnose(d, frame, root, "not-found", { error: r.error, candidates: r.candidates }) });
    resolved = r;
    // hit-test with one re-resolve on detachment (GUIDANCE §8 re-render races)
    if (p.kind !== "type" && p.kind !== "select") {
      for (let attempt = 0; ; attempt++) {
        try {
          const hit = await sel.hitCheck(frame, p.target);
          if (!hit.ok) {
            if (hit.hit && attempt === 0 && /detach|gone/i.test(hit.hit)) throw new RpcError(-32013, "detached");
            return failReport(d, { actionId, n, kind: p.kind, spec, frame, root, seqStart, resolvedInfo: resolved, diagnosis: await diagnose(d, frame, root, "occluded", { occludedBy: hit.hit }) });
          }
          point = hit.point!;
          didScroll = !!hit.scrolled;
          break;
        } catch (e) {
          if (attempt >= 1) return failReport(d, { actionId, n, kind: p.kind, spec, frame, root, seqStart, diagnosis: await diagnose(d, frame, root, "detached", { error: (e as Error).message }) });
          detachedRetried = true;
          const rr = await sel.resolve(frame, p.target);
          if (!("objectId" in rr)) return failReport(d, { actionId, n, kind: p.kind, spec, frame, root, seqStart, diagnosis: await diagnose(d, frame, root, "detached", { error: "element disappeared between resolve and dispatch", candidates: rr.candidates }) });
          resolved = rr;
        }
      }
    }
  }

  // If resolution scrolled the target into view, the whole viewport repaints ~tens of ms later; absorb
  // that BEFORE opening the causality window so the scroll (pre-action adjustment) is not an "effect".
  if (didScroll) await absorbVisual(d, root, 800);
  const pre = await snapshot(d, sel, frame, root, "pre");
  try { await d.callInFrame(frame, "function(t){ return window.__discoApi ? window.__discoApi.armTask(t) : 0; }", [TASK_EVENT[p.kind] ?? "click"]); } catch {}
  const t0 = d.now();

  let selfBox: { x: number; y: number; w: number; h: number } | null = null;
  if (resolved?.box && POINTER[p.kind] && resolved.box.w * resolved.box.h <= defaults.selfFeedbackMaxArea && point) {
    const { point: rp } = await pointToRoot(d, frame, point);
    const dx = rp.x - point.x, dy = rp.y - point.y;
    selfBox = { x: resolved.box.x + dx, y: resolved.box.y + dy, w: resolved.box.w, h: resolved.box.h };
  }
  const settler = new Settler({ t0, quietMs: p.quietMs, noEffectMs: p.noEffectMs, budgetMs: p.budgetMs, maxBudgetMs: p.maxBudgetMs }, sessionClock(d));
  const unsub = feedFromEvent(d, root.rootTargetId, actionId, settler, selfBox); // subscribed BEFORE the window opens (review F10)

  // ---- causality window opens at dispatch (GUIDANCE §4.1) ----
  
  d.openWindow(root.rootTargetId, actionId, t0);
  d.store.insert("actions", { id: actionId, n, t_start: t0, target_id: root.targetId, frame_id: frame.frameId, kind: p.kind, spec: JSON.stringify(spec), resolved: resolved ? JSON.stringify({ selector: p.target, preview: resolved.preview, generated: resolved.generated, count: resolved.count }) : null, pre_shot: pre.shot ?? null, pre_aria: pre.aria ?? null });
  d.publish({ kind: "action", t: t0, targetId: root.targetId, actionId, summary: { kind: p.kind, target: p.target ?? p.url ?? p.key, state: "dispatch" } });

  // ---- dispatch ----
  try {
    if (POINTER[p.kind]) {
      const { point: rp, root: rt } = await pointToRoot(d, frame, point!);
      await clickAt(d, rt, rp, POINTER[p.kind]);
    } else if (p.kind === "hover") {
      const { point: rp, root: rt } = await pointToRoot(d, frame, point!);
      await hoverAt(d, rt, rp);
    } else if (p.kind === "drag") {
      if (!p.to && !p.toOffset) throw new RpcError(-32602, "drag needs `to` (selector) or `toOffset` ({dx,dy})");
      let toPoint: { x: number; y: number };
      if (p.to) { const hit = await sel.hitCheck(frame, p.to); if (!hit.point) throw new RpcError(-32602, `drag target ${p.to} not resolvable`); toPoint = hit.point; }
      else toPoint = { x: point!.x + p.toOffset!.dx, y: point!.y + p.toOffset!.dy };
      const [{ point: fromRp, root: rt }, { point: toRp }] = [await pointToRoot(d, frame, point!), await pointToRoot(d, frame, toPoint)];
      await dragFromTo(d, rt, fromRp, toRp);
    } else if (p.kind === "type") {
      const t = d.targetOfFrame(frame);
      await d.send(t, "DOM.focus", { objectId: resolved!.objectId }).catch(async () => { await sel.hitCheck(frame, p.target!); const { point: rp, root: rt } = await pointToRoot(d, frame, (await sel.hitCheck(frame, p.target!)).point!); await clickAt(d, rt, rp, { button: "left", clickCount: 1 }); });
      await typeText(d, root, p.text ?? "");
    } else if (p.kind === "press") {
      await pressKey(d, root, p.key ?? "Enter");
    } else if (p.kind === "scroll") {
      const at = point ?? { x: 400, y: 300 };
      const { point: rp, root: rt } = await pointToRoot(d, frame, at);
      await wheelAt(d, rt, rp, p.deltaY ?? 400);
    } else if (p.kind === "select") {
      // Use the already-resolved element handle so role=/text=/shadow selectors work (review F14);
      // events dispatched from the isolated world cross into the page (shared DOM).
      const t = d.targetOfFrame(frame);
      const res = await d.send<{ result: any; exceptionDetails?: any }>(t, "Runtime.callFunctionOn", { objectId: resolved!.objectId, functionDeclaration: `function(value){ this.value = value; this.dispatchEvent(new Event("input", {bubbles:true})); this.dispatchEvent(new Event("change", {bubbles:true})); return this.value; }`, arguments: [{ value: p.value ?? "" }], returnByValue: true });
      if (res.exceptionDetails) throw new RpcError(-32010, `select failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    } else if (p.kind === "navigate") {
      await d.send(root, "Page.navigate", { url: p.url! });
    }
  } catch (e) {
    unsub(); settler.cancel(); d.closeWindow(root.rootTargetId);
    return failReport(d, { actionId, n, kind: p.kind, spec, frame, root, seqStart, diagnosis: await diagnose(d, frame, root, "error", { error: (e as Error).message }) });
  }

  const result = await settler.result;
  unsub();
  const stillActive = result.verdict === "still-active";
  if (!stillActive) d.closeWindow(root.rootTargetId); // still-active keeps the window open for awaitSettlement (GUIDANCE §5.1)
  else backgroundSettle(d, root.rootTargetId, actionId, t0); // review F3: eventually close it even if the agent never asks

  const postFrame = d.frames.get(frame.frameId) ?? frame; // frame may have navigated
  const post = await snapshot(d, sel, postFrame, root, "post");
  let evalResult: unknown;
  if (p.evaluateAfter) {
    try { evalResult = (await d.callInFrame(postFrame, p.evaluateAfter, [p.evaluateAfterArg ?? null], p.world ?? "main")).value; }
    catch (e) { evalResult = { error: (e as Error).message }; }
  }
  const report = buildReport(d, {
    actionId, kind: p.kind, spec, frame: postFrame, root, verdict: result.verdict, settle: result, t0, tEnd: result.tReported,
    resolved: resolved ? { selector: p.target, preview: resolved.preview, generated: resolved.generated, count: resolved.count, detachedRetried } : undefined,
    pre: { shot: pre.shot, aria: pre.aria, url: pre.url, focused: pre.focused }, post: { shot: post.shot, aria: post.aria, url: post.url, focused: post.focused },
    preAriaText: pre.ariaText, postAriaText: post.ariaText, evaluateAfter: evalResult, seqStart,
  });
  d.store.update("actions", { t_settled: result.tSettled, verdict: result.verdict, settle_ms: result.tSettled - t0, timeline: JSON.stringify(result.timeline), post_shot: post.shot ?? null, post_aria: post.aria ?? null, report: JSON.stringify(report), seq_start: seqStart, seq_end: report.cursor.to }, "id=?", [actionId]);
  d.publish({ kind: "settle", t: result.tReported, targetId: root.targetId, actionId, summary: { verdict: result.verdict, ms: Math.round(result.tSettled - t0), requests: result.counts.requests } });
  return report;
}

/** After still-active, keep watching in the background: close the window (and fix the action row) at
 *  eventual quiescence, so hours of later traffic are not misattributed (review F3). awaitSettlement
 *  and any new act() on the same root take over by closing/replacing the window. */
function backgroundSettle(d: Daemon, rootId: string, actionId: string, originalT0: number) {
  const bg = new Settler({ t0: d.now(), budgetMs: defaults.budgetMs, maxBudgetMs: defaults.maxBudgetMs }, sessionClock(d));
  bg.seed([...d.inflight.values()].filter((x) => x.actionId === actionId && x.attribution !== "ambient" && !x.stalled).map((x) => x.id));
  const unsub = d.listen((ev) => {
    if (d.windows.get(rootId)?.actionId !== actionId) { unsub(); bg.cancel(); return; } // superseded
    const tin = ev.targetId ? d.targets.get(ev.targetId)?.rootTargetId === rootId || ev.targetId === rootId : false;
    if (ev.kind === "request" && ev.actionId === actionId && (ev.summary as any)?.a !== "ambient") bg.feed({ kind: "request-start", t: ev.t, id: String(ev.ref) });
    else if (ev.kind === "response" && ev.actionId === actionId) bg.feed({ kind: "request-end", t: ev.t, id: String(ev.ref) });
    else if (ev.kind === "mutation" && tin && !(ev.summary as any)?.amb) bg.feed({ kind: "mutation", t: ev.t });
    else if (ev.kind === "visual" && tin) bg.feed({ kind: "visual", t: ev.t });
  });
  void bg.result.then((res) => {
    unsub();
    if (d.windows.get(rootId)?.actionId !== actionId) return;
    d.closeWindow(rootId);
    d.store.update("actions", { t_settled: res.tSettled, settle_ms: res.tSettled - originalT0, verdict: res.verdict === "still-active" ? "still-active" : "settled:late" }, "id=? AND verdict='still-active'", [actionId]);
    d.publish({ kind: "settle", t: res.tReported, targetId: rootId, actionId, summary: { verdict: res.verdict, background: true, ms: Math.round(res.tSettled - originalT0) } });
  });
}

async function absorbVisual(d: Daemon, root: TargetState, maxMs: number): Promise<void> {
  const t0 = d.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 60));
    const cast = root.cast;
    if (!cast || d.now() - t0 >= maxMs) return;
    // quiet = no decoded change recently AND no rate-capped frame still awaiting its deferred decode
    if (d.now() - cast.lastChangedT >= 180 && !cast.pending) return;
  }
}

function failReport(d: Daemon, i: { actionId: string; n: number; kind: string; spec: unknown; frame: FrameInfo; root: TargetState; seqStart: number; resolvedInfo?: Resolved; diagnosis: Report["diagnosis"] }): Report {
  const t0 = d.now();
  if (d.windows.get(i.root.rootTargetId)?.actionId === i.actionId) d.closeWindow(i.root.rootTargetId); // review F6: never destroy another action's open window
  const report = buildReport(d, { actionId: i.actionId, kind: i.kind, spec: i.spec as any, frame: i.frame, root: i.root, verdict: "diagnosis", t0, tEnd: t0, seqStart: i.seqStart, diagnosis: i.diagnosis });
  d.store.upsert("actions", { id: i.actionId, n: i.n, t_start: t0, target_id: i.root.targetId, frame_id: i.frame.frameId, kind: i.kind, spec: JSON.stringify(i.spec), verdict: "diagnosis", report: JSON.stringify(report), seq_start: i.seqStart, seq_end: report.cursor.to });
  d.publish({ kind: "action", t: t0, targetId: i.root.targetId, actionId: i.actionId, summary: { kind: i.kind, state: "diagnosis", reason: i.diagnosis?.reason } });
  return report;
}

/** awaitSettlement: extend a still-active action's window, or re-arm fresh (GUIDANCE §5.1). */
export async function awaitSettlement(d: Daemon, sel: Selectors, p: { action?: string; budgetMs?: number; frame?: string; targetId?: string }): Promise<Report> {
  const frame = d.resolveFrame(p.frame, p.targetId);
  const root = d.targets.get(d.targetOfFrame(frame).rootTargetId) ?? d.primary();
  const open = d.windows.get(root.rootTargetId);
  let actionId: string; let t0: number; let seed: string[] = []; let n: number; let seqStart: number; let kind = "settle"; let originalT0: number | null = null;
  if (open && (!p.action || open.actionId === p.action)) {
    actionId = open.actionId; t0 = d.now();
    seed = [...d.inflight.values()].filter((x) => x.actionId === actionId && x.attribution !== "ambient" && !x.stalled).map((x) => x.id);
    const row = d.store.get<any>("SELECT n, kind, seq_start, t_start FROM actions WHERE id=?", actionId);
    n = row?.n ?? d.store.nextActionN(); seqStart = row?.seq_start ?? d.store.lastSeq() + 1; kind = row?.kind ?? "settle";
    originalT0 = row?.t_start ?? null; // review F11: settlement profile stays relative to the ORIGINAL dispatch
  } else {
    n = d.store.nextActionN(); actionId = `act:${n}`; t0 = d.now(); seqStart = d.store.lastSeq() + 1;
    d.openWindow(root.rootTargetId, actionId, t0);
    d.store.insert("actions", { id: actionId, n, t_start: t0, target_id: root.targetId, frame_id: frame.frameId, kind: "settle", spec: JSON.stringify(p) });
  }
  const settler = new Settler({ t0, budgetMs: p.budgetMs ?? defaults.budgetMs }, sessionClock(d));
  settler.seed(seed);
  const unsub = feedFromEvent(d, root.rootTargetId, actionId, settler);
  const result = await settler.result;
  unsub();
  if (result.verdict !== "still-active") d.closeWindow(root.rootTargetId);
  const post = await snapshot(d, sel, frame, root, "post");
  const report = buildReport(d, { actionId, kind, spec: p as any, frame, root, verdict: result.verdict, settle: result, t0, tEnd: result.tReported, post: { shot: post.shot, aria: post.aria, url: post.url, focused: post.focused }, seqStart });
  if (originalT0 !== null) (report as any).extended = true;
  d.store.update("actions", { t_settled: result.tSettled, verdict: result.verdict, settle_ms: result.tSettled - (originalT0 ?? t0), timeline: JSON.stringify(result.timeline), post_shot: post.shot ?? null, post_aria: post.aria ?? null, report: JSON.stringify(report), seq_end: report.cursor.to }, "id=?", [actionId]);
  d.publish({ kind: "settle", t: result.tReported, targetId: root.targetId, actionId, summary: { verdict: result.verdict, ms: Math.round(result.tSettled - t0) } });
  return report;
}

/** watch(): event-driven predicate wait; diagnosis on expiry, never a bare timeout (GUIDANCE §5.2). */
export async function watch(d: Daemon, sel: Selectors, p: { selector?: string; fn?: string; urlLike?: string; budgetMs?: number; frame?: string; targetId?: string }): Promise<{ matched: boolean; elapsedMs: number; preview?: string; request?: string; diagnosis?: Report["diagnosis"] }> {
  const frame = d.resolveFrame(p.frame, p.targetId);
  const root = d.targets.get(d.targetOfFrame(frame).rootTargetId) ?? d.primary();
  const budget = p.budgetMs ?? defaults.watchBudgetMs;
  const t0 = d.now();
  if (!p.selector && !p.fn && !p.urlLike) throw new RpcError(-32602, "watch needs selector, fn, or urlLike");

  const check = async (): Promise<{ ok: boolean; preview?: string; request?: string }> => {
    if (p.urlLike) {
      const r = d.store.get<any>("SELECT id, url FROM requests WHERE url LIKE ? AND (t_start>=? OR t_end>=?) ORDER BY t_start DESC LIMIT 1", `%${p.urlLike}%`, t0 - 50, t0 - 50);
      if (r) return { ok: true, request: r.id };
    }
    if (p.selector) {
      const r = await sel.resolve(frame, p.selector).catch(() => null);
      if (r && "objectId" in r) return { ok: true, preview: r.preview };
    }
    if (p.fn) {
      const r = await d.callInFrame(frame, p.fn, [], "main").catch(() => ({ value: false }));
      if (r.value) return { ok: true, preview: JSON.stringify(r.value).slice(0, 120) };
    }
    return { ok: false };
  };

  const first = await check();
  if (first.ok) return { matched: true, elapsedMs: Math.round(d.now() - t0), ...first };
  return new Promise((resolve) => {
    let checking = false; let lastCheck = 0; let done = false;
    const finish = async (matched: boolean, extra: any = {}) => {
      if (done) return; done = true; unsub(); clearTimeout(timer); clearInterval(iv);
      if (matched) resolve({ matched: true, elapsedMs: Math.round(d.now() - t0), ...extra });
      else resolve({ matched: false, elapsedMs: Math.round(d.now() - t0), diagnosis: await diagnose(d, frame, root, "budget-expired", p.selector ? { candidates: await sel.candidates(frame, p.selector).catch(() => []) } : {}) });
    };
    const maybeCheck = async () => {
      if (checking || done || d.now() - lastCheck < 40) return;
      checking = true; lastCheck = d.now();
      try { const r = await check(); if (r.ok) await finish(true, r); } finally { checking = false; }
    };
    const unsub = d.listen((ev) => {
      const tin = ev.targetId ? d.targets.get(ev.targetId)?.rootTargetId === root.rootTargetId : false;
      if ((ev.kind === "mutation" && tin) || ev.kind === "response" || ev.kind === "request" || (ev.kind === "nav" && tin)) void maybeCheck();
    });
    const iv = setInterval(() => void maybeCheck(), 250); // safety net: covers non-mutating changes (e.g. canvas)
    const timer = setTimeout(() => void finish(false), budget);
  });
}

