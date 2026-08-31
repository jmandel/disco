// Observation-report digests (GUIDANCE §4.3, BRIEF §1.18): compact, bounded, everything else by handle.
import type { Daemon, FrameInfo, TargetState } from "./daemon.ts";
import { defaults } from "../defaults.ts";
import { ariaDiff } from "./selectors.ts";
import type { SettleResult, Verdict } from "./settle.ts";

/** Outcome of a predicate wait — `watch()`'s result, and `report.until` for act({until}). */
export interface UntilResult { matched: boolean; elapsedMs: number; preview?: string; request?: string; diagnosis?: Diagnosis }
export interface Timing { resolveMs: number; absorbMs: number; preMs: number; settleMs: number; reportedMs: number; untilMs?: number; waitMs: number; postMs: number; buildMs: number; overheadMs: number; totalMs: number }
export interface WireItem { line: string; body: string | null; id: string; family: string; a: string; m: string; p: string; s: number | null; ms: number | null }
export interface Report {
  action: string;
  kind: string;
  verdict: Verdict | "diagnosis";
  /** act({until}): whether the postcondition arrived, and when (independent of `verdict`, GUIDANCE §9). */
  until?: UntilResult;
  /** awaitSettlement extended an existing action's window (settle_ms stays relative to the original dispatch). */
  extended?: boolean;
  /** Where the milliseconds went. Page time = settleMs/reportedMs/untilMs; daemon overhead = everything else
   *  (resolve + hit-test + pre/post snapshots + report build). Responsiveness is a tested contract, not a hope. */
  timing?: Timing;
  target?: { selector?: string; preview?: string; generated?: string | null; frame: string; count?: number; detachedRetried?: boolean };
  settle?: { ms: number; reportedMs: number; timeline: Array<{ t: number; what: string }>; counts: SettleResult["counts"]; pending?: SettleResult["pending"] };
  ui?: { added: string[]; removed: string[]; addedMore: number; removedMore: number; changedBoxes: Array<{ x: number; y: number; w: number; h: number }>; ambientChurn?: number };
  wire?: { attributed: WireItem[]; more: number; ambientInWindow: number; otherActivity: string[]; ws: number; sse: number; wsPreview?: string[]; ssePreview?: string[] };
  console?: string[];
  env: { url: string; urlChanged?: string; navigated?: string; focus?: string | null; dialogs?: string[]; sentinels?: Array<{ name: string; title?: string; shot?: string | null; seq: number }>; writeFlag?: string[]; newTargets?: string[]; closedTargets?: string[]; classifierImmature?: boolean; castBlind?: boolean };
  evaluateAfter?: unknown;
  shots: { pre?: string; post?: string };
  aria: { pre?: string; post?: string };
  cursor: { from: number; to: number };
  diagnosis?: Diagnosis;
}
export interface Diagnosis { reason: "not-found" | "occluded" | "detached" | "budget-expired" | "frame-not-found" | "error"; error?: string; candidates?: string[]; occludedBy?: string; census?: unknown; pendingRequests?: string[]; domActive?: boolean; shot?: string | null }

export interface BuildInput {
  actionId: string; kind: string; spec: Record<string, unknown>;
  frame: FrameInfo; root: TargetState;
  verdict: Verdict | "diagnosis"; settle?: SettleResult; t0: number; tEnd: number; until?: UntilResult;
  resolved?: { selector?: string; preview?: string; generated?: string | null; count?: number; detachedRetried?: boolean };
  pre?: { shot?: string; aria?: string; url?: string; focused?: string | null };
  post?: { shot?: string; aria?: string; url?: string; focused?: string | null };
  preAriaText?: string; postAriaText?: string;
  evaluateAfter?: unknown;
  diagnosis?: Diagnosis;
  seqStart: number;
}

const inTree = (d: Daemon, rootId: string, targetId: string | null): boolean => !!targetId && (d.targets.get(targetId)?.rootTargetId === rootId || targetId === rootId);
/** Digest handles are 16-char prefixes (review F7); store.body()/blob() resolve prefixes. */
const h16 = (h: string | null | undefined): string | undefined => (h ? h.slice(0, 16) : undefined);

