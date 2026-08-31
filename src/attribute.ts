// Causal attribution + ambient classifier (GUIDANCE §4.4, BRIEF §1.13, §1.19). Pure logic: no CDP,
// no store — the daemon feeds observations in and persists family state out. Fake-clock testable.
import { defaults } from "../defaults.ts";

export type Attribution = "task" | "window" | "dependency" | "ambient" | "none";
export type WriteKind = "read" | "write" | "unknown";

export interface FamilyState {
  family: string; method: string; host: string; pathShape: string;
  count: number; firstT: number; lastT: number;
  starts: number[]; ends: number[];        // recent occurrences (bounded)
  outsideWindow: number;                   // occurrences that began outside any causality window
  ambient: boolean; ambientReason: "periodic" | "chained" | "manual" | null;
  evidence: Record<string, unknown>;
  writeKind: WriteKind;
}

export interface RequestObservation {
  id: string; method: string; url: string; tStart: number; targetId: string;
  initiatorType?: string; redirectFrom?: string | null; postData?: string | null; resourceType?: string;
}

export interface WindowInfo { actionId: string; tStart: number; targetId: string; taskSpans?: Array<{ t0: number; t2: number }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXY = /^[0-9a-f]{16,}$/i;
const NUMERIC = /^\d+$/;
const TOKENY = /^[A-Za-z0-9_-]{24,}$/;

/** Family = method + host + path shape, where ids/uuids/hashes/tokens collapse to `*`. */
export function familyOf(method: string, url: string): { family: string; host: string; path: string; pathShape: string } {
  let host = "", path = url;
  try { const u = new URL(url); host = u.host; path = u.pathname; } catch { /* keep raw */ }
  const shape = path.split("/").map((seg) => (NUMERIC.test(seg) || UUID.test(seg) || HEXY.test(seg) || TOKENY.test(seg) ? "*" : seg)).join("/");
  return { family: `${method.toUpperCase()} ${host}${shape}`, host, path, pathShape: shape };
}

function isGraphQLMutation(url: string, postData: string | null | undefined): boolean | null {
  const looks = /graphql/i.test(url) || (postData?.trimStart().startsWith('{"query"') ?? false);
  if (!looks) return null;
  try { const j = JSON.parse(postData ?? ""); const q = String(j.query ?? ""); return /^\s*mutation\b/.test(q); } catch { return /\bmutation\b/.test(postData ?? ""); }
}

export class Attributor {
  families = new Map<string, FamilyState>();
  private byId = new Map<string, { family: string; attribution: Attribution; actionId: string | null }>();
  constructor(private opts: { now: () => number; windowFor: (targetId: string, t: number) => WindowInfo | null; onFamily: (f: FamilyState) => void; startT?: number; idleObservedMs?: () => number }) {}

  /** Immature until the session has OBSERVED enough idle time (BRIEF §1.13; review F8). */
  immature(): boolean {
    const idle = this.opts.idleObservedMs ? this.opts.idleObservedMs() : this.opts.now() - (this.opts.startT ?? 0);
    return idle < defaults.classifierWarmupMs;
  }

  markRead(family: string) { const f = this.families.get(family); if (f) { f.writeKind = "read"; this.opts.onFamily(f); } }
  markAmbient(family: string, ambient: boolean) { const f = this.families.get(family); if (f) { f.ambient = ambient; f.ambientReason = ambient ? "manual" : null; this.opts.onFamily(f); } }
  isAmbient(family: string): boolean { return this.families.get(family)?.ambient ?? false; }

