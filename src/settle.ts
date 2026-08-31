// The settlement race (GUIDANCE §4.2): quiescence detectors racing under tiered deadlines. Pure logic —
// signals in, verdict out — with an injected clock so unit tests run on fake time (BRIEF §6.5).
import { defaults } from "../defaults.ts";

export interface SettleConfig { quietMs?: number; noEffectMs?: number; budgetMs?: number; maxBudgetMs?: number; t0: number }
export type SettleSignal =
  | { kind: "request-start"; t: number; id: string }        // attributed (non-ambient) request began
  | { kind: "request-end"; t: number; id: string }
  | { kind: "mutation"; t: number }
  | { kind: "visual"; t: number }
  | { kind: "navigated"; t: number; url?: string }
  | { kind: "dialog"; t: number; detail?: string }
  | { kind: "new-target"; t: number; targetId?: string }
  | { kind: "download"; t: number };

export type Verdict = "no-effect" | "settled:network" | "settled:dom" | "settled:visual" | "still-active" | "navigated" | "dialog" | "new-target" | "download"
  | "settled:late"; // written by the background settler when a still-active action eventually quiets (act.ts backgroundSettle)

export interface SettleResult {
  verdict: Verdict;
  tSettled: number;               // when the page actually finished (last activity), not when we noticed
  tReported: number;              // when the verdict was reachable (≈ tSettled + Q for quiescence verdicts)
  navigated?: string;             // url if a navigation was part of this settlement
  timeline: Array<{ t: number; what: string }>;
  pending?: { requests: string[]; channels: string[] }; // for still-active: what is still moving
  counts: { requests: number; mutations: number; visuals: number };
}

export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
export const realClock: Clock = { now: () => performance.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as any) };

/**
 * Feed signals; resolves once. Discrete events (dialog / new-target / download) settle immediately with a
 * definitive verdict. Navigation is recorded but keeps the race open so the post-nav loading is part of the
 * report — the verdict becomes `navigated` at quiescence (see code comment vs GUIDANCE §4.2 "immediately").
 * `no-effect` fires when nothing at all happened by t0+noEffectMs. Budget expiry → `still-active` with what moves.
 */
export class Settler {
  private quietMs: number; private noEffectMs: number; private budgetMs: number; private maxBudgetMs: number; private t0: number;
  private inflight = new Set<string>();
  private lastNet = -Infinity; private lastDom = -Infinity; private lastVis = -Infinity;
  private navigatedUrl: string | null = null;
  private timeline: Array<{ t: number; what: string }> = [];
  private counts = { requests: 0, mutations: 0, visuals: 0 };
  private timer: unknown = null;
  private done = false;
  private resolve!: (r: SettleResult) => void;
  readonly result: Promise<SettleResult>;

  constructor(cfg: SettleConfig, private clock: Clock = realClock) {
    this.quietMs = cfg.quietMs ?? defaults.quietMs;
    this.noEffectMs = cfg.noEffectMs ?? defaults.noEffectMs;
    this.budgetMs = cfg.budgetMs ?? defaults.budgetMs;
    this.maxBudgetMs = cfg.maxBudgetMs ?? defaults.maxBudgetMs;
    this.t0 = cfg.t0;
    this.result = new Promise<SettleResult>((r) => (this.resolve = r));
    this.mark(this.t0, "dispatch");
    this.schedule();
  }

  /** Seed already-in-flight attributed requests (awaitSettlement after still-active). */
  seed(ids: string[]) { for (const id of ids) this.inflight.add(id); if (ids.length) { this.lastNet = this.clock.now(); this.counts.requests += ids.length; } this.schedule(); }
  extend(budgetMs: number) { this.budgetMs = this.clock.now() - this.t0 + budgetMs; this.maxBudgetMs = Math.max(this.maxBudgetMs, this.budgetMs); this.schedule(); }
  /** Resolve within `tailMs` from now whatever is in flight (a postcondition already holds: the caller only
   *  wants a short quiet tail, never the full hung-request budget). Only ever LOWERS the deadlines. */
  cap(tailMs: number) { const at = this.clock.now() - this.t0 + tailMs; this.budgetMs = Math.min(this.budgetMs, at); this.maxBudgetMs = Math.min(this.maxBudgetMs, at); this.schedule(); }

