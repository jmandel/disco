// look: the screen as the agent needs to see it. The aria tree, a screenshot with numbered marks (rendered in a
// scratch page of ours — the app's page is never touched), and a durable selector per control. With a selector:
// what it matches, where, and what is really under the pointer.
import type { BrowserContext, Locator, Page } from "playwright-core";
import type { Store } from "./store.ts";
import type { Recorder } from "./record.ts";

/** A marks screenshot is the whole page, up to this many pixels tall. */
const MARKS_MAX_H = 4000;
export interface Box { x: number; y: number; w: number; h: number }
export interface Control { n: number; selector: string; role: string; name: string; box: Box; disabled?: boolean; /** parked outside the page's box: visible to Playwright, not to a user */ offCanvas?: boolean }
export interface Match {
  n: number; selector: string; tag: string; role: string; name: string; text: string; box: Box | null;
  visible: boolean; enabled: boolean; inViewport: boolean;
  /** what receives the pointer at the centre instead of this element (an overlay, a dialog, a toast) */
  under: string | null;
  /** why a real click could not land, when it could not */
  why?: string;
}
export interface Look {
  url: string;
  /** whole-screen look */
  aria?: string; controls?: Control[];
  /** selector look */
  selector?: string; count?: number; matches?: Match[]; error?: string;
  note?: string;
  dialogs: string[];
  /** path of the marked-up screenshot (a JPEG the agent can view) */
  shot: string | null;
}
export interface LookCtx { page: Page; context: BrowserContext; store: Store; recorder: Recorder; current: () => string | null }

const CONTROLS = 'button,a,input,select,textarea,summary,[contenteditable],[tabindex],[onclick],[draggable="true"],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="searchbox"],[role="slider"],[role="spinbutton"],[role="treeitem"]';

