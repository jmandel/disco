// act(): resolve → snapshot → dispatch → settle → report (GUIDANCE §4.1), with an optional `until`
// postcondition (the readiness contract, GUIDANCE §9). Plus awaitSettlement and watch-with-diagnosis
// (GUIDANCE §5.1–5.2). Registered onto the daemon's RPC surface.
import type { Daemon, DaemonEvent, FrameInfo, TargetState } from "./daemon.ts";
import { Selectors, type Resolved } from "./selectors.ts";
import { Settler, type SettleResult, type SettleSignal } from "./settle.ts";
import { buildReport, diagnose, type Diagnosis, type Report, type Timing, type UntilResult } from "./report.ts";
import { clickAt, hoverAt, wheelAt, dragFromTo, pressKey, typeText, pointToRoot } from "./input.ts";
import { RpcError } from "./rpc.ts";
import { KINDS, type ActKind } from "./kinds.ts";
import { defaults } from "../defaults.ts";

/** Settler deadlines must run on the SAME clock as t0 and the fed event times: the session clock. */
const sessionClock = (d: Daemon) => ({ now: () => d.now(), setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (h: unknown) => clearTimeout(h as any) });

/** A predicate over the page/wire: an element exists (`visible`: and is laid out with a box), an in-page
 *  function is truthy (called with `fnArg`), a request matching a URL fragment has started (`landed`: its
 *  response and body are captured). Shared by `watch()` and `act({until})`. */
export interface WatchPred {
  selector?: string; visible?: boolean; fn?: string; fnArg?: unknown; urlLike?: string; landed?: boolean;
  /** Combinators, one level (DECISIONS #43): `any` holds when one arm holds (`report.until.which` names it),
   *  `all` when every arm holds — arms are full predicates, so wire-AND-DOM postconditions work. */
  any?: WatchPred[]; all?: WatchPred[];
  /** Optional label for an arm (what `which` reports; defaults to the arm's index). */
  name?: string;
}
export const hasPred = (p: WatchPred | undefined | null): boolean => !!p && !!(p.selector || p.fn || p.urlLike || p.any?.length || p.all?.length);
/** `until`: the postcondition act() must reach before it returns (GUIDANCE §9). The verdict keeps saying
 *  what the page DID; `until` says whether the state you need ARRIVED. */
export interface UntilSpec extends WatchPred { budgetMs?: number; tailMs?: number; frame?: string /* the postcondition's frame, when not the action's (a finder click whose effect is a new chart frame) */ }

export interface ActParams {
  kind: ActKind;
  target?: string; frame?: string; targetId?: string;
  text?: string; key?: string; url?: string; value?: string; deltaY?: number; to?: string; toOffset?: { dx: number; dy: number };
  budgetMs?: number; quietMs?: number; noEffectMs?: number; maxBudgetMs?: number;
  evaluateAfter?: string; evaluateAfterArg?: unknown; world?: "main" | "disco";
  until?: UntilSpec;
}

const POINTER: Record<string, { button: "left" | "right" | "middle"; clickCount: number }> = {
  click: { button: "left", clickCount: 1 }, rightclick: { button: "right", clickCount: 1 },
  dblclick: { button: "left", clickCount: 2 }, middleclick: { button: "middle", clickCount: 1 },
};
const NO_HIT_TEST = new Set<ActKind>(["type", "fill", "select"]); // keyboard/value kinds act on the resolved handle, not a point


export function registerActions(d: Daemon): Selectors {
  const sel = new Selectors(d);
  d.register("act", (p) => act(d, sel, p as ActParams));
  d.register("settle", (p) => awaitSettlement(d, sel, p));
  d.register("watch", (p) => watch(d, sel, p));
  return sel;
}

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

/** THE event → settle-signal mapping. Every settler (main, background, until-tail) feeds through this one
 *  function, so they agree on what counts as activity (review: bg used to miss nav/dialog/new-target). */
