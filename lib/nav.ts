// Layer-1 reusable moves for robust navigation (GUIDANCE §9): reach known anchor states, gate every step on
// its postcondition, and handle steps that are only *sometimes* present (conditional interstitials) without
// hanging or guessing. ONE selector language everywhere — Playwright's (role= / text= / css / xpath, >>),
// the same one click()/watch() take — and no sleeps: every wait is evidence-based with a budget and a diagnosis.
import type { Session, PageFn } from "../src/client.ts";
import type { Diagnosis, Report, UntilResult } from "../src/report.ts";

/** A state to wait for: an element (`visible`: laid out with a box), an in-page predicate (`fnArg` travels
 *  in), or a request (`landed`: response + body captured). Same shape as act()'s `until`. */
export interface Pred { selector?: string; visible?: boolean; fn?: PageFn; fnArg?: unknown; urlLike?: string; landed?: boolean }
export interface UntilOpts { budgetMs?: number; frame?: string; msg?: string }

/** Wait for evidence of a state with a short budget; throw with the diagnosis on expiry. THE postcondition
 *  move: a pack function ends every step with one — or passes the same predicate as `until` to the act
 *  itself, which additionally keeps the causality window open while waiting (preferred; DECISIONS #35).
 *  Trap: `urlLike` here only matches requests that STARTED or RESPONDED after this call — a response that already
 *  landed before you called `until()` will not match. "Act, then confirm the wire" belongs on the act as `until`,
 *  or read the store (`extractFromWire`) instead of waiting. */
export async function until(s: Session, pred: Pred, opts: UntilOpts = {}): Promise<UntilResult> {
  const r = await s.watch(pred, { budgetMs: opts.budgetMs ?? 5000, frame: opts.frame });
  if (!r.matched) throw new Error(`${opts.msg ?? `until: ${describePred(pred)} not reached`} (${r.elapsedMs}ms)${diagnosisLine(r.diagnosis)}`);
  return r;
}

/** Throw unless an act() report is actionable AND (if it carried `until`) reached its postcondition. The
 *  message carries the verdict and the diagnosis, so a failed step is an observation, not a shrug. */
export function reached<R extends Report>(r: R, what?: string): R {
  const label = what ?? `${r.kind} ${r.target?.selector ?? ""}`.trim();
  if (r.verdict === "diagnosis") throw new Error(`${label}: not actionable${diagnosisLine(r.diagnosis)}`);
  if (r.until && !r.until.matched) throw new Error(`${label}: postcondition not reached in ${r.until.elapsedMs}ms (verdict ${r.verdict})${diagnosisLine(r.until.diagnosis)}`);
  return r;
}

/** Assert an element is present AND visible within a short budget, or throw "anchor not reached" with the
 *  diagnosis. The check pack functions use to verify they arrived where they think they did. */
export async function assertVisible(s: Session, selector: string, msg?: string, opts: { frame?: string; budgetMs?: number } = {}): Promise<void> {
  await until(s, { selector, visible: true }, { budgetMs: opts.budgetMs ?? 2000, frame: opts.frame, msg: msg ?? `anchor not reached: expected ${selector} visible` });
}

/** Click a target only if it appears (visible) within a short budget; return whether it acted. Never throws
 *  on absence. This is how a defensive step handles an interstitial that is present OR absent (GUIDANCE §9,
 *  §2.4) — e.g. dismiss an allergy modal if the record happened to raise one. Budget covers *delayed*
 *  interstitials (they often appear a few hundred ms after settlement); the absent path pays it in full. */
export async function actIfPresent(s: Session, selector: string, opts: { budgetMs?: number; frame?: string } = {}): Promise<boolean> {
  const w = await s.watch({ selector, visible: true }, { budgetMs: opts.budgetMs ?? 1500, frame: opts.frame });
  if (!w.matched) return false;
  const r = await s.click(selector, { frame: opts.frame });
  return r.verdict !== "diagnosis";
}

/** Wait until a frame whose URL contains `urlLike` exists with a document, and return its id. Enterprise apps
 *  build tabs/panels as child frames that appear a beat after an action settles. (watch() re-resolves the
 *  frame per check, so `frame: urlLike` on any predicate waits for the frame too — this is the named form.) */
export async function waitForFrame(s: Session, urlLike: string, budgetMs = 8000): Promise<string> {
  await until(s, { selector: "body" }, { frame: urlLike, budgetMs, msg: `waitForFrame: no frame url contains ${JSON.stringify(urlLike)}` });
  for (const t of await s.targets()) for (const f of (t.frames ?? [])) if (f.url.includes(urlLike)) return f.frameId;
  throw new Error(`waitForFrame: frame ${JSON.stringify(urlLike)} vanished after appearing`);
}

/** After an act whose `until` was a DISJUNCTION (success OR the app's own error banner), say which one
 *  holds now: the first key whose predicate matches (one check each, no waiting), or null. The pattern:
 *    const r = await s.click("#login", { until: { fn: () => ok() || banner() } });
 *    if ((await firstOf(s, { ok: { selector: ".inventory_list" }, err: { selector: '[data-test="error"]' } })) === "err") throw new Error(await s.evaluate(() => …banner text…)); */
export async function firstOf<K extends string>(s: Session, preds: Record<K, Pred>, opts: { frame?: string } = {}): Promise<K | null> {
  for (const k of Object.keys(preds) as K[]) if ((await s.watch(preds[k], { budgetMs: 0, frame: opts.frame })).matched) return k;
  return null;
}

export const describePred = (p: Pred): string => p.selector ? `${p.selector}${p.visible ? " (visible)" : ""}` : p.urlLike ? `request ${p.urlLike}${p.landed ? " landed" : ""}` : "predicate";

/** One line of a diagnosis for error messages: reason, near-matches, what was pending. */
export function diagnosisLine(dg?: Diagnosis): string {
  if (!dg) return "";
  const bits = [dg.reason, dg.error, dg.occludedBy && `occluded by ${dg.occludedBy}`, dg.candidates?.length ? `near: ${dg.candidates.slice(0, 4).join(" | ")}` : "", dg.pendingRequests?.length ? `pending: ${dg.pendingRequests.slice(0, 3).join("; ")}` : "", dg.domActive && "dom still mutating"].filter(Boolean);
  return ` — ${bits.join("; ")}`;
}
