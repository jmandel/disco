// Bridge to the vendored Playwright InjectedScript (BRIEF §1.8): selector resolution (role=/text=/css=/
// xpath=/label, >> chaining, shadow-piercing), ariaSnapshot for semantic UI deltas, hit-target checks,
// generateSelector for diagnoses. One instance per execution context, cached, in the "disco" world.
import { injectedScriptSource, playwrightVersion } from "./vendor/injected-script.ts";
import type { Daemon, FrameInfo, TargetState } from "./daemon.ts";
import { RpcError } from "./rpc.ts";

export { playwrightVersion };

const OPTIONS = { isUnderTest: false, sdkLanguage: "javascript", frameSeq: 0, testIdAttributeName: "data-testid", stableRafCount: 1, browserName: "chromium", shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: [] as unknown[] };
const BOOTSTRAP = `(() => {\nconst module = {};\n${injectedScriptSource}\nreturn new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(OPTIONS)});\n})()`;

export interface Resolved { objectId: string; count: number; preview: string; generated: string | null; box: { x: number; y: number; w: number; h: number } | null; frameId: string }
export interface ResolveFailure { count: number; error: string; candidates: string[] }

export class Selectors {
  private cache = new Map<number, string>(); // executionContextId → injected objectId
  constructor(private d: Daemon) {}

  private async instance(frame: FrameInfo): Promise<{ objectId: string; ctx: number; target: TargetState }> {
    const ctx = await this.d.ensureObserver(frame.frameId);
    const target = this.d.targetOfFrame(frame);
    let objectId = this.cache.get(ctx);
    if (!objectId) {
      const r = await this.d.send<{ result: { objectId?: string }; exceptionDetails?: any }>(target, "Runtime.evaluate", { expression: BOOTSTRAP, contextId: ctx, returnByValue: false });
      if (r.exceptionDetails || !r.result.objectId) throw new RpcError(-32011, `injected script bootstrap failed: ${r.exceptionDetails?.exception?.description ?? "no object"}`);
      objectId = r.result.objectId;
      this.cache.set(ctx, objectId);
    }
    return { objectId, ctx, target };
  }
  invalidateContext(ctx: number) { this.cache.delete(ctx); }