function signalFromEvent(d: Daemon, rootId: string, actionId: string, ev: DaemonEvent, selfContained?: (ev: DaemonEvent) => boolean): SettleSignal | null {
  const tin = ev.targetId ? d.targets.get(ev.targetId)?.rootTargetId === rootId || ev.targetId === rootId : false;
  const sum = ev.summary as any;
  switch (ev.kind) {
    case "request": return ev.actionId === actionId && sum?.a !== "ambient" ? { kind: "request-start", t: ev.t, id: String(ev.ref) } : null;
    case "response": return ev.actionId === actionId ? { kind: "request-end", t: ev.t, id: String(ev.ref) } : null;
    case "mutation": return tin && !sum?.amb ? { kind: "mutation", t: ev.t } : null;
    case "visual": return tin && !selfContained?.(ev) ? { kind: "visual", t: ev.t } : null;
    case "nav": return tin && sum?.kind === "navigated" && sum?.main ? { kind: "navigated", t: ev.t, url: sum.url } : null;
    case "dialog": return tin ? { kind: "dialog", t: ev.t } : null;
    case "target": return sum?.state === "attached" && sum?.opener && d.targets.get(sum.opener)?.rootTargetId === rootId ? { kind: "new-target", t: ev.t, targetId: ev.targetId } : null;
    case "download": return tin ? { kind: "download", t: ev.t } : null;
  }
  return null;
}

/** Self-feedback suppression (DECISIONS #23): a small clicked element repainting itself (pressed state,
 *  focus ring) is expected affordance feedback, not an effect. Visual changes confined to the target box
 *  are dropped from the feed; big targets (canvases, panels) keep their in-element pixel signal. */
function selfContainedIn(d: Daemon, rootId: string, selfBox: Box): (ev: DaemonEvent) => boolean {
  return (ev) => {
    const boxes = (ev.summary as any)?.boxes as Box[] | undefined;
    if (!boxes?.length) return false;
    const cast = d.targets.get(rootId)?.cast;
    const scale = cast && cast.viewW > 0 && cast.w > 0 ? cast.w / cast.viewW : 1;
    // Changed regions are TILE-aligned (32px grid in cast pixels), so the tolerance must cover a full
    // tile in CSS pixels on every edge, or a button hugging a tile boundary escapes its own box.
    const pad = defaults.selfFeedbackInflatePx + defaults.visualTilePx / scale;
    return boxes.every((b) => b.x / scale >= selfBox.x - pad && b.y / scale >= selfBox.y - pad && (b.x + b.w) / scale <= selfBox.x + selfBox.w + pad && (b.y + b.h) / scale <= selfBox.y + selfBox.h + pad);
  };
}