export function buildReport(d: Daemon, i: BuildInput): Report {
  const seqEnd = d.store.lastSeq();
  const r: Report = {
    action: i.actionId, kind: i.kind, verdict: i.verdict,
    env: { url: i.post?.url ?? i.pre?.url ?? i.root.url },
    shots: { pre: h16(i.pre?.shot), post: h16(i.post?.shot) },
    aria: { pre: h16(i.pre?.aria), post: h16(i.post?.aria) },
    cursor: { from: i.seqStart, to: seqEnd },
  };
  const t = d.targets.get(i.frame.targetId);
  if (i.resolved) r.target = { selector: i.resolved.selector, preview: i.resolved.preview, generated: i.resolved.generated, frame: i.frame.frameId === t?.mainFrameId && !t?.parentTargetId ? "main" : i.frame.frameId, count: i.resolved.count, detachedRetried: i.resolved.detachedRetried || undefined };
  if (i.diagnosis) r.diagnosis = i.diagnosis;
  if (i.until) r.until = i.until;
  if (i.settle) r.settle = { ms: Math.round(i.settle.tSettled - i.t0), reportedMs: Math.round(i.settle.tReported - i.t0), timeline: i.settle.timeline, counts: i.settle.counts, pending: i.settle.pending };

  // ---- UI delta (semantic, from aria snapshots) ----
  if (i.preAriaText !== undefined && i.postAriaText !== undefined) {
    const isNav = i.verdict === "navigated" || !!i.settle?.navigated;
    const diff = ariaDiff(i.preAriaText, i.postAriaText, isNav ? defaults.digestMaxUiLinesNav : defaults.digestMaxUiLines);
    r.ui = { ...diff, changedBoxes: i.root.cast?.boxes?.slice(0, 4) ?? [] };
    // Ambient-classified churn continued during the window (its mutations were excluded from
    // settlement AND may mask small real changes — dry-run friction #6): say so.
    const churn = d.store.get<{ n: number }>(`SELECT COUNT(*) n FROM events WHERE kind='mutation' AND action_id=? AND summary LIKE '%"amb":true%'`, i.actionId)?.n ?? 0;
    if (churn > 0) r.ui.ambientChurn = churn;
  }

  // ---- wire delta ----
  const rows = d.store.all<any>("SELECT id, method, url, path, family, status, mime, resp_size, body_hash, body_state, attribution, write_kind, t_start, t_end FROM requests WHERE action_id=? ORDER BY t_start", i.actionId);
  const attributed = rows.filter((x) => x.attribution && x.attribution !== "ambient" && x.attribution !== "none");
  const ambient = rows.length - attributed.length;
  const score = (x: any) => (x.status && (x.status < 200 || x.status >= 400) ? 3000 : 0) + (x.write_kind !== "read" ? 2000 : 0) + Math.min(999, Math.round((x.resp_size ?? 0) / 1000));
  attributed.sort((a, b) => score(b) - score(a));
  const shown = attributed.slice(0, defaults.digestMaxRequests).sort((a, b) => a.t_start - b.t_start);
  const wire: WireItem[] = shown.map((x) => ({
    line: `${x.method} ${x.path ?? x.url} → ${x.status ?? "…"}${x.body_state && x.body_state !== "ok" && x.body_state !== "none" ? " [" + x.body_state + "]" : ""}, ${fmtSize(x.resp_size)}${x.t_end ? ", " + Math.round(x.t_end - x.t_start) + "ms" : ""}${x.mime ? ", " + x.mime.split(";")[0] : ""}${x.attribution !== "window" ? " (" + x.attribution + ")" : ""}${x.write_kind !== "read" ? " ✎" + x.write_kind : ""}`,
    body: h16(x.body_hash) ?? null, id: x.id, family: x.family, a: x.attribution,
    m: x.method, p: x.path ?? x.url, s: x.status ?? null, ms: x.t_end ? Math.round(x.t_end - x.t_start) : null, // structured fields (dry-run friction #1)
  }));
  // Time-windowed queries are scoped to THIS action's target tree (like sentinels, review F15) so a
  // multi-tab session's other tabs don't leak into the report.
  const tree = d.treeIds(i.root.rootTargetId);
  const inTree = `target_id IN (${tree.map(() => "?").join(",")})`;
  const other = d.store.all<any>(`SELECT method, path, attribution FROM requests WHERE t_start BETWEEN ? AND ? AND (action_id IS NULL OR action_id != ?) AND ${inTree} ORDER BY t_start LIMIT 4`, i.t0, i.tEnd, i.actionId, ...tree);
  const ws = d.store.get<{ n: number }>("SELECT COUNT(*) n FROM ws_frames WHERE t BETWEEN ? AND ?", i.t0, i.tEnd)?.n ?? 0;
  const sse = d.store.get<{ n: number }>("SELECT COUNT(*) n FROM sse_events WHERE t BETWEEN ? AND ?", i.t0, i.tEnd)?.n ?? 0;
  r.wire = { attributed: wire, more: Math.max(0, attributed.length - wire.length), ambientInWindow: ambient, otherActivity: other.map((o) => `${o.method} ${o.path} (${o.attribution ?? "outside-window"})`), ws, sse };
  if (ws > 0) r.wire.wsPreview = d.store.all<any>("SELECT dir, substr(payload,1,80) p FROM ws_frames WHERE t BETWEEN ? AND ? ORDER BY t LIMIT 2", i.t0, i.tEnd).map((x) => `${x.dir === "in" ? "←" : "→"} ${x.p}`);
  if (sse > 0) r.wire.ssePreview = d.store.all<any>("SELECT substr(data,1,80) p FROM sse_events WHERE t BETWEEN ? AND ? ORDER BY t LIMIT 2", i.t0, i.tEnd).map((x) => "← " + x.p);
  const writes = attributed.filter((x) => x.write_kind !== "read").map((x) => `${x.method} ${x.path}`);
  if (writes.length) r.env.writeFlag = writes.slice(0, 4);

  // ---- console ----
  const cons = d.store.all<any>(`SELECT level, text FROM console WHERE t BETWEEN ? AND ? AND level IN ('warning','error','exception') AND ${inTree} ORDER BY t LIMIT ?`, i.t0, i.tEnd, ...tree, defaults.digestMaxConsole);
  if (cons.length) r.console = cons.map((c) => `${c.level}: ${String(c.text).slice(0, 160)}`);

  // ---- environment flags ----
  if (i.pre?.url && i.post?.url && i.pre.url !== i.post.url) r.env.urlChanged = i.post.url;
  if (i.settle?.navigated) r.env.navigated = i.settle.navigated;
  r.env.focus = i.post?.focused ?? null;
  const dlg = d.store.all<any>(`SELECT type, message FROM dialogs WHERE t BETWEEN ? AND ? AND ${inTree}`, i.t0 - 50, i.tEnd, ...tree);
  if (dlg.length) r.env.dialogs = dlg.map((x) => `${x.type}: ${String(x.message).slice(0, 120)}`);
  const newT = d.store.all<any>("SELECT target_id, url FROM targets WHERE attached_t BETWEEN ? AND ? AND scoped=1", i.t0, i.tEnd);
  if (newT.length) r.env.newTargets = newT.map((x) => `${x.target_id.slice(0, 8)} ${x.url}`);
  const goneT = d.store.all<any>("SELECT target_id, url FROM targets WHERE detached_t BETWEEN ? AND ?", i.t0, i.tEnd);
  if (goneT.length) r.env.closedTargets = goneT.map((x) => `${x.target_id.slice(0, 8)} ${x.url}`);
  // Sentinel flags are scoped to THIS action's target tree (review F15); global ones (no target) ride along.
  const sent = d.store.all<any>("SELECT seq, name, detail, shot, target_id FROM sentinels WHERE reported=0 ORDER BY seq LIMIT 16").filter((s) => !s.target_id || tree.includes(s.target_id)).slice(0, 8);
  if (sent.length) {
    r.env.sentinels = sent.map((s) => ({ seq: s.seq, name: s.name, title: safeTitle(s.detail), shot: h16(s.shot) ?? null }));
    for (const s of sent) d.store.run("UPDATE sentinels SET reported=1 WHERE seq=?", s.seq);
  }
  if (d.attrib.immature()) r.env.classifierImmature = true;
  if (i.root.cast && !i.root.castVisible) r.env.castBlind = true;
  if (i.evaluateAfter !== undefined) r.evaluateAfter = i.evaluateAfter;
  r.cursor.to = d.store.lastSeq();
  return r;
}