/** Runs in the page: every visible interactive control with what look needs to name it and to build a durable selector. */
function pageControls(_el: Element, sel: string) {
  const out: Array<{ tag: string; role: string; name: string; weak: boolean; id: string; test: string | null; disabled: boolean; offCanvas: boolean; box: { x: number; y: number; w: number; h: number }; css: string }> = [];
  // off-canvas = parked left of or above the page, or right of its width (a closed drawer, a slid-out panel); below the fold is not off-canvas
  const docW = Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth, document.body?.scrollWidth ?? 0);
  // text as an accessible name sees it: aria-hidden subtrees skipped, images by alt, nested aria-labels honoured
  const text = (n: Node): string => {
    if (n.nodeType === 3) return n.textContent ?? "";
    if (n.nodeType !== 1) return "";
    const e = n as HTMLElement;
    if (e.getAttribute("aria-hidden") === "true") return "";
    if (e.getAttribute("aria-label")) return " " + e.getAttribute("aria-label") + " ";
    if (e.tagName === "IMG" || e.tagName === "SVG") return " " + (e.getAttribute("alt") || e.getAttribute("aria-label") || "") + " ";
    const st = getComputedStyle(e); if (st.display === "none" || st.visibility === "hidden") return "";
    return Array.from(e.childNodes).map(text).join("");
  };
  const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  const nameOf = (h: HTMLElement): { name: string; weak: boolean } => {
    const strong = norm(h.getAttribute("aria-label") || (h.getAttribute("aria-labelledby") ? Array.from(h.getAttribute("aria-labelledby")!.split(/\s+/)).map((i) => document.getElementById(i)?.textContent ?? "").join(" ") : "") || (h.id ? text(document.querySelector(`label[for="${CSS.escape(h.id)}"]`) ?? document.createTextNode("")) : "") || (h.closest("label") ? text(h.closest("label")!) : "") || text(h));
    if (strong) return { name: strong, weak: false };
    return { name: norm((h as HTMLInputElement).placeholder || (h as HTMLInputElement).value || h.getAttribute("title") || h.getAttribute("alt") || ""), weak: true };
  };
  const roleOf = (h: HTMLElement) => {
    const tag = h.tagName.toLowerCase(); const type = (h.getAttribute("type") || "").toLowerCase();
    return h.getAttribute("role") || (tag === "button" || tag === "summary" ? "button" : tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "input" ? (type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "submit" || type === "button" || type === "reset" ? "button" : type === "range" ? "slider" : type === "number" ? "spinbutton" : type === "search" ? "searchbox" : "textbox") : h.isContentEditable ? "textbox" : h.getAttribute("draggable") === "true" ? "draggable" : "clickable");
  };
  // walk open shadow roots too: a button inside a web component is a control like any other
  const collect = (root: Document | ShadowRoot | Element, out: Element[]) => {
    for (const el of Array.from(root.querySelectorAll(sel))) out.push(el);
    for (const host of Array.from(root.querySelectorAll("*"))) if (host.shadowRoot) collect(host.shadowRoot, out);
  };
  const found: Element[] = []; collect(document, found);
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.body && parts.length < 5; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id && !/\d{3,}|^:|^r[a-z0-9]{1,3}:|[0-9a-f]{8}-/.test(e.id)) { parts.unshift(`${p}#${CSS.escape(e.id)}`); break; }
      const sibs = Array.from(e.parentElement?.children ?? []).filter((c) => c.tagName === e!.tagName);
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(e) + 1})`;
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const seen = new Set<Element>();
  for (const el of found) {
    if (seen.has(el)) continue; seen.add(el);
    const h = el as HTMLElement;
    if (h.getAttribute("tabindex") === "-1" && !h.matches('button,a,input,select,textarea,summary,[role],[onclick],[contenteditable]')) continue;
    const r = h.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const st = getComputedStyle(h);
    if (st.visibility === "hidden" || st.display === "none") continue;
    const test = h.getAttribute("data-test") ? `[data-test="${h.getAttribute("data-test")}"]` : h.getAttribute("data-testid") ? `[data-testid="${h.getAttribute("data-testid")}"]` : h.getAttribute("data-cy") ? `[data-cy="${h.getAttribute("data-cy")}"]` : h.getAttribute("data-qa") ? `[data-qa="${h.getAttribute("data-qa")}"]` : null;
    const bx = Math.round(r.left + scrollX), by = Math.round(r.top + scrollY);
    const nm = nameOf(h);
    out.push({ tag: h.tagName.toLowerCase(), role: roleOf(h), name: nm.name, weak: nm.weak, id: h.id, test, disabled: (h as HTMLButtonElement).disabled === true || h.getAttribute("aria-disabled") === "true", offCanvas: bx + r.width <= 0 || by + r.height <= 0 || bx >= docW, box: { x: bx, y: by, w: Math.round(r.width), h: Math.round(r.height) }, css: cssPath(h) });
    if (out.length >= 80) break;
  }
  return out;
}

/** Runs in the page on one element: what a real pointer click at its centre would hit, and why it might not land. */
function pageHit(node: Element) {
  const d = (e: Element) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const h = node as HTMLElement;
  const r = node.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const vw = Math.min(innerWidth, document.documentElement.clientWidth || innerWidth), vh = Math.min(innerHeight, document.documentElement.clientHeight || innerHeight);
  const out: { tag: string; text: string; box: { x: number; y: number; w: number; h: number } | null; inViewport: boolean; under: string | null; why?: string } = {
    tag: node.tagName.toLowerCase(), text: (h.innerText || (h as HTMLInputElement).value || "").trim().replace(/\s+/g, " ").slice(0, 80),
    box: r.width || r.height ? { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) } : null,
    inViewport: !(r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw), under: null,
  };
  if (!out.box) return out;
  if (!out.inViewport) {
    let fixed: Element | null = node; while (fixed && getComputedStyle(fixed).position !== "fixed") fixed = fixed.parentElement;
    out.why = `outside the ${vw}×${vh} viewport (page position ${Math.round(r.left + scrollX)}, ${Math.round(r.top + scrollY)}; scrolled to ${Math.round(scrollY)})${fixed ? `; ${d(fixed)} is position: fixed, so scrolling cannot bring it in — open whatever slides it in, or dispatchEvent("click")` : " — scroll it into view (locator.scrollIntoViewIfNeeded) or open whatever slides it in; a panel parked off-canvas still counts as visible"}`;
    return out;
  }
  for (let e: Element | null = node; e; e = e.parentElement) if (getComputedStyle(e).pointerEvents === "none") { out.why = `ignores the mouse: pointer-events: none on ${d(e)} — the app wants the keyboard (pressSequentially / ArrowDown / Enter), or dispatchEvent("click")`; return out; }
  let t = document.elementFromPoint(x, y);
  while (t && t.shadowRoot) { const inner = t.shadowRoot.elementFromPoint(x, y); if (!inner || inner === t) break; t = inner; }
  if (!t || node.contains(t)) return out;
  if (t.contains(node)) { out.under = d(t); out.why = `the pointer lands on its ancestor ${d(t)} — a click still reaches this element through it`; return out; }
  const label = node.closest("label") || (node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null);
  if (label && (label.contains(t) || t === label)) { out.under = d(t); out.why = `a styled control: the real input hides under ${d(t)} in its own <label> — click the label, or click with { force: true }`; return out; }
  out.under = d(t);
  out.why = `covered by ${d(t)}`;
  return out;
}

export function dialogCensus(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]'))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const labelled = el.getAttribute("aria-labelledby");
      const name = (el.getAttribute("aria-label") || (labelled ? labelled.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ") : "")).trim();
      const heading = el.querySelector("h1,h2,h3,h4,[role=heading]")?.textContent?.trim() || (el as HTMLElement).innerText?.trim().slice(0, 80) || "";
      // an unnamed dialog is `dialog:` in the aria tree — getByRole("dialog") without a name reaches it; the heading is only shown
      out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${(name || heading).slice(0, 80)}"${name ? "" : " (unnamed: getByRole(\"dialog\") without { name }; the heading is shown)"}`);
    }
    return out;
  }).catch(() => []);
}

