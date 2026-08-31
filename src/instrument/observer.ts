// In-page observer, installed in the isolated world "disco" on every frame before the page runs
// (BRIEF §1.16). It batches DOM mutations, keeps a census of visible dialogs/toasts (raw material
// for sentinels, GUIDANCE §5.3), and arms one-shot "task markers" so requests can be attributed to
// the input event's task (GUIDANCE §4.4). It talks to the daemon through the `__disco` binding.
// Written as a real TS function and shipped via .toString() — it must be fully self-contained.

export const BINDING = "__disco";
export const WORLD = "disco";

export interface ObserverMutationMsg { kind: "mutation"; t: number; count: number; added: number; removed: number; attrs: number; text: number; roots: string[]; dialogs: CensusItem[]; toasts: CensusItem[]; gone: string[] }
export interface ObserverTaskMsg { kind: "task"; id: number; type: string; t0: number; t1: number; t2: number }
export interface CensusItem { key: string; role: string; title: string; text: string; sel: string; area: number; kind: "dialog" | "toast" | "expiry" }
export type ObserverMsg = ObserverMutationMsg | ObserverTaskMsg | { kind: "ready"; t: number; url: string };

export interface Census { url: string; title: string; focused: string | null; scroll: { x: number; y: number }; dialogs: CensusItem[]; toasts: CensusItem[]; viewport: { w: number; h: number }; readyState: string }