function fmtSize(n: number | null): string { if (n == null) return "?"; if (n < 1024) return n + "B"; if (n < 1048576) return Math.round(n / 102.4) / 10 + "KB"; return Math.round(n / 104857.6) / 10 + "MB"; }
function safeTitle(detail: string | null): string | undefined { try { const j = JSON.parse(detail ?? "{}"); return j.title || j.text || j.message || j.status; } catch { return undefined; } }

/** Shared diagnosis for failed resolution / expired watches (GUIDANCE §2.2): leave the agent smarter. */
export async function diagnose(d: Daemon, frame: FrameInfo, root: TargetState, reason: Diagnosis["reason"], extra: Partial<Diagnosis> = {}): Promise<Diagnosis> {
  let census: unknown = null;
  try { census = (await d.callInFrame(frame, "function(){ return window.__discoApi && window.__discoApi.census ? window.__discoApi.census() : null; }")).value; } catch {}
  const pending = [...d.inflight.values()].filter((x) => !x.stalled && inTree(d, root.rootTargetId, x.targetId)).map((x) => `${x.method} ${x.url.slice(0, 120)}`).slice(0, 6); // review F4
  const lastMut = d.store.get<{ t: number }>("SELECT MAX(t) t FROM mutations WHERE target_id=?", root.targetId)?.t ?? -1;
  let shot: string | null = null;
  try { shot = (await d.captureShot(root, "diag")).hash; } catch {}
  return { reason, census, pendingRequests: pending, domActive: lastMut > 0 && d.now() - lastMut < defaults.diagnosisDomActiveMs, shot, ...extra };
}
