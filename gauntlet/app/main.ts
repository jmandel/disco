/**
 * The gauntlet SPA (vanilla DOM). One page, sectioned #s-1 … #s-21; every
 * behavior (sections #s-1 … #s-26) is documented in ../scenarios.md with the
 * exact ids/text it exposes. Effective state = GET /ctl → URL query overrides → live `ctl`
 * frames over the WebSocket (last write wins).
 */
import type { CtlView } from "../server.ts";
import { mountVirtualList, type Row } from "./rows.ts";
import { mountGrid, type GridData } from "./grid.ts";
import { mountCombobox } from "./combobox.ts";

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const setText = (id: string, s: string) => { $(id).textContent = s; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, id?: string) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (id) n.id = id;
  return n;
};
async function getJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  return (await r.json()) as T;
}
const postJson = (url: string, body: unknown, method = "POST") =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// effective ctl state
// ---------------------------------------------------------------------------
let state: CtlView = {
  slowMs: 400, modal: false, modalDelayMs: 0, toastMs: 2000, saveFails: false, ambient: false,
  heartbeatMs: 5000, pollHoldMs: 3000, wsPushMs: 7000, timeoutMs: 0, rerenderOnHover: true,
  requireAuth: false, notifyPollHoldMs: 25000, xOrigin: "",
};

/** URL query → state overrides (client-local; never written back to the server). */
const QUERY_MAP: Record<string, keyof CtlView> = {
  modal: "modal", modalDelay: "modalDelayMs", slow: "slowMs", toast: "toastMs", ambient: "ambient",
  heartbeat: "heartbeatMs", timeout: "timeoutMs", rerender: "rerenderOnHover",
};
function applyQueryOverrides(base: CtlView): CtlView {
  const out: Record<string, unknown> = { ...base };
  const q = new URLSearchParams(location.search);
  for (const [param, key] of Object.entries(QUERY_MAP)) {
    const v = q.get(param);
    if (v === null) continue;
    if (typeof base[key] === "boolean") out[key] = v === "1" || v === "true";
    else if (typeof base[key] === "number" && Number.isFinite(Number(v))) out[key] = Number(v);
  }
  return out as CtlView;
}

function applyState(next: CtlView): void {
  state = next;
  setText("ctl-state", JSON.stringify(state));
  setXOrigin(state.xOrigin);
  syncAmbient();
  armIdleTimer();
}

// ---------------------------------------------------------------------------
// #6 WebSocket — opened on load; every button click (except #noop) sends an action
// ---------------------------------------------------------------------------
let ws: WebSocket | null = null;
let wsCount = 0;

function openWs(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("open", () => setText("ws-status", "open"));
  ws.addEventListener("close", () => setText("ws-status", "closed"));
  ws.addEventListener("message", (ev) => {
    wsCount++;
    setText("ws-count", String(wsCount));
    setText("ws-last", String(ev.data));
    try {
      const frame = JSON.parse(String(ev.data));
      if (frame && frame.type === "ctl" && frame.state) applyState(frame.state as CtlView);
      if (frame && frame.type === "notify") renderNotif(frame as Notif); // #23 channel (a)
    } catch { /* non-JSON frame: displayed only */ }
  });
}

function sendAction(id: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "action", id, t: Date.now() }));
}

/** Per-button wiring of the WS action frame. #noop is deliberately skipped. */
function wireAction(btn: HTMLButtonElement): void {
  if (btn.id === "noop") return;
  btn.addEventListener("click", () => sendAction(btn.id || btn.textContent || "?"));
}

// ---------------------------------------------------------------------------
// #1 Load Chart — three concurrent fetches, one slow
// ---------------------------------------------------------------------------
$("load-chart").addEventListener("click", async () => {
  setText("chart-status", "loading…");
  setText("chart", "");
  const results = await Promise.all([
    getJson(`/api/slow?ms=${state.slowMs}`),
    getJson("/api/chart/a"),
    getJson("/api/chart/b"),
  ]);
  setText("chart", `Chart loaded (${results.length} responses)`);
  setText("chart-status", "idle");
});

