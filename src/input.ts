// Input dispatch (BRIEF §1.9): CDP Input.* on the top-level page session, with coordinates translated
// through the frame chain (same-origin iframes and OOPIFs alike). Sequences cribbed from Playwright:
// move → down → up; dblclick = two cycles with clickCount 1 then 2; drag = down, stepped moves, up.
import type { Daemon, FrameInfo, TargetState } from "./daemon.ts";

export interface Point { x: number; y: number }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Translate a point from a frame's own viewport space to the root page target's viewport space. */
export async function pointToRoot(d: Daemon, frame: FrameInfo, p: Point): Promise<{ point: Point; root: TargetState }> {
  let f = frame; let x = p.x, y = p.y;
  for (let hops = 0; f.parentFrameId && hops < 20; hops++) {
    const parent = d.frames.get(f.parentFrameId);
    if (!parent) break;
    const parentTarget = d.targets.get(parent.targetId);
    if (!parentTarget) break;
    try {
      const { backendNodeId } = await d.send<{ backendNodeId: number }>(parentTarget, "DOM.getFrameOwner", { frameId: f.frameId });
      await d.send(parentTarget, "DOM.getDocument", { depth: 0 }).catch(() => {}); // ensure DOM agent is up
      const bm = await d.send<{ model: { content: number[] } }>(parentTarget, "DOM.getBoxModel", { backendNodeId });
      x += bm.model.content[0]; y += bm.model.content[1];
    } catch { break; }
    f = parent;
  }
  const owner = d.targets.get(f.targetId);
  const root = owner ? d.targets.get(owner.rootTargetId) ?? owner : d.primary();
  return { point: { x, y }, root };
}

const BUTTONS: Record<string, { button: string; mask: number }> = { left: { button: "left", mask: 1 }, right: { button: "right", mask: 2 }, middle: { button: "middle", mask: 4 } };

export async function clickAt(d: Daemon, root: TargetState, p: Point, opts: { button?: "left" | "right" | "middle"; clickCount?: number } = {}): Promise<void> {
  const b = BUTTONS[opts.button ?? "left"];
  const total = opts.clickCount ?? 1; // dblclick: cycles with clickCount 1 then 2
  await d.send(root, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
  for (let c = 1; c <= total; c++) {
    await d.send(root, "Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: b.button, buttons: b.mask, clickCount: c });
    await d.send(root, "Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: b.button, buttons: 0, clickCount: c });
  }
}
export async function hoverAt(d: Daemon, root: TargetState, p: Point): Promise<void> {
  await d.send(root, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
}
export async function wheelAt(d: Daemon, root: TargetState, p: Point, deltaY: number, deltaX = 0): Promise<void> {
  await d.send(root, "Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX, deltaY });
}
/** Mouse-based drag (not HTML5 DnD — see DECISIONS): down at `from`, stepped real-time moves, up at `to`. */
export async function dragFromTo(d: Daemon, root: TargetState, from: Point, to: Point, opts: { steps?: number; stepDelayMs?: number } = {}): Promise<void> {
  const steps = Math.max(2, opts.steps ?? 10);
  const delay = opts.stepDelayMs ?? 12; // rAF-driven drag handlers need real time between moves
  await d.send(root, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 });
  await d.send(root, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps, y = from.y + ((to.y - from.y) * i) / steps;
    await d.send(root, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(delay);
  }
  await d.send(root, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
}

// ---------------- keyboard ----------------
interface KeyDef { key: string; code: string; keyCode: number; text?: string; location?: number }
const NAMED: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  F1: { key: "F1", code: "F1", keyCode: 112 }, F2: { key: "F2", code: "F2", keyCode: 113 }, F5: { key: "F5", code: "F5", keyCode: 116 },
};
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
const UNSHIFTED = "`1234567890-=[]\;',./";
function charDef(ch: string): KeyDef & { shift?: boolean } {
  if (/[a-z]/.test(ch)) return { key: ch, code: "Key" + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/[A-Z]/.test(ch)) return { key: ch, code: "Key" + ch, keyCode: ch.charCodeAt(0), text: ch, shift: true };
  if (/[0-9]/.test(ch)) return { key: ch, code: "Digit" + ch, keyCode: ch.charCodeAt(0), text: ch };
  if (ch === " ") return { ...NAMED.Space };
  const si = SHIFTED.indexOf(ch);
  if (si >= 0) { const base = UNSHIFTED[si]; const d2 = charDef(base); return { ...d2, key: ch, text: ch, shift: true }; }
  const codes: Record<string, string> = { "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash" };
  if (codes[ch]) return { key: ch, code: codes[ch], keyCode: ch.charCodeAt(0), text: ch };
  return { key: ch, code: "", keyCode: 0, text: ch }; // falls back to insertText below
}
const MODS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

/** Press a key or combo ("Enter", "ArrowDown", "Control+a"). */
export async function pressKey(d: Daemon, root: TargetState, combo: string): Promise<void> {
  const parts = combo.split("+");
  const keyName = parts.pop()!;
  let modifiers = 0;
  for (const m of parts) modifiers |= MODS[m] ?? 0;
  const def = NAMED[keyName] ?? charDef(keyName.length === 1 ? keyName : keyName.toLowerCase());
  if ((def as any).shift) modifiers |= 8;
  const text = modifiers & ~8 ? undefined : def.text; // ctrl/alt combos don't produce text
  await d.send(root, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, text, unmodifiedText: text });
  await d.send(root, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode });
}

/** Type text with real per-char key events (debounced inputs count keystrokes); non-ASCII via insertText. */
export async function typeText(d: Daemon, root: TargetState, text: string, opts: { delayMs?: number } = {}): Promise<void> {
  const delay = opts.delayMs ?? 15;
  for (const ch of text) {
    const def = charDef(ch);
    if (!def.code) { await d.send(root, "Input.insertText", { text: ch }); }
    else {
      const modifiers = (def as any).shift ? 8 : 0;
      await d.send(root, "Input.dispatchKeyEvent", { type: "keyDown", modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, text: def.text, unmodifiedText: def.text });
      await d.send(root, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode });
    }
    if (delay) await sleep(delay);
  }
}
