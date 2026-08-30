// Layer-1 reusable moves for robust navigation (GUIDANCE §9): reach known anchor states, and handle
// steps that are only *sometimes* present (conditional interstitials) without hanging or guessing.
import type { Session } from "../src/client.ts";

/** Assert an element is present & visible, or throw with a clear "anchor not reached" message.
 *  The building block product functions use to verify they arrived where they think they did. */
export async function assertVisible(s: Session, selector: string, msg?: string, opts: { frame?: string } = {}): Promise<void> {
  const ok = await s.evaluate<boolean>(
    (sel: string) => { const el = document.querySelector(sel); if (!el) return false; const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 1 && r.height > 1; },
    { args: [selector], frame: opts.frame },
  );
  if (!ok) throw new Error(msg ?? `anchor not reached: expected ${selector} visible`);
}

/** Click a target only if it appears within a short budget; return whether it acted. Never throws on
 *  absence. This is how a defensive step handles an interstitial that is present OR absent (GUIDANCE §9,
 *  §2.4) — e.g. dismiss an allergy modal if the record happened to raise one. Budget covers *delayed*
 *  interstitials (they often appear a few hundred ms after settlement); the absent path pays it in full. */
export async function actIfPresent(s: Session, selector: string, opts: { budgetMs?: number; frame?: string } = {}): Promise<boolean> {
  const w = await s.watch({ selector }, { budgetMs: opts.budgetMs ?? 1500, frame: opts.frame });
  if (!w.matched) return false;
  const r = await s.click(selector, { frame: opts.frame });
  return r.verdict !== "diagnosis";
}

/** Wait until some frame (in the primary target's tree) has a URL containing `urlLike`; return its id.
 *  Enterprise apps build tabs/panels as child frames that appear a beat after an action settles. */
export async function waitForFrame(s: Session, urlLike: string, budgetMs = 8000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const targets = await s.targets();
    for (const t of targets) for (const f of (t.frames ?? [])) if (f.url.includes(urlLike)) return f.frameId;
    if (Date.now() - t0 > budgetMs) throw new Error(`waitForFrame: no frame url contains ${JSON.stringify(urlLike)} within ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