function feedFromEvent(d: Daemon, rootId: string, actionId: string, s: Settler, selfBox?: Box | null) {
  const sc = selfBox ? selfContainedIn(d, rootId, selfBox) : undefined;
  return d.listen((ev) => { const sig = signalFromEvent(d, rootId, actionId, ev, sc); if (sig) s.feed(sig); });
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

/** Frames in a root's target tree, for frame-not-found diagnoses. */
const frameCensus = (d: Daemon, rootId: string) => [...d.frames.values()].filter((f) => d.targets.get(f.targetId)?.rootTargetId === rootId).map((f) => `${f.frameId.slice(0, 6)}:${f.url.slice(0, 80)}`);

export async function act(d: Daemon, sel: Selectors, p: ActParams): Promise<Report> {
  if (!KINDS[p.kind]) throw new RpcError(-32602, `unknown act kind ${JSON.stringify(p.kind)}`);
  const tEntry = d.now();
  const n = d.store.nextActionN();
  const actionId = `act:${n}`;
  const seqStart = d.store.lastSeq() + 1;
  const spec = { ...p, evaluateAfter: p.evaluateAfter ? "(fn)" : undefined, until: p.until ? redactFns(p.until) : undefined };
  // A frame that doesn't exist (yet) is a diagnosis with a frame census, not a bare RPC error (GUIDANCE §2.2):
  // enterprise apps build tabs as child frames a beat after the action that opens them — `until` on the frame.
  let frame: FrameInfo;
  try { frame = d.resolveFrame(p.frame, p.targetId); }
  catch (e) {
    const t = p.targetId ? d.targets.get(p.targetId) : d.primary();
    const main = t?.mainFrameId ? d.frames.get(t.mainFrameId) : null;
    if (!(e instanceof RpcError) || !p.frame || !t || !main) throw e;
    const rootT = d.targets.get(t.rootTargetId) ?? t;
    return failReport(d, { actionId, n, kind: p.kind, spec, frame: main, root: rootT, seqStart, diagnosis: { reason: "frame-not-found", error: (e as Error).message, candidates: frameCensus(d, rootT.rootTargetId) } });
  }
  const root = d.targets.get(d.targetOfFrame(frame).rootTargetId) ?? d.primary();
  const fail = (diagnosis: Diagnosis, resolvedInfo?: Resolved) => failReport(d, { actionId, n, kind: p.kind, spec, frame, root, seqStart, resolvedInfo, diagnosis });

  // ---- resolve now; fail with a diagnosis, never wait (GUIDANCE §2.2) ----
  let resolved: Resolved | null = null;
  let detachedRetried = false;
  let didScroll = false;
  let tHitTest = d.now();
  let point: Point | null = null;
  if (KINDS[p.kind].target) {
    if (!p.target) throw new RpcError(-32602, `act ${p.kind} needs a target selector`);
    const r = await sel.resolve(frame, p.target);
    if (!("objectId" in r)) return fail(await diagnose(d, frame, root, "not-found", { error: r.error, candidates: r.candidates }));
    resolved = r;
    // hit-test with one re-resolve on detachment (GUIDANCE §8 re-render races)
    tHitTest = d.now();
    if (!NO_HIT_TEST.has(p.kind)) {
      for (let attempt = 0; ; attempt++) {
        try {
          const hit = await sel.hitCheck(frame, p.target);
          if (!hit.ok) {
            if (hit.hit && attempt === 0 && /detach|gone/i.test(hit.hit)) throw new RpcError(-32013, "detached");
            return fail(await diagnose(d, frame, root, "occluded", { occludedBy: hit.hit }), resolved);
          }
          point = hit.point!;
          didScroll = !!hit.scrolled;
          break;
        } catch (e) {
          if (attempt >= 1) return fail(await diagnose(d, frame, root, "detached", { error: (e as Error).message }));
          detachedRetried = true;
          const rr = await sel.resolve(frame, p.target);
          if (!("objectId" in rr)) return fail(await diagnose(d, frame, root, "detached", { error: "element disappeared between resolve and dispatch", candidates: rr.candidates }));
          resolved = rr;
        }
      }
    }
  }

  // ---- root-space coordinates, computed ONCE and BEFORE t0 ----
  // pointToRoot is 2–4 CDP round trips for nested frames; measuring them inside the causality window
  // skewed the no-effect tier and every settle_ms (review §4).
  if (p.kind === "scroll" && !point) point = { x: 400, y: 300 };
  const rootPoint = point ? await pointToRoot(d, frame, point) : null;
  let dragTo: Point | null = null;
  if (p.kind === "drag") {
    if (!p.to && !p.toOffset) throw new RpcError(-32602, "drag needs `to` (selector) or `toOffset` ({dx,dy})");
    let toPoint: Point;
    if (p.to) {
      const hit = await sel.hitCheck(frame, p.to).catch(() => null);
      if (!hit?.point) return fail(await diagnose(d, frame, root, "not-found", { error: `drag target ${p.to} not resolvable`, candidates: await sel.candidates(frame, p.to).catch(() => []) }), resolved!);
      toPoint = hit.point;
    } else toPoint = { x: point!.x + p.toOffset!.dx, y: point!.y + p.toOffset!.dy };
    dragTo = (await pointToRoot(d, frame, toPoint)).point;
  }

  // If resolution scrolled the target into view, the whole viewport repaints ~tens of ms later; absorb
  // that BEFORE opening the causality window so the scroll (pre-action adjustment) is not an "effect".
  const tResolved = d.now();
  if (didScroll) await absorbVisual(d, root, defaults.scrollAbsorbMaxMs, tHitTest);
  const tAbsorbed = d.now();
  const pre = await snapshot(d, sel, frame, root, "pre");
  try { await d.callInFrame(frame, "function(t){ return window.__discoApi ? window.__discoApi.armTask(t) : 0; }", [KINDS[p.kind].task]); } catch {}
  const t0 = d.now();

  let selfBox: Box | null = null;
  if (resolved?.box && POINTER[p.kind] && resolved.box.w * resolved.box.h <= defaults.selfFeedbackMaxArea && point && rootPoint) {
    const dx = rootPoint.point.x - point.x, dy = rootPoint.point.y - point.y;
    selfBox = { x: resolved.box.x + dx, y: resolved.box.y + dy, w: resolved.box.w, h: resolved.box.h };
  }
  const settler = new Settler({ t0, quietMs: p.quietMs, noEffectMs: p.noEffectMs, budgetMs: p.budgetMs, maxBudgetMs: p.maxBudgetMs }, sessionClock(d));
  const unsub = feedFromEvent(d, root.rootTargetId, actionId, settler, selfBox); // subscribed BEFORE the window opens (review F10)

  // ---- causality window opens at dispatch (GUIDANCE §4.1) ----
  d.openWindow(root.rootTargetId, actionId, t0);
  d.store.insert("actions", { id: actionId, n, t_start: t0, target_id: root.targetId, frame_id: frame.frameId, kind: p.kind, spec: JSON.stringify(spec), resolved: resolved ? JSON.stringify({ selector: p.target, preview: resolved.preview, generated: resolved.generated, count: resolved.count }) : null, pre_shot: pre.shot ?? null, pre_aria: pre.aria ?? null });
  d.publish({ kind: "action", t: t0, targetId: root.targetId, actionId, summary: { kind: p.kind, target: p.target ?? p.url ?? p.key, state: "dispatch", until: p.until ? untilLabel(p.until) : undefined } });

  // ---- dispatch ----
  try {
    if (POINTER[p.kind]) await clickAt(d, rootPoint!.root, rootPoint!.point, POINTER[p.kind]);
    else if (p.kind === "hover") await hoverAt(d, rootPoint!.root, rootPoint!.point);
    else if (p.kind === "drag") await dragFromTo(d, rootPoint!.root, rootPoint!.point, dragTo!);
    else if (p.kind === "type" || p.kind === "fill") {
      const t = d.targetOfFrame(frame);
      await d.send(t, "DOM.focus", { objectId: resolved!.objectId }).catch(async () => {
        const hit = await sel.hitCheck(frame, p.target!);
        if (hit.point) { const { point: rp, root: rt } = await pointToRoot(d, frame, hit.point); await clickAt(d, rt, rp, { button: "left", clickCount: 1 }); }
      });
      // fill = select-all then type (or Backspace to clear): real key events, so controlled inputs (React)
      // see a normal edit — packs used to clear via evaluate(), an unattributed mutation outside the choke point.
      if (p.kind === "fill") { await pressKey(d, root, "Control+a"); if (!p.text) await pressKey(d, root, "Backspace"); }
      if (p.text) await typeText(d, root, p.text);
    } else if (p.kind === "press") await pressKey(d, root, p.key ?? "Enter");
    else if (p.kind === "scroll") await wheelAt(d, rootPoint!.root, rootPoint!.point, p.deltaY ?? 400);
    else if (p.kind === "select") {
      // Use the already-resolved element handle so role=/text=/shadow selectors work (review F14);
      // events dispatched from the isolated world cross into the page (shared DOM).
      const t = d.targetOfFrame(frame);
      const res = await d.send<{ result: any; exceptionDetails?: any }>(t, "Runtime.callFunctionOn", { objectId: resolved!.objectId, functionDeclaration: `function(value){ this.value = value; this.dispatchEvent(new Event("input", {bubbles:true})); this.dispatchEvent(new Event("change", {bubbles:true})); return this.value; }`, arguments: [{ value: p.value ?? "" }], returnByValue: true });
      if (res.exceptionDetails) throw new RpcError(-32010, `select failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    } else if (p.kind === "navigate") await d.send(root, "Page.navigate", { url: p.url! });
  } catch (e) {
    unsub(); settler.cancel(); d.closeWindow(root.rootTargetId);
    return fail(await diagnose(d, frame, root, "error", { error: (e as Error).message }));
  }

  // ---- settle, and (optionally) reach the postcondition ----
  // Without `until`: the quiescence race decides when we return (GUIDANCE §4.2). With `until`: the
  // predicate is watched from dispatch and the two signals stay independent — the verdict reports what the
  // page did, `until` whether the expected state arrived — and the return is gated on both (bounded).
  let result: SettleResult;
  let until: UntilResult | undefined;
  const untilSpec = hasPred(p.until) ? p.until! : null;
  if (!untilSpec) result = await settler.result;
  else {
    const tail = untilSpec.tailMs ?? defaults.untilTailMs;
    const untilFrame = untilSpec.frame ? () => { try { return d.resolveFrame(untilSpec.frame, p.targetId); } catch { return null; } } : () => d.frames.get(frame.frameId) ?? frame;
    const w = runWatch(d, sel, untilFrame, root, untilSpec, untilSpec.budgetMs ?? defaults.untilBudgetMs, t0, untilSpec.frame ?? p.frame, true);
    const first = await Promise.race([settler.result.then((r) => ({ settled: r })), w.done.then((u) => ({ until: u }))]);
    if ("until" in first) {
      // Predicate (or its budget) came first: cap the remaining quiet-wait to a short tail. Matched +
      // still-active is a PASS for automation (noisy page, state reached); the verdict says what still moves.
      until = first.until;
      settler.cap(tail);
      result = await settler.result;
    } else {
      // Settlement came first (the early return that would trap a script): the window stays open — anything
      // the page still does attributes to this action — while the predicate is watched to its budget.
      result = first.settled;
      until = await w.done;
      // On a match, a short seeded tail lets in-flight attributed responses (and their render) land in the report.
      if (until.matched) await tailSettle(d, root.rootTargetId, actionId, tail);
    }
  }
  unsub();
  const tEnd = Math.max(result.tReported, until ? t0 + until.elapsedMs : 0, d.now());
  const stillActive = result.verdict === "still-active";
  if (untilSpec || !stillActive) d.closeWindow(root.rootTargetId); // with `until` the postcondition decided; the script moves on
  else backgroundSettle(d, root.rootTargetId, actionId, t0); // still-active keeps the window open for awaitSettlement (GUIDANCE §5.1; review F3)

  const tWaited = d.now();
  const postFrame = d.frames.get(frame.frameId) ?? frame; // frame may have navigated
  const post = await snapshot(d, sel, postFrame, root, "post");
  const tPost = d.now();
  let evalResult: unknown;
  if (p.evaluateAfter) {
    try { evalResult = (await d.callInFrame(postFrame, p.evaluateAfter, [p.evaluateAfterArg ?? null], p.world ?? "main")).value; }
    catch (e) { const m = (e as Error).message; evalResult = { error: /ReferenceError|is not defined/.test(m) ? closureHint(m) : m }; }
  }
  const report = buildReport(d, {
    actionId, kind: p.kind, spec, frame: postFrame, root, verdict: result.verdict, settle: result, t0, tEnd, until,
    resolved: resolved ? { selector: p.target, preview: resolved.preview, generated: resolved.generated, count: resolved.count, detachedRetried } : undefined,
    pre: { shot: pre.shot, aria: pre.aria, url: pre.url, focused: pre.focused }, post: { shot: post.shot, aria: post.aria, url: post.url, focused: post.focused },
    preAriaText: pre.ariaText, postAriaText: post.ariaText, evaluateAfter: evalResult, seqStart,
  });
  const tBuilt = d.now();
  const ms = (a: number, b: number) => Math.round(b - a);
  const timing: Timing = { resolveMs: ms(tEntry, tResolved), absorbMs: ms(tResolved, tAbsorbed), preMs: ms(tAbsorbed, t0), settleMs: ms(t0, result.tSettled), reportedMs: ms(t0, result.tReported), untilMs: until ? Math.round(until.elapsedMs) : undefined, waitMs: ms(t0, tWaited), postMs: ms(tWaited, tPost), buildMs: ms(tPost, tBuilt), overheadMs: 0, totalMs: ms(tEntry, tBuilt) };
  timing.overheadMs = timing.resolveMs + timing.preMs + timing.postMs + timing.buildMs; // daemon work: everything that isn't waiting on the page (absorb = the page repainting after scrollIntoView)
  report.timing = timing;
  d.store.update("actions", { t_settled: result.tSettled, verdict: result.verdict, settle_ms: result.tSettled - t0, timeline: JSON.stringify(result.timeline), post_shot: post.shot ?? null, post_aria: post.aria ?? null, report: JSON.stringify(report), seq_start: seqStart, seq_end: report.cursor.to }, "id=?", [actionId]);
  d.publish({ kind: "settle", t: result.tReported, targetId: root.targetId, actionId, summary: { verdict: result.verdict, ms: Math.round(result.tSettled - t0), requests: result.counts.requests, until: until ? (until.matched ? "matched" : "unmatched") : undefined, untilMs: until ? Math.round(until.elapsedMs) : undefined } });
  return report;
}

const redactFns = (u: WatchPred): WatchPred => ({ ...u, fn: u.fn ? "(fn)" : undefined, any: u.any?.map(redactFns), all: u.all?.map(redactFns) });
const untilLabel = (u: UntilSpec): string => u.any ? `any(${u.any.map(untilLabel).join(" | ")})` : u.all ? `all(${u.all.map(untilLabel).join(" & ")})` : u.selector ?? u.urlLike ?? "(fn)";
/** The hint for a ReferenceError inside a page function (they capture nothing from the caller's script). */
export const closureHint = (msg: string) => `${msg.replace(/^in-page error: /, "")} — page functions capture nothing from your script; pass the value in as fnArg / args / evaluateAfterArg`;

/** After an `until` match that came after settlement: a short settle seeded with this action's in-flight
 *  attributed requests, so the response that the predicate announced (e.g. a `urlLike` match fires on
 *  request START) and its render are in the report. Costs ≤ quietMs when nothing is moving. */
async function tailSettle(d: Daemon, rootId: string, actionId: string, tailMs: number): Promise<SettleResult> {
  const s = new Settler({ t0: d.now(), noEffectMs: defaults.quietMs, budgetMs: tailMs, maxBudgetMs: tailMs }, sessionClock(d));
  s.seed([...d.inflight.values()].filter((x) => x.actionId === actionId && x.attribution !== "ambient" && !x.stalled).map((x) => x.id));
  const unsub = feedFromEvent(d, rootId, actionId, s);
  const res = await s.result; unsub();
  return res;
}

/** After still-active, keep watching in the background: close the window (and fix the action row) at
 *  eventual quiescence, so hours of later traffic are not misattributed (review F3). awaitSettlement
 *  cancels it (window.bg) when it takes the same action over; a new act() on the root supersedes it. */
function backgroundSettle(d: Daemon, rootId: string, actionId: string, originalT0: number) {
  const bg = new Settler({ t0: d.now(), budgetMs: defaults.budgetMs, maxBudgetMs: defaults.maxBudgetMs }, sessionClock(d));
  bg.seed([...d.inflight.values()].filter((x) => x.actionId === actionId && x.attribution !== "ambient" && !x.stalled).map((x) => x.id));
  const unsub = d.listen((ev) => {
    if (d.windows.get(rootId)?.actionId !== actionId) { unsub(); bg.cancel(); return; } // superseded
    const sig = signalFromEvent(d, rootId, actionId, ev);
    if (sig) bg.feed(sig);
  });
  const w = d.windows.get(rootId);
  if (w) w.bg = () => { unsub(); bg.cancel(); };
  void bg.result.then((res) => {
    unsub();
    const cur = d.windows.get(rootId);
    if (cur?.actionId !== actionId || cur.bg === undefined) return; // superseded, or awaitSettlement owns it now
    d.closeWindow(rootId);
    d.store.update("actions", { t_settled: res.tSettled, settle_ms: res.tSettled - originalT0, verdict: res.verdict === "still-active" ? "still-active" : "settled:late" }, "id=? AND verdict='still-active'", [actionId]);
    d.publish({ kind: "settle", t: res.tReported, targetId: rootId, actionId, summary: { verdict: res.verdict, background: true, ms: Math.round(res.tSettled - originalT0) } });
  });
}

/** After scrollIntoView, wait for the viewport repaint to finish — but only if one actually happened since
 *  the scroll (`since`): a scroll that changed nothing on screen costs one tick, not a fixed quarter second
 *  (P4-A friction #15). */
async function absorbVisual(d: Daemon, root: TargetState, maxMs: number, since: number): Promise<void> {
  const t0 = d.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 60));
    const cast = root.cast;
    if (!cast || d.now() - t0 >= maxMs) return;
    if (cast.lastChangedT < since && !cast.pending) return; // nothing repainted since the scroll
    // quiet = no decoded change recently AND no rate-capped frame still awaiting its deferred decode
    if (d.now() - cast.lastChangedT >= defaults.scrollAbsorbQuietMs && !cast.pending) return;
  }
}

function failReport(d: Daemon, i: { actionId: string; n: number; kind: string; spec: unknown; frame: FrameInfo; root: TargetState; seqStart: number; resolvedInfo?: Resolved; diagnosis: Diagnosis }): Report {
  const t0 = d.now();
  if (d.windows.get(i.root.rootTargetId)?.actionId === i.actionId) d.closeWindow(i.root.rootTargetId); // review F6: never destroy another action's open window
  // Publish BEFORE building the report so the cursor covers this action's own event (dry-run friction #7:
  // an empty window used to yield an inverted `{from: N+1, to: N}` cursor).
  d.publish({ kind: "action", t: t0, targetId: i.root.targetId, actionId: i.actionId, summary: { kind: i.kind, state: "diagnosis", reason: i.diagnosis?.reason } });
  const report = buildReport(d, { actionId: i.actionId, kind: i.kind, spec: i.spec as any, frame: i.frame, root: i.root, verdict: "diagnosis", t0, tEnd: t0, seqStart: i.seqStart, diagnosis: i.diagnosis });
  d.store.upsert("actions", { id: i.actionId, n: i.n, t_start: t0, target_id: i.root.targetId, frame_id: i.frame.frameId, kind: i.kind, spec: JSON.stringify(i.spec), verdict: "diagnosis", report: JSON.stringify(report), seq_start: i.seqStart, seq_end: report.cursor.to });
  return report;
}

/** awaitSettlement: extend a still-active action's window, or re-arm fresh (GUIDANCE §5.1). */
export async function awaitSettlement(d: Daemon, sel: Selectors, p: { action?: string; budgetMs?: number; frame?: string; targetId?: string }): Promise<Report> {
  const frame = d.resolveFrame(p.frame, p.targetId);
  const root = d.targets.get(d.targetOfFrame(frame).rootTargetId) ?? d.primary();
  const open = d.windows.get(root.rootTargetId);
  let actionId: string; let t0: number; let seed: string[] = []; let n: number; let seqStart: number; let kind = "settle"; let originalT0: number | null = null;
  if (open && (!p.action || open.actionId === p.action)) {
    open.bg?.(); open.bg = undefined; // take the window over from the background settler (it must not close it under us)
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
  if (originalT0 !== null) report.extended = true;
  d.store.update("actions", { t_settled: result.tSettled, verdict: result.verdict, settle_ms: result.tSettled - (originalT0 ?? t0), timeline: JSON.stringify(result.timeline), post_shot: post.shot ?? null, post_aria: post.aria ?? null, report: JSON.stringify(report), seq_end: report.cursor.to }, "id=?", [actionId]);
  d.publish({ kind: "settle", t: result.tReported, targetId: root.targetId, actionId, summary: { verdict: result.verdict, ms: Math.round(result.tSettled - t0) } });
  return report;
}

/** watch(): event-driven predicate wait; diagnosis on expiry, never a bare timeout (GUIDANCE §5.2). A frame
 *  that doesn't exist yet is waited for, not thrown on (`frame` is re-resolved per check). */
export async function watch(d: Daemon, sel: Selectors, p: WatchPred & { budgetMs?: number; frame?: string; targetId?: string }): Promise<UntilResult> {
  if (!hasPred(p)) throw new RpcError(-32602, "watch needs selector, fn, urlLike, any, or all");
  const t = p.targetId ? d.targets.get(p.targetId) : d.primary();
  if (!t) throw new RpcError(-32602, `unknown target ${p.targetId}`);
  const root = d.targets.get(t.rootTargetId) ?? t;
  const frameOf = () => { try { return d.resolveFrame(p.frame, p.targetId); } catch { return null; } };
  return runWatch(d, sel, frameOf, root, p, p.budgetMs ?? defaults.watchBudgetMs, d.now(), p.frame).done;
}

/** The predicate loop behind watch() and act({until}): re-checks on mutation/request/response/nav/target
 *  events (plus a coarse interval for canvas-only changes), budgeted from `t0`, diagnosis on expiry. The frame
 *  is re-resolved per check so a navigation mid-wait, or a frame that appears mid-wait, is handled. */
function runWatch(d: Daemon, sel: Selectors, frameOf: () => FrameInfo | null, root: TargetState, pred: WatchPred, budgetMs: number, t0: number, frameSpec?: string, sinceDispatch = false): { done: Promise<UntilResult>; cancel(): void } {
  /** A page function that throws ReferenceError is a closure-capture bug, not a "not yet": fail fast with the hint
   *  instead of reading `false` until the budget expires (DECISIONS #43). */
  class PageFnError extends Error {}
  const checkOne = async (pred: WatchPred): Promise<{ ok: boolean; preview?: string; request?: string }> => {
    try {
      if (pred.urlLike) {
        // Causality: for act({until}) only a request that STARTED after dispatch can be this action's effect;
        // for a standalone watch(), "started or landed since I began watching" (README). `landed` additionally
        // needs the response back (status known) and the body's fate decided — captured (`ok`), or known
        // uncapturable (`none` / `unread` fire-and-forget fetches / `streaming` / …) — never still `pending`;
        // and never a response that landed before t0 (a previous action's late tail must not satisfy this one).
        const body = " AND status IS NOT NULL AND body_state IS NOT NULL AND body_state != 'pending'";
        const since = sinceDispatch ? "t_start>=?" : pred.landed ? "t_response>=?" : "(t_start>=? OR t_end>=?)";
        const args = sinceDispatch || pred.landed ? [t0 - (sinceDispatch ? 50 : 0)] : [t0 - 50, t0 - 50];
        const r = d.store.get<any>(`SELECT id FROM requests WHERE url LIKE ? AND ${since}${pred.landed ? body : ""} ORDER BY t_start DESC LIMIT 1`, `%${pred.urlLike}%`, ...args);
        if (r) return { ok: true, request: r.id };
      }
      const fr = frameOf();
      if (pred.selector && fr) {
        const r = await sel.resolve(fr, pred.selector).catch(() => null);
        if (r && "objectId" in r && (!pred.visible || (r.box && r.box.w > 1 && r.box.h > 1))) return { ok: true, preview: r.preview };
      }
      if (pred.fn && fr) {
        const r = await d.callInFrame(fr, pred.fn, [pred.fnArg ?? null], "main").catch((e: Error) => { if (/ReferenceError|is not defined/.test(e.message)) throw new PageFnError(closureHint(e.message)); return { value: false }; });
        if (r.value) return { ok: true, preview: JSON.stringify(r.value).slice(0, 120) };
      }
    } catch (e) { if (e instanceof PageFnError) throw e; }
    return { ok: false };
  };
  // Combinators recurse (an `any` inside an `all` used to be evaluated as a leaf and never matched — stranger #2 friction #1).
  const checkPred = async (p: WatchPred): Promise<{ ok: boolean; preview?: string; request?: string; which?: string }> => {
    if (p.any?.length) {
      for (const [i, arm] of p.any.entries()) { const r = await checkPred(arm); if (r.ok) return { ...r, which: r.which !== undefined && arm.any ? r.which : (arm.name ?? String(i)) }; }
      return { ok: false };
    }
    if (p.all?.length) {
      let last: { ok: boolean; preview?: string; request?: string; which?: string } = { ok: false };
      for (const arm of p.all) { last = await checkPred(arm); if (!last.ok) return { ok: false }; }
      return { ...last, ok: true };
    }
    return checkOne(p);
  };
  const check = async (): Promise<{ ok: boolean; preview?: string; request?: string; which?: string; fatal?: string }> => {
    try { return await checkPred(pred); } catch (e) { return { ok: false, fatal: (e as Error).message }; }
  };
  const expiryDiagnosis = async (): Promise<Diagnosis> => {
    const fr = frameOf();
    if (!fr) return { reason: "frame-not-found", error: `no frame matches ${JSON.stringify(frameSpec)}`, candidates: frameCensus(d, root.rootTargetId) };
    return diagnose(d, fr, root, "budget-expired", pred.selector ? { candidates: await sel.candidates(fr, pred.selector).catch(() => []) } : {}).catch(() => ({ reason: "budget-expired" as const }));
  };
  let done = false; let unsub = () => {}; let timer: ReturnType<typeof setTimeout> | null = null; let iv: ReturnType<typeof setInterval> | null = null;
  let finish!: (matched: boolean, extra?: any) => Promise<void>;
  const promise = new Promise<UntilResult>((resolve) => {
    finish = async (matched, extra = {}) => {
      if (done) return; done = true; unsub(); if (timer) clearTimeout(timer); if (iv) clearInterval(iv);
      const elapsedMs = Math.round(d.now() - t0);
      if (matched) return resolve({ matched: true, elapsedMs, ...extra });
      if (extra.cancelled) return resolve({ matched: false, elapsedMs });
      if (extra.fatal) return resolve({ matched: false, elapsedMs, diagnosis: { reason: "error", error: extra.fatal } });
      resolve({ matched: false, elapsedMs, diagnosis: await expiryDiagnosis() });
    };
    void (async () => {
      const first = await check();
      if (first.ok) return finish(true, first);
      if (first.fatal) return finish(false, { fatal: first.fatal });
      if (done) return;
      let checking = false; let lastCheck = 0;
      const maybeCheck = async () => {
        if (checking || done || d.now() - lastCheck < defaults.watchMinGapMs) return;
        checking = true; lastCheck = d.now();
        try { const r = await check(); if (r.ok) await finish(true, r); else if (r.fatal) await finish(false, { fatal: r.fatal }); } finally { checking = false; }
      };
      unsub = d.listen((ev) => {
        const tin = ev.targetId ? d.targets.get(ev.targetId)?.rootTargetId === root.rootTargetId : false;
        if ((ev.kind === "mutation" && tin) || ev.kind === "response" || ev.kind === "request" || ev.kind === "nav" || ev.kind === "target") void maybeCheck();
      });
      iv = setInterval(() => void maybeCheck(), defaults.watchIntervalMs); // safety net: covers non-mutating changes (e.g. canvas)
      timer = setTimeout(() => void finish(false), Math.max(0, t0 + budgetMs - d.now()));
    })();
  });
  return { done: promise, cancel: () => void finish(false, { cancelled: true }) };
}