  private async call<T>(frame: FrameInfo, fn: string, args: unknown[], returnByValue = true): Promise<{ value?: T; objectId?: string }> {
    for (let attempt = 0; ; attempt++) {
      const { objectId, ctx, target } = await this.instance(frame);
      try {
        const res = await this.d.send<{ result: any; exceptionDetails?: any }>(target, "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: args.map((a) => ({ value: a })), returnByValue, awaitPromise: true });
        if (res.exceptionDetails) throw new RpcError(-32012, `injected call failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
        return returnByValue ? { value: res.result.value as T } : { objectId: res.result.objectId as string };
      } catch (e) {
        // context died (navigation): drop the cached instance and retry once against the fresh context
        const msg = String((e as Error).message ?? e);
        if (attempt === 0 && /Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(msg)) { this.cache.delete(ctx); const fr = this.d.frames.get(frame.frameId); if (fr) { fr.contexts.delete("disco"); fr.observerReady = false; } continue; }
        throw e;
      }
    }
  }

  /** Resolve a Playwright selector in a frame. Non-strict: first match wins, count reported. */
  async resolve(frame: FrameInfo, selector: string): Promise<Resolved | ResolveFailure> {
    const info = await this.call<{ n: number; preview?: string; box?: number[]; visible?: boolean }>(frame,
      `function (sel) {
        const p = this.parseSelector(sel);
        const els = this.querySelectorAll(p, document);
        if (!els.length) return { n: 0 };
        const el = els[0];
        const r = el.getBoundingClientRect();
        return { n: els.length, preview: this.previewNode(el), box: [r.x, r.y, r.width, r.height] };
      }`, [selector]);
    const v = info.value!;
    if (!v.n) return { count: 0, error: `no element matches ${JSON.stringify(selector)}`, candidates: await this.candidates(frame, selector) };
    const handle = await this.call(frame, `function (sel) { return this.querySelectorAll(this.parseSelector(sel), document)[0]; }`, [selector], false);
    let generated: string | null = null;
    try { generated = (await this.call<string>(frame, `function (sel) { const el = this.querySelectorAll(this.parseSelector(sel), document)[0]; return this.generateSelector(el, { testIdAttributeName: "data-testid" }).selector; }`, [selector])).value ?? null; } catch {}
    const b = v.box!;
    return { objectId: handle.objectId!, count: v.n, preview: v.preview ?? "", generated, box: { x: b[0], y: b[1], w: b[2], h: b[3] }, frameId: frame.frameId };
  }

  /** Fuzzy near-matches for a failed selector (GUIDANCE §2.2): relax the selector, sample interactives. */
  async candidates(frame: FrameInfo, selector: string): Promise<string[]> {
    const relaxed: string[] = [];
    const m = selector.match(/^(role=[\w]+)/); if (m) relaxed.push(m[1]);
    const t = selector.match(/(?:name|text)\s*=\s*"?([^"\]]{3,40})/); if (t) relaxed.push(`text=${t[1].split(/\s+/)[0]}`);
    relaxed.push('role=button', 'role=link');
    try {
      const r = await this.call<string[]>(frame,
        `function (sels) {
          const out = new Set();
          for (const sel of sels) {
            try { for (const el of this.querySelectorAll(this.parseSelector(sel), document).slice(0, 6)) out.add(this.previewNode(el)); } catch {}
            if (out.size >= 10) break;
          }
          return [...out].slice(0, 10);
        }`, [relaxed]);
      return r.value ?? [];
    } catch { return []; }
  }

  /** Aria snapshot of a frame's body — the semantic surface for UI deltas (GUIDANCE §4.3). */
  async ariaSnapshot(frame: FrameInfo): Promise<string> {
    const r = await this.call<string>(frame, `function () { return document.body ? this.ariaSnapshot(document.body, { mode: "expect" }) : ""; }`, []);
    return r.value ?? "";
  }

  /** Where would a click at the element's center actually land? "ok" or a description of the occluder. */
  async hitCheck(frame: FrameInfo, selector: string): Promise<{ ok: boolean; point?: { x: number; y: number }; hit?: string; scrolled?: boolean }> {
    const r = await this.call<{ ok: boolean; x?: number; y?: number; hit?: string; err?: string; scrolled?: boolean }>(frame,
      `function (sel) {
        const el = this.querySelectorAll(this.parseSelector(sel), document)[0];
        if (!el) return { ok: false, err: "gone" };
        const before = el.getBoundingClientRect();
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        const scrolled = Math.abs(r.y - before.y) > 1 || Math.abs(r.x - before.x) > 1;
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const res = this.expectHitTarget({ x, y }, el);
        if (res === "done") return { ok: true, x, y, scrolled };
        return { ok: false, x, y, scrolled, hit: res && res.hitTargetDescription ? res.hitTargetDescription : String(res) };
      }`, [selector]);
    const v = r.value!;
    if (v.err === "gone") throw new RpcError(-32013, "element detached during hit check");
    return { ok: v.ok, point: v.x !== undefined ? { x: v.x, y: v.y! } : undefined, hit: v.hit, scrolled: v.scrolled };
  }

  /** Element state probe (visible/enabled/editable) via injected elementState. */
  async state(frame: FrameInfo, selector: string, state: "visible" | "hidden" | "enabled" | "disabled" | "editable"): Promise<boolean> {
    const r = await this.call<{ matches?: boolean; received?: unknown }>(frame,
      `function (sel, st) { const el = this.querySelectorAll(this.parseSelector(sel), document)[0]; if (!el) return { matches: false }; const s = this.elementState(el, st); return { matches: s.matches !== undefined ? s.matches : !!s }; }`, [selector, state]);
    return !!r.value?.matches;
  }
}

/** Line-based semantic diff of two aria snapshots: added / removed lines (indentation stripped), capped. */
export function ariaDiff(pre: string, post: string, cap = 24): { added: string[]; removed: string[]; addedMore: number; removedMore: number } {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const raw of s.split("\n")) { let l = raw.trim(); if (!l || l === "-") continue; if (l.length > 160) l = l.slice(0, 157) + "…"; m.set(l, (m.get(l) ?? 0) + 1); } // 160-char cap (review F7)
    return m;
  };
  const a = count(pre), b = count(post);
  const added: string[] = [], removed: string[] = [];
  for (const [l, n] of b) { const d = n - (a.get(l) ?? 0); for (let i = 0; i < d; i++) added.push(l); }
  for (const [l, n] of a) { const d = n - (b.get(l) ?? 0); for (let i = 0; i < d; i++) removed.push(l); }
  return { added: added.slice(0, cap), removed: removed.slice(0, cap), addedMore: Math.max(0, added.length - cap), removedMore: Math.max(0, removed.length - cap) };
}