  /** Called at requestWillBeSent. Returns the attribution decision for the request row. */
  observeRequest(r: RequestObservation): { family: string; host: string; path: string; pathShape: string; actionId: string | null; attribution: Attribution; writeKind: WriteKind; inWindow: boolean } {
    const { family, host, path, pathShape } = familyOf(r.method, r.url);
    const win = this.opts.windowFor(r.targetId, r.tStart);
    let f = this.families.get(family);
    if (!f) {
      f = { family, method: r.method.toUpperCase(), host, pathShape, count: 0, firstT: r.tStart, lastT: r.tStart, starts: [], ends: [], outsideWindow: 0, ambient: false, ambientReason: null, evidence: {}, writeKind: "unknown" };
      this.families.set(family, f);
    }
    f.count++; f.lastT = r.tStart; f.starts.push(r.tStart); if (f.starts.length > 16) f.starts.shift();
    if (!win) f.outsideWindow++;
    // write kind (per family, sticky once read/write is known)
    if (f.writeKind === "unknown") {
      const m = r.method.toUpperCase();
      if (m === "GET" || m === "HEAD" || m === "OPTIONS") f.writeKind = "read";
      else { const gq = isGraphQLMutation(r.url, r.postData); f.writeKind = gq === null ? "write" : gq ? "write" : "read"; }
    }
    // Same endpoint can carry both: a mutation on a read-marked graphql family still flags per-request.
    const gqNow = isGraphQLMutation(r.url, r.postData);
    const writeKind: WriteKind = gqNow === true ? "write" : f.writeKind;
    this.classify(f);
    // attribution
    let attribution: Attribution = "none"; let actionId: string | null = null;
    if (win) {
      actionId = win.actionId;
      if (r.redirectFrom && this.byId.get(r.redirectFrom)?.attribution !== "none" && this.byId.get(r.redirectFrom)?.attribution !== "ambient") attribution = "dependency";
      else if (f.ambient) attribution = "ambient";
      else if (win.taskSpans?.some((s) => r.tStart >= s.t0 - 2 && r.tStart <= s.t2 + defaults.taskTierSlackMs)) attribution = "task";
      else attribution = "window";
    } else if (r.redirectFrom) {
      const prev = this.byId.get(r.redirectFrom);
      if (prev && prev.actionId && prev.attribution !== "none" && prev.attribution !== "ambient") { attribution = "dependency"; actionId = prev.actionId; }
    }
    this.byId.set(r.id, { family, attribution, actionId });
    if (this.byId.size > 5000) { const first = this.byId.keys().next().value; if (first) this.byId.delete(first); }
    this.opts.onFamily(f);
    return { family, host, path, pathShape, actionId, attribution, writeKind, inWindow: !!win };
  }

  /** Upgrade an in-window request to `task` after the fact (task marker arrives after the request starts). */
  reattributeTask(ids: string[]): void { for (const id of ids) { const e = this.byId.get(id); if (e && e.attribution === "window") e.attribution = "task"; } }
  attributionOf(id: string) { return this.byId.get(id); }

  observeEnd(id: string, tEnd: number) {
    const e = this.byId.get(id); if (!e) return;
    const f = this.families.get(e.family); if (!f) return;
    f.ends.push(tEnd); if (f.ends.length > 16) f.ends.shift();
    this.classify(f);
  }

  /** Periodicity (regular cadence) or chained (long-poll) → ambient, given ≥1 occurrence outside any window. */
  private classify(f: FamilyState) {
    if (f.ambientReason === "manual") return;
    if (f.count < defaults.ambientMinCount || f.outsideWindow < 1) return;
    // Cadence is measured between BURSTS: SWR-style pages refetch a family 2–3× within a few ms on every
    // cycle, which made a clean 60s heartbeat look like gaps [0, 60001, 2, 120066, 33] (cv ≈ 1.5, never
    // ambient — P4-B friction #5). Starts within burstCollapseMs of the previous one are one occurrence.
    const bursts: number[] = [];
    for (const s of f.starts) if (!bursts.length || s - bursts[bursts.length - 1] > defaults.burstCollapseMs) bursts.push(s);
    const gaps: number[] = [];
    for (let i = 1; i < bursts.length; i++) gaps.push(bursts[i] - bursts[i - 1]);
    let periodic = false, cv = NaN;
    if (gaps.length >= 2) {
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
      cv = mean > 0 ? sd / mean : NaN;
      periodic = mean >= 500 && cv < defaults.ambientMaxCv; // sub-500ms "cadence" is a burst, not a heartbeat
    }
    // chained = a LONG-POLL: each start follows the previous end within chainedPollGapMs AND the previous
    // request was held by the server (≥ longPollMinHoldMs). A read endpoint re-fetched back-to-back on every
    // route change (O3's GET /session ×3) has the gap shape but not the hold, and tagging it ambient hid the
    // one request that decides whether login worked (P4-B friction #4).
    let chained = 0;
    const off = f.starts.length - f.ends.length;
    for (let i = 1; i < f.starts.length; i++) {
      const prevEnd = f.ends[i - 1 - off], prevStart = f.starts[i - 1];
      if (prevEnd === undefined) continue;
      const held = prevEnd - prevStart >= defaults.longPollMinHoldMs;
      if (held && f.starts[i] - prevEnd >= -1 && f.starts[i] - prevEnd <= defaults.chainedPollGapMs) chained++;
    }
    const isChained = chained >= defaults.ambientMinCount - 1;
    const was = f.ambient;
    if (periodic || isChained) { f.ambient = true; f.ambientReason = periodic ? "periodic" : "chained"; }
    f.evidence = { gaps: gaps.slice(-6).map((g) => Math.round(g)), cv: isFinite(cv) ? Math.round(cv * 100) / 100 : null, chainedLinks: chained, outsideWindow: f.outsideWindow, count: f.count };
    if (was !== f.ambient) this.opts.onFamily(f);
  }
}