function esc(s: string): string { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

/** Durable selectors for a list of controls: data-test, a non-generated id, a unique role+name, else a css path. Uniqueness is verified against the live page. */
async function durable(page: Page, items: Array<{ role: string; name: string; id: string; test: string | null; css: string }>): Promise<string[]> {
  const byRoleName = new Map<string, number>();
  for (const c of items) byRoleName.set(`${c.role}|${c.name}`, (byRoleName.get(`${c.role}|${c.name}`) ?? 0) + 1);
  return Promise.all(items.map(async (c) => {
    if (c.test) return c.test;
    if (c.id && !/\d{3,}|^:|^r[a-z0-9]{1,3}:|[0-9a-f]{8}-/.test(c.id)) return `#${cssEscape(c.id)}`;
    if (c.name && byRoleName.get(`${c.role}|${c.name}`) === 1) {
      const sel = `role=${c.role}[name="${esc(c.name)}"]`;
      if ((await page.locator(sel).count().catch(() => 0)) === 1) return sel;
      // the accessible name may carry an icon's whitespace (" Add ") that the exact form misses: anchor a regex instead
      const rx = `role=${c.role}[name=/^\\s*${c.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$/i]`;
      if ((await page.locator(rx).count().catch(() => 0)) === 1) return rx;
    }
    return c.css;
  }));
}
function cssEscape(s: string): string { return s.replace(/([^\w-])/g, "\\$1"); }

/** Every visible control, numbered, with its durable selector (also the `candidates` of a not-found diagnosis). */
export async function controls(page: Page, base: Page | Locator = page): Promise<Control[]> {
  const raw = (await (base === page ? page.locator("body") : (base as Locator)).evaluate(pageControls as any, CONTROLS).catch(() => [])) as ReturnType<typeof pageControls>;
  // a name that came only from a placeholder/value/title is weak: ask Playwright's accessibility view for the real one (bounded to 20 controls)
  let asked = 0;
  for (const c of raw) {
    if (!c.weak || asked >= 20 || !c.css) continue; asked++;
    const snap = await page.locator(c.css).first().ariaSnapshot({ timeout: 500 }).catch(() => "");
    const m = snap.split("\n")[0]?.match(/^-\s+([a-z]+)\s+"((?:[^"\\]|\\.)*)"/);
    if (m && m[2]) { c.name = m[2].slice(0, 60); c.role = m[1]; }
  }
  const sels = await durable(page, raw);
  return raw.map((c, i) => ({ n: i + 1, selector: sels[i], role: c.role, name: c.name, box: c.box, ...(c.disabled ? { disabled: true } : {}), ...(c.offCanvas ? { offCanvas: true } : {}) }));
}