function observerMain(bindingName: string, batchMs: number) {
  const w = window as any;
  if (w.__discoInstalled) return;
  w.__discoInstalled = true;
  const send = (msg: unknown) => { try { (w as any)[bindingName](JSON.stringify(msg)); } catch { /* binding not ready */ } };
  const nowEpoch = () => performance.timeOrigin + performance.now();

  // ---------- selectors / descriptions ----------
  const DIALOG_SEL = '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]';
  const TOAST_SEL = '[role="status"],[role="alert"],[aria-live="polite"],[aria-live="assertive"]';
  const TOASTY = /toast|snackbar|notif|growl|flash|banner/i;
  const NOT_TOAST = /^(row|gridcell|cell|columnheader|rowheader|listitem|option|treeitem|tab|menuitem)$/i; // table rows in Carbon/MUI matched the heuristic 50 times per run (P4-B friction #8)
  const notToast = (el: Element) => NOT_TOAST.test(el.getAttribute("role") || "") || !!el.closest("tr,table,[role=row],[role=grid],[role=table],[role=listbox],[role=menu],[role=tablist]");
  const EXPIRY = /session\s*(will\s*)?(expir|time[d\s-]*out|end)|inactiv|log\s*in\s*again|signed?\s*out|re-?authenticat/i;
  function cheapSel(el: Element): string {
    if (el.id) return "#" + CSS.escape(el.id);
    const cls = [...el.classList].slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
    const role = el.getAttribute("role");
    return el.tagName.toLowerCase() + cls + (role ? `[role="${role}"]` : "");
  }
  function visible(el: Element): boolean {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }
  function titleOf(el: Element): string {
    const lab = el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent) || "";
    if (lab) return lab.trim().slice(0, 120);
    const h = el.querySelector("h1,h2,h3,h4,[role=heading],.title,.header,legend");
    return (h?.textContent || "").trim().slice(0, 120);
  }
  function textOf(el: Element): string { return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240); }
  function areaFrac(el: Element): number {
    const r = (el as HTMLElement).getBoundingClientRect();
    const vw = innerWidth || 1, vh = innerHeight || 1;
    const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return (iw * ih) / (vw * vh);
  }
  let keySeq = 0;
  const keys = new WeakMap<Element, string>();
  const keyOf = (el: Element) => { let k = keys.get(el); if (!k) { k = "n" + ++keySeq; keys.set(el, k); } return k; };
  function item(el: Element, kind: CensusItem["kind"]): CensusItem {
    return { key: keyOf(el), role: el.getAttribute("role") || el.tagName.toLowerCase(), title: titleOf(el), text: textOf(el), sel: cheapSel(el), area: Math.round(areaFrac(el) * 100) / 100, kind };
  }
  // Fixed/absolute overlays covering most of the viewport count as dialogs even without ARIA.
  function isOverlay(el: Element): boolean {
    const cs = getComputedStyle(el);
    return (cs.position === "fixed" || cs.position === "absolute") && areaFrac(el) >= 0.6 && (parseInt(cs.zIndex) || 0) > 0;
  }
  function isToasty(el: Element): boolean {
    if (el.matches(TOAST_SEL)) return true;
    if (!TOASTY.test(el.className + " " + el.id)) return false;
    const cs = getComputedStyle(el);
    return cs.position === "fixed" || cs.position === "absolute";
  }
  function census(): { dialogs: CensusItem[]; toasts: CensusItem[] } {
    const dialogs: CensusItem[] = [], toasts: CensusItem[] = [];
    const seen = new Set<Element>();
    for (const el of document.querySelectorAll(DIALOG_SEL)) if (visible(el) && !seen.has(el)) { seen.add(el); dialogs.push(item(el, EXPIRY.test(textOf(el)) ? "expiry" : "dialog")); }
    // overlays: only direct children of body (cheap) plus their first child
    for (const el of document.body?.children ?? []) {
      if (seen.has(el) || !visible(el)) continue;
      if (isOverlay(el)) { seen.add(el); dialogs.push(item(el, EXPIRY.test(textOf(el)) ? "expiry" : "dialog")); continue; }
      if (isToasty(el)) { seen.add(el); if (!notToast(el)) toasts.push(item(el, "toast")); }
    }
    for (const el of document.querySelectorAll(TOAST_SEL)) if (visible(el) && !seen.has(el) && areaFrac(el) < 0.3) { seen.add(el); if (!notToast(el)) toasts.push(item(el, "toast")); }
    for (const el of document.querySelectorAll('[class*="toast" i],[class*="snackbar" i],[id*="toast" i],[class*="notification" i]')) if (visible(el) && !seen.has(el) && isToasty(el) && areaFrac(el) < 0.3) { seen.add(el); if (!notToast(el)) toasts.push(item(el, "toast")); }
    return { dialogs, toasts };
  }

  // ---------- mutation batching ----------
  let pending = 0, added = 0, removed = 0, attrs = 0, text = 0, lastT = 0, timer: any = null;
  const roots = new Set<string>();
  const reported = new Set<string>(); // census keys already announced (dialogs/toasts)
  function flush() {
    timer = null;
    const c = census();
    const newDialogs = c.dialogs.filter((d) => !reported.has(d.key));
    const newToasts = c.toasts.filter((d) => !reported.has(d.key));
    for (const d of [...newDialogs, ...newToasts]) reported.add(d.key);
    const present = new Set([...c.dialogs, ...c.toasts].map((d) => d.key));
    const gone: string[] = [];
    for (const k of reported) if (!present.has(k)) { gone.push(k); reported.delete(k); }
    const msg: ObserverMutationMsg = { kind: "mutation", t: lastT || nowEpoch(), count: pending, added, removed, attrs, text, roots: [...roots].slice(0, 8), dialogs: newDialogs, toasts: newToasts, gone };
    pending = added = removed = attrs = text = 0; roots.clear();
    send(msg);
  }
  const mo = new MutationObserver((records) => {
    lastT = nowEpoch();
    for (const r of records) {
      pending++;
      if (r.type === "childList") { added += r.addedNodes.length; removed += r.removedNodes.length; }
      else if (r.type === "attributes") attrs++;
      else text++;
      if (roots.size < 8) { const el = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement; if (el) roots.add(cheapSel(el)); }
    }
    if (!timer) timer = setTimeout(flush, batchMs);
  });
  // A typed value is a DOM state change the MutationObserver cannot see (a property, not an attribute): count
  // input/change events as activity, or a fill whose repaint falls under the visual tile threshold reads
  // `no-effect` beside a UI delta that shows the value landed (stranger #4 friction #3).
  const onInput = (ev: Event) => { lastT = nowEpoch(); pending++; text++; if (roots.size < 8 && ev.target instanceof Element) roots.add(cheapSel(ev.target)); if (!timer) timer = setTimeout(flush, batchMs); };
  document.addEventListener("input", onInput, true); document.addEventListener("change", onInput, true);
  const start = () => { mo.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true }); flush(); };
  if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });

  // ---------- task markers (attribution tier "task") ----------
  let taskSeq = 0;
  function armTask(type: string): number {
    const id = ++taskSeq;
    const onEvt = () => {
      window.removeEventListener(type, onEvt, true);
      const t0 = nowEpoch();
      let t1 = t0;
      queueMicrotask(() => { t1 = nowEpoch(); });
      setTimeout(() => { send({ kind: "task", id, type, t0, t1, t2: nowEpoch() } as ObserverTaskMsg); }, 0);
    };
    window.addEventListener(type, onEvt, true);
    setTimeout(() => window.removeEventListener(type, onEvt, true), 5000); // never leak
    return id;
  }

  // ---------- API for the daemon (Runtime.callFunctionOn in this world) ----------
  w.__discoApi = {
    census(): Census {
      const c = census();
      const f = document.activeElement;
      return { url: location.href, title: document.title, focused: f && f !== document.body ? cheapSel(f) : null, scroll: { x: scrollX, y: scrollY }, viewport: { w: innerWidth, h: innerHeight }, readyState: document.readyState, ...c };
    },
    armTask,
    flush() { if (timer) { clearTimeout(timer); flush(); } },
    animations(): Array<{ sel: string; box: number[] }> {
      const out: Array<{ sel: string; box: number[] }> = [];
      try {
        for (const a of (document as any).getAnimations?.() ?? []) {
          const el = (a.effect as any)?.target as Element | undefined;
          if (!el || a.playState !== "running") continue;
          const r = el.getBoundingClientRect();
          out.push({ sel: cheapSel(el), box: [r.left, r.top, r.width, r.height] });
          if (out.length >= 20) break;
        }
      } catch {}
      return out;
    },
  };
  send({ kind: "ready", t: nowEpoch(), url: location.href });
}

/** Source to install via Page.addScriptToEvaluateOnNewDocument (world "disco"). */
export function observerSource(batchMs: number): string {
  return `(${observerMain.toString()})(${JSON.stringify(BINDING)}, ${batchMs});`;
}