// ---------------------------------------------------------------------------
// #2 Records + conditional "Allergy Review Required" modal
// ---------------------------------------------------------------------------
for (const btn of document.querySelectorAll<HTMLButtonElement>("button.record")) {
  btn.addEventListener("click", () => openRecord(Number(btn.dataset.id)));
}

async function openRecord(n: number): Promise<void> {
  const rec = await getJson<Record<string, unknown>>(`/api/record/${n}`);
  const sec = $("record");
  const ul = el("ul", undefined, "record-fields");
  for (const [k, v] of Object.entries(rec)) ul.appendChild(el("li", `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`));
  sec.replaceChildren(el("h3", `Record ${n}`), ul);
  if (state.modal) setTimeout(showRecordModal, state.modalDelayMs);
}

function showRecordModal(): void {
  if (document.getElementById("record-modal")) return;
  const overlay = el("div", undefined, "record-modal");
  overlay.className = "overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "record-modal-title");
  const box = el("div");
  box.className = "modal-box";
  const ack = el("button", "Acknowledge", "modal-ack");
  ack.addEventListener("click", () => overlay.remove());
  wireAction(ack);
  box.append(
    el("h3", "Allergy Review Required", "record-modal-title"),
    el("p", "This patient has documented allergies. Review before proceeding."),
    ack,
  );
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// #3 Save — optimistic UI; the wire (status endpoint) is the truth
// ---------------------------------------------------------------------------
$("save").addEventListener("click", async () => {
  setText("save-state", "Saved ✓"); // optimistic, never reverted
  const accepted = await (await postJson("/api/save", { form: { name: "x" } })).json();
  await sleep(500);
  const status = await fetch(`/api/save/status?id=${accepted.id}`);
  showToast(status.ok ? "Saved" : "Save failed (async)", status.ok ? "ok" : "fail");
});

function showToast(msg: string, kind: "ok" | "fail"): void {
  document.getElementById("toast")?.remove();
  const t = el("div", msg, "toast");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.dataset.kind = kind;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), state.toastMs);
}

// ---------------------------------------------------------------------------
// #5 / #22 Ambient traffic: heartbeat interval + long-poll loop (ctl-gated)
// ---------------------------------------------------------------------------
let hbTimer: ReturnType<typeof setInterval> | null = null;
let hbMs = 0;
let hbCount = 0;
let pollCount = 0;
let pollAbort: AbortController | null = null;

function syncAmbient(): void {
  const on = state.ambient;
  setText("ambient-status", on ? "on" : "off");
  if (!on) {
    if (hbTimer !== null) { clearInterval(hbTimer); hbTimer = null; }
    if (pollAbort) { pollAbort.abort(); pollAbort = null; }
    return;
  }
  if (hbTimer === null || hbMs !== state.heartbeatMs) {
    if (hbTimer !== null) clearInterval(hbTimer);
    hbMs = state.heartbeatMs;
    hbTimer = setInterval(() => {
      getJson("/api/heartbeat").then(() => setText("heartbeat-count", String(++hbCount))).catch(() => {});
    }, hbMs);
  }
  if (!pollAbort) { pollAbort = new AbortController(); void pollLoop(pollAbort); }
}

async function pollLoop(ac: AbortController): Promise<void> {
  while (!ac.signal.aborted) {
    try {
      const r = await fetch("/api/poll", { signal: ac.signal });
      await r.json();
      setText("poll-count", String(++pollCount));
      // reissue immediately on return — a poll may start inside an action's causality window
    } catch {
      if (ac.signal.aborted) return;
      await sleep(1000); // server gone: back off instead of spinning
    }
  }
}