/** One element: visible/enabled per Playwright, and what is really under the pointer. */
export async function inspect(page: Page, el: Locator): Promise<Omit<Match, "n" | "selector" | "role" | "name">> {
  const [visible, enabled, hit] = await Promise.all([
    el.isVisible().catch(() => false), el.isEnabled().catch(() => false),
    el.evaluate(pageHit as any).catch((e: Error) => ({ tag: "?", text: "", box: null, inViewport: false, under: null, why: /detached|not attached|not connected/i.test(String(e?.message)) ? "detached: the app replaced this element while it was being inspected — it re-renders continuously; dispatchEvent(\"click\") lands where a mouse click cannot" : undefined })) as Promise<ReturnType<typeof pageHit>>,
  ]);
  const out: Omit<Match, "n" | "selector" | "role" | "name"> = { tag: hit.tag, text: hit.text, box: hit.box, visible, enabled, inViewport: hit.inViewport, under: hit.under };
  if (hit.why) out.why = hit.why;
  return out;
}

/** The screenshot with numbered boxes, rendered in a scratch page (never in the app's page). Returns the JPEG path, or null. */
async function marks(ctx: LookCtx, boxes: Array<{ n: number; box: Box }>, reason: string): Promise<{ hash: string; path: string } | null> {
  const { page, context, store } = ctx;
  // the whole page (capped at 4000 px tall), in document coordinates — marks below the fold exist too
  const dims = await page.evaluate(() => ({ width: Math.max(document.documentElement.clientWidth, 320), height: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight, 200) })).catch(() => ({ width: 1280, height: 900 }));
  const vp = { width: Math.min(dims.width, 4000), height: Math.min(dims.height, MARKS_MAX_H) };
  let jpeg: Buffer;
  try { jpeg = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: vp.height } }); } catch { return null; }
  const divs = boxes.map(({ n, box }) => `<div class=b style="left:${box.x}px;top:${box.y}px;width:${Math.max(box.w, 4)}px;height:${Math.max(box.h, 4)}px"><i style="${box.y < 18 ? "top:0" : ""}">${n}</i></div>`).join("");
  const html = `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#fff;overflow:hidden}img{position:absolute;left:0;top:0}.b{position:absolute;border:2px solid #e5232f;box-sizing:border-box;border-radius:2px}.b i{position:absolute;left:-2px;top:-18px;background:#e5232f;color:#fff;font:bold 12px/16px system-ui,sans-serif;font-style:normal;padding:0 4px;border-radius:2px;white-space:nowrap}</style><img src="data:image/jpeg;base64,${jpeg.toString("base64")}" width=${vp.width} height=${vp.height}>${divs}`;
  let scratch: Page | null = null;
  try {
    scratch = await context.newPage();
    ctx.recorder.ignore(scratch);
    await scratch.setViewportSize(vp);
    await scratch.goto("data:text/html;base64," + Buffer.from(html).toString("base64"), { waitUntil: "load", timeout: 5000 });
    const out = await scratch.screenshot({ type: "jpeg", quality: 70 });
    const hash = store.writeBlob(new Uint8Array(out), ".jpg");
    store.insert("shots", { t: store.now(), hash, reason, url: page.url(), action_id: ctx.current() });
    return { hash, path: store.blobFile(hash) };
  } catch { return null; } finally {
    if (scratch) await scratch.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  }
}