  feed(s: SettleSignal) {
    if (this.done) return;
    switch (s.kind) {
      case "request-start": this.inflight.add(s.id); this.lastNet = s.t; this.counts.requests++; if (this.counts.requests <= 3) this.mark(s.t, `req+ ${s.id}`); break;
      case "request-end": if (this.inflight.delete(s.id)) { this.lastNet = s.t; if (this.inflight.size === 0) this.mark(s.t, "net idle"); } break;
      case "mutation": this.lastDom = s.t; this.counts.mutations++; if (this.counts.mutations <= 3 || this.counts.mutations % 25 === 0) this.mark(s.t, "dom"); break;
      case "visual": this.lastVis = s.t; this.counts.visuals++; if (this.counts.visuals <= 3 || this.counts.visuals % 25 === 0) this.mark(s.t, "pixels"); break;
      case "navigated": this.navigatedUrl = s.url ?? this.navigatedUrl ?? ""; this.lastDom = s.t; this.mark(s.t, `navigated ${s.url ?? ""}`); break;
      case "dialog": return this.finish("dialog", s.t, s.t);
      case "new-target": return this.finish("new-target", s.t, s.t);
      case "download": return this.finish("download", s.t, s.t);
    }
    this.schedule();
  }

  cancel() { if (this.timer) this.clock.clearTimeout(this.timer); this.done = true; }

  private mark(t: number, what: string) { if (this.timeline.length < 14) this.timeline.push({ t: Math.round(t * 10) / 10, what }); }
  private lastActivity(): number { return Math.max(this.lastNet, this.lastDom, this.lastVis); }
  private anyActivity(): boolean { return this.counts.requests + this.counts.mutations + this.counts.visuals > 0 || this.navigatedUrl !== null; }

  /** One deadline timer, recomputed on every signal. */
  private schedule() {
    if (this.done) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    const now = this.clock.now();
    const deadlines: Array<[number, () => void]> = [];
    if (!this.anyActivity()) deadlines.push([this.t0 + this.noEffectMs, () => this.finish("no-effect", now, this.clock.now())]);
    if (this.inflight.size === 0 && this.anyActivity()) {
      const quietAt = this.lastActivity() + this.quietMs;
      deadlines.push([quietAt, () => {
        // verify still quiet (signals may have arrived and rescheduled; this closure only runs if not)
        const last = this.lastActivity();
        // Verdict = the binding signal. Network wins when attributed requests participated and stayed
        // active into the final quiet window (the render tail after the last response is expected).
        const verdict: Verdict = this.navigatedUrl !== null ? "navigated"
          : this.counts.requests > 0 && last - this.lastNet <= this.quietMs ? "settled:network"
          : last === this.lastVis && this.lastVis > this.lastDom ? "settled:visual" : "settled:dom";
        this.finish(verdict, last, this.clock.now());
      }]);
    }
    // Budget semantics (GUIDANCE §4.2, DECISIONS #16): the budget measures time since the last attributed
    // network evidence — it is suspended entirely while attributed requests are in flight (bounded by
    // maxBudgetMs, so hung requests still surface), and restarts from each response. So a 7s round trip
    // reports at ~7.3s with the default 3s budget, while unattributed churn (spinners, tickers) cannot
    // hold an action open past t0+budgetMs.
    const lastNetOrT0 = this.lastNet === -Infinity ? this.t0 : Math.max(this.t0, this.lastNet);
    const budgetAt = this.inflight.size > 0 ? this.t0 + this.maxBudgetMs : Math.min(lastNetOrT0 + this.budgetMs, this.t0 + this.maxBudgetMs);
    deadlines.push([budgetAt, () => {
      const now2 = this.clock.now();
      const channels: string[] = [];
      if (this.inflight.size) channels.push("network");
      if (now2 - this.lastDom < this.quietMs) channels.push("dom");
      if (now2 - this.lastVis < this.quietMs) channels.push("pixels");
      this.finish("still-active", now2, now2, { requests: [...this.inflight], channels });
    }]);
    deadlines.sort((a, b) => a[0] - b[0]);
    const [at, fn] = deadlines[0];
    this.timer = this.clock.setTimeout(fn, Math.max(0, at - now));
  }

  private finish(verdict: Verdict, tSettled: number, tReported: number, pending?: SettleResult["pending"]) {
    if (this.done) return;
    this.done = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.mark(tReported, `verdict:${verdict}`);
    this.resolve({ verdict, tSettled, tReported, navigated: this.navigatedUrl ?? undefined, timeline: this.timeline, pending, counts: this.counts });
  }
}