// ---------------------------------------------------------------------------
// #7 Debounced search (250 ms trailing, XHR per settled keystroke)
// ---------------------------------------------------------------------------
{
  const input = $<HTMLInputElement>("search");
  const list = $("search-results");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  input.addEventListener("input", () => {
    if (timer !== null) clearTimeout(timer);
    const q = input.value;
    if (!q) { list.replaceChildren(); return; } // empty: no request, clear list
    timer = setTimeout(() => {
      const my = ++seq;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", `/api/search?q=${encodeURIComponent(q)}`);
      xhr.onload = () => {
        if (my !== seq) return;
        const j = JSON.parse(xhr.responseText) as { hits: string[] };
        list.replaceChildren(...j.hits.map((h) => el("li", h)));
      };
      xhr.send();
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// #8 Virtualized rows
// ---------------------------------------------------------------------------
$("load-rows").addEventListener("click", async () => {
  setText("rows-count", "loading…");
  const rows = await getJson<Row[]>("/api/rows");
  mountVirtualList($("rows"), rows);
  setText("rows-count", `${rows.length} rows`);
});

// ---------------------------------------------------------------------------
// #9 Re-render race
// ---------------------------------------------------------------------------
// Replacement triggers: real pointer motion (`mousemove`) and a 100 ms interval.
// Deliberately NOT `mouseover`: Chromium fires boundary events on every hit-test
// change *before* dispatching mousedown/mouseup, so a mouseover-driven swap would
// send mousedown to a just-detached node and no `click` could ever be generated
// (no common ancestor between two detached targets). Likewise the interval pauses
// while a mouse button is held so a press/release pair never straddles a tick —
// the hostility lives in resolve→dispatch, not press→release, and the count must
// be deterministic. Counting + the WS action are delegated to the host.
{
  const host = $("rerender-host");
  let gen = 0;
  let count = 0;
  let held = false;
  const fresh = (): HTMLButtonElement => {
    const b = el("button", "Re-render me", "rerender");
    b.dataset.gen = String(++gen);
    b.addEventListener("mousemove", () => { if (state.rerenderOnHover) replace(); });
    return b; // no wireAction: the host's delegated listener sends the action
  };
  const replace = () => { host.querySelector("#rerender")?.replaceWith(fresh()); };
  host.addEventListener("mousedown", () => { held = true; });
  document.addEventListener("mouseup", () => { held = false; }, true);
  host.addEventListener("click", () => {
    setText("rerender-count", String(++count));
    sendAction("rerender");
  });
  replace(); // swap the static markup for a wired node
  setInterval(() => { if (!held) replace(); }, 100);
}

// ---------------------------------------------------------------------------
// #10 Iframes — cross-origin URL injected at runtime from ctl.xOrigin
// ---------------------------------------------------------------------------
function setXOrigin(x: string): void {
  setText("x-origin", x || "?");
  const f = $<HTMLIFrameElement>("cross-origin");
  const want = x ? `${x}/xframe.html` : "";
  if (want && f.getAttribute("src") !== want) f.src = want;
}

// ---------------------------------------------------------------------------
// #11 beforeunload / confirm / alert
// ---------------------------------------------------------------------------
{
  let armed = false;
  $("arm-unload").addEventListener("click", () => {
    if (armed) return;
    armed = true;
    window.addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "Leave the gauntlet?"; });
    setText("unload-armed", "armed");
  });
  $("confirm").addEventListener("click", () => setText("confirm-result", confirm("Proceed?") ? "confirmed" : "cancelled"));
  $("alert").addEventListener("click", () => { alert("Hello from gauntlet"); setText("alert-result", "alerted"); });
}

// ---------------------------------------------------------------------------
// #12 Session timeout (idle timer, ctl.timeoutMs, applied live)
// ---------------------------------------------------------------------------
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function armIdleTimer(): void {
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  if (state.timeoutMs > 0) {
    idleTimer = setTimeout(showSessionTimeout, state.timeoutMs);
    setText("timeout-state", `armed (${state.timeoutMs} ms)`);
  } else {
    setText("timeout-state", "off");
  }
}

function showSessionTimeout(): void {
  if (document.getElementById("session-timeout")) return;
  const overlay = el("div", undefined, "session-timeout");
  overlay.className = "overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const box = el("div");
  box.className = "modal-box";
  const stay = el("button", "Stay signed in", "stay");
  stay.addEventListener("click", () => { overlay.remove(); armIdleTimer(); });
  wireAction(stay);
  box.append(el("h3", "Session expiring"), el("p", "Your session will expire due to inactivity"), stay);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setText("timeout-state", "expired");
}

for (const ev of ["click", "keydown", "mousemove"] as const) {
  document.addEventListener(ev, () => {
    if (state.timeoutMs > 0 && !document.getElementById("session-timeout")) armIdleTimer();
  }, true);
}

// #13 #noop: intentionally no handler (and wireAction skips it).

// ---------------------------------------------------------------------------
// #14 Delete (write endpoint)
// ---------------------------------------------------------------------------
$("delete").addEventListener("click", async () => {
  const j = await getJson<{ deleted: number }>("/api/item/1", { method: "DELETE" });
  setText("delete-result", `deleted ${j.deleted}`);
});

// ---------------------------------------------------------------------------
// #15 Child window
// ---------------------------------------------------------------------------
$("open-child").addEventListener("click", () => { window.open("/child.html", "_blank"); });

// ---------------------------------------------------------------------------
// #18 Shadow DOM (open root)
// ---------------------------------------------------------------------------
{
  const root = $("shadow-host").attachShadow({ mode: "open" });
  root.innerHTML = `<style>:host{display:block;padding:6px;border:1px dashed #66c}</style>` +
    `<button id="shadow-btn">Shadow button</button> clicks: <span id="shadow-count">0</span>`;
  const btn = root.getElementById("shadow-btn") as HTMLButtonElement;
  let n = 0;
  btn.addEventListener("click", () => { root.getElementById("shadow-count")!.textContent = String(++n); });
  wireAction(btn);
}

// ---------------------------------------------------------------------------
// #19 SSE
// ---------------------------------------------------------------------------
$("start-sse").addEventListener("click", () => {
  const log = $("sse-log");
  log.replaceChildren();
  let n = 0;
  setText("sse-status", "connecting");
  const es = new EventSource("/api/sse");
  es.onopen = () => setText("sse-status", "open");
  es.onmessage = (ev) => {
    log.appendChild(el("li", String(ev.data)));
    if (++n >= 5) { es.close(); setText("sse-status", "done"); }
  };
  es.onerror = () => { es.close(); setText("sse-status", n >= 5 ? "done" : "error"); };
});

// ---------------------------------------------------------------------------
// #20 GraphQL over POST
// ---------------------------------------------------------------------------
async function gql(query: string): Promise<void> {
  const j = await (await postJson("/api/graphql", { query })).json();
  setText("gql-result", JSON.stringify(j));
}
$("gql-query").addEventListener("click", () => gql("query { patient { name } }"));
$("gql-mutate").addEventListener("click", () => gql('mutation { rename(name: "Renamed") { name } }'));

// ---------------------------------------------------------------------------
// #23 Push-channel content delivery (ws frames handled in openWs; sse + poll here)
// ---------------------------------------------------------------------------
type Notif = { n: number; via: string; text: string };
let notifCount = 0;

function renderNotif(notif: Notif): void {
  $("notif-list").appendChild(el("li", notif.text)); // text exactly as delivered
  setText("notif-count", String(++notifCount));
}

function startNotifyChannels(): void {
  // (b) persistent EventSource, held open by the server indefinitely (auto-reconnects if dropped)
  const es = new EventSource("/api/notify-sse");
  es.onmessage = (ev) => renderNotif(JSON.parse(String(ev.data)) as Notif);
  // (c) dedicated long-poll: held until a trigger or notifyPollHoldMs ({n:null}); reissue immediately either way
  void (async () => {
    for (;;) {
      try {
        const j = await getJson<Notif | { n: null }>("/api/notify-poll");
        if (j.n !== null) renderNotif(j);
      } catch {
        await sleep(1000); // server gone: back off
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// #24 Context menu (right-click only; left click must NOT open it)
// ---------------------------------------------------------------------------
{
  const target = $("ctx-target");
  const menu = $("ctx-menu");
  const hide = () => { menu.hidden = true; };
  target.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.hidden = false;
  });
  target.addEventListener("click", () => setText("ctx-result", "ctx: leftclick"));
  menu.addEventListener("click", (e) => {
    const li = (e.target as Element).closest('li[role="menuitem"]');
    if (li) { setText("ctx-result", `ctx: ${li.textContent}`); hide(); }
  });
  // any mousedown outside the menu dismisses it (right-click reopens: mousedown hides, contextmenu shows)
  document.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) hide();
  }, true);
}

// ---------------------------------------------------------------------------
// #25 Double-click to edit. The 250 ms timer confirms a SINGLE click: a dblclick
// necessarily fires click,click,dblclick, so without the delay the two clicks
// would register as "selected" before "editing".
// ---------------------------------------------------------------------------
{
  const target = $("dbl-target");
  let value = "Editable value";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let editing = false;
  target.addEventListener("click", () => {
    if (editing) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; setText("dbl-state", "selected"); }, 250);
  });
  target.addEventListener("dblclick", () => {
    if (editing) return;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    editing = true;
    setText("dbl-state", "editing");
    const input = document.createElement("input");
    input.id = "dbl-input";
    input.value = value;
    target.replaceChildren(input);
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      value = input.value;
      editing = false;
      setText("dbl-state", `committed: ${value}`);
      target.textContent = value;
    });
  });
}