export function selectorNote(sel: string): string | undefined {
  const notes: string[] = [];
  if (/:has-text\(/.test(sel)) notes.push('`:has-text()` is a case-sensitive substring match ("armed" matches "unarmed"); `:text-is()` for the whole string');
  if (/(^|>>\s*)text=[^"'/]/.test(sel)) notes.push("`text=foo` is a case-insensitive substring; `text=\"foo\"` is exact");
  if (/^[^>]*\b(role|text|xpath|id)=.*,\s*[#.\[a-z]/.test(sel)) notes.push("a comma cannot join different engines; use one engine per segment, or two look calls");
  return notes.length ? notes.join("; ") : undefined;
}

export async function lookAt(ctx: LookCtx, target?: string | Locator, o: { shot?: boolean } = {}): Promise<Look> {
  const { page } = ctx;
  const url = safe(() => page.url(), "");
  const dialogs = await dialogCensus(page);
  if (target === undefined) {
    const [aria, cs] = await Promise.all([page.locator("body").ariaSnapshot({ timeout: 5000 }).catch((e: Error) => `(aria snapshot failed: ${firstLine(e)})`), controls(page)]);
    const shot = o.shot === false ? null : await marks(ctx, cs.map((c) => ({ n: c.n, box: c.box })), "look");
    return { url, aria, controls: cs, dialogs, shot: shot?.path ?? null };
  }
  const selector = typeof target === "string" ? target : String(target);
  const loc = typeof target === "string" ? page.locator(target) : target;
  let count: number;
  try { count = await loc.count(); } catch (e) { return { url, selector, error: `selector error: ${firstLine(e)}`, note: selectorNote(selector), dialogs, shot: null }; }
  const items = await Promise.all(Array.from({ length: Math.min(count, 10) }, (_, i) => inspect(page, loc.nth(i))));
  const raw = await Promise.all(Array.from({ length: Math.min(count, 10) }, (_, i) => loc.nth(i).evaluate((h: HTMLElement) => {
    const roleOf = () => { const tag = h.tagName.toLowerCase(); const type = (h.getAttribute("type") || "").toLowerCase(); return h.getAttribute("role") || (tag === "button" || tag === "summary" ? "button" : tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "input" ? (type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "submit" || type === "button" ? "button" : "textbox") : tag); };
    const text = (n: Node): string => { if (n.nodeType === 3) return n.textContent ?? ""; if (n.nodeType !== 1) return ""; const e = n as HTMLElement; if (e.getAttribute("aria-hidden") === "true") return ""; if (e.getAttribute("aria-label")) return " " + e.getAttribute("aria-label") + " "; if (e.tagName === "IMG" || e.tagName === "SVG") return " " + (e.getAttribute("alt") || "") + " "; return Array.from(e.childNodes).map(text).join(""); };
    const name = (h.getAttribute("aria-label") || (h.id ? text(document.querySelector(`label[for="${CSS.escape(h.id)}"]`) ?? document.createTextNode("")) : "") || text(h) || (h as HTMLInputElement).placeholder || (h as HTMLInputElement).value || h.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const test = h.getAttribute("data-test") ? `[data-test="${h.getAttribute("data-test")}"]` : h.getAttribute("data-testid") ? `[data-testid="${h.getAttribute("data-testid")}"]` : null;
    const parts: string[] = [];
    for (let e: Element | null = h; e && e !== document.body && parts.length < 5; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id && !/\d{3,}|^:|^r[a-z0-9]{1,3}:|[0-9a-f]{8}-/.test(e.id)) { parts.unshift(`${p}#${CSS.escape(e.id)}`); break; }
      const sibs = Array.from(e.parentElement?.children ?? []).filter((c) => c.tagName === e!.tagName);
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(e) + 1})`;
      parts.unshift(p);
    }
    return { role: roleOf(), name, id: h.id, test, css: parts.join(" > ") };
  }).catch(() => ({ role: "?", name: "", id: "", test: null, css: "" }))));
  const sels = await durable(page, raw);
  const matches: Match[] = items.map((m, i) => ({ n: i + 1, selector: sels[i], role: raw[i].role, name: raw[i].name, ...m }));
  const shot = o.shot === false || !matches.some((m) => m.box) ? null : await marks(ctx, matches.filter((m) => m.box).map((m) => ({ n: m.n, box: m.box! })), "look");
  const note = selectorNote(selector) ?? (count === 0 ? "nothing matches; the whole-screen look lists every visible control with a selector that pastes" : count > 1 ? "several match — page.locator(...) acts on the first; pick a durable selector from the matches" : undefined);
  return { url, selector, count, matches, note, dialogs, shot: shot?.path ?? null };
}

/** Rebuild a Locator from the description Playwright prints in its own error messages, e.g. locator('#save') or getByRole('button', { name: 'Save' }). */
export function locatorFromDescription(page: Page, desc: string): Locator | null {
  if (!/^(locator|getBy[A-Z][a-zA-Z]*|frameLocator)\(/.test(desc)) return null;
  try { return new Function("page", `return page.${desc};`)(page) as Locator; } catch { return null; }
}

function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
function firstLine(e: unknown): string { return String((e as any)?.message ?? e).split("\n")[0].slice(0, 300); }