// ---------------------------------------------------------------------------
// #26 Mouse drag: slider (0-100) + reorder list. Plain mouse events, no HTML5
// draggable. Each drag END posts one /api/drag-report so the wire has the result.
// ---------------------------------------------------------------------------
{
  const track = $("slider-track");
  const thumb = $("slider-thumb");
  const THUMB_W = 20;
  let value = 0;
  let dragging = false;
  const setValue = (v: number) => {
    value = Math.max(0, Math.min(100, Math.round(v)));
    thumb.style.left = `${(value / 100) * (track.clientWidth - THUMB_W)}px`;
    setText("slider-value", String(value));
  };
  thumb.addEventListener("mousedown", (e) => { e.preventDefault(); dragging = true; });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const r = track.getBoundingClientRect();
    setValue(((e.clientX - r.left - THUMB_W / 2) / (r.width - THUMB_W)) * 100); // thumb center follows pointer
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    void postJson("/api/drag-report", { widget: "slider", value });
  });
  setValue(0); // thumb starts at 0
}
{
  const list = $("sort-list");
  let dragEl: HTMLElement | null = null;
  const order = () => Array.from(list.children).map((li) => li.id.replace("sort-", "")).join(",");
  list.addEventListener("mousedown", (e) => {
    const li = (e.target as Element).closest("li");
    if (!li) return;
    e.preventDefault();
    dragEl = li as HTMLElement;
    dragEl.classList.add("dragging");
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragEl) return;
    // move the dragged item when the pointer's Y crosses a sibling's midpoint
    for (const sib of Array.from(list.children) as HTMLElement[]) {
      if (sib === dragEl) continue;
      const r = sib.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const dr = dragEl.getBoundingClientRect();
      if (dr.top > r.top && e.clientY < mid) { list.insertBefore(dragEl, sib); setText("sort-order", order()); }
      else if (dr.top < r.top && e.clientY > mid) { list.insertBefore(dragEl, sib.nextSibling); setText("sort-order", order()); }
    }
  });
  document.addEventListener("mouseup", () => {
    if (!dragEl) return;
    dragEl.classList.remove("dragging");
    dragEl = null;
    void postJson("/api/drag-report", { widget: "sort", order: order() });
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  // per-button WS action wiring for every static button (dynamic ones wire themselves)
  for (const b of document.querySelectorAll<HTMLButtonElement>("button")) {
    if (b.id === "rerender") continue; // #9 wires its action via the host's delegated listener
    wireAction(b);
  }

  const base = await getJson<CtlView>("/ctl");
  applyState(applyQueryOverrides(base));
  openWs();
  startNotifyChannels(); // #23 standing channels, live from load

  // #16 canvas grid
  mountGrid($<HTMLCanvasElement>("grid"), await getJson<GridData>("/api/grid"));

  // #17 combobox
  mountCombobox(
    $<HTMLInputElement>("med"),
    $<HTMLUListElement>("med-list"),
    $("med-selected"),
    (q) => getJson<{ hits: string[] }>(`/api/meds?q=${encodeURIComponent(q)}`).then((j) => j.hits),
  );
}

void boot();
