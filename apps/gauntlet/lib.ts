// apps/gauntlet/lib.ts — the gauntlet's workflows as functions.
// Rules kept throughout: anchor in -> anchor out, an `until` on every transition,
// facts read from the wire when they travel on it, `reached()` on every step.
import { reached, type Session } from "../../src/index.ts";

export const HOME = "http://localhost:4800/";

/** Cheap anchors: URL + one specific element. */
export const anchors = {
  home:   { url: "/",             el: "#load-chart" },
  away:   { url: "/away.html",    el: "a#back" },
  login:  { url: "/login.html",   el: "#login" },
  secure: { url: "/secure.html",  el: "#who" },
  child:  { url: "/child.html",   el: "#child-fetch" },
};

/** Aria noise the header emits on almost every act. */
export const uiIgnore = [/ws: open/, /ws: closed/, /last ws frame/, /effective ctl/, /heartbeats/];

// ---------------------------------------------------------------- shell

/** Assert we are on the shell without navigating. Cheap (1.5 s budget). */
export async function atHome(s: Session) {
  return reached(await s.until({ selector: anchors.home.el }, { timeout: 1500 }), "at home");
}

/**
 * Reach the shell. Always navigates: a reload is ~150 ms and it is the only way to
 * make the page's WebSocket visible to THIS session (see README "WebSocket frames").
 */
export async function goHome(s: Session, opts: { allowLogin?: boolean } = {}) {
  s.uiIgnore = uiIgnore;
  // With ctl.requireAuth and no cookie the SHELL ITSELF 302s to /login.html?next=/,
  // so the login page is an arm of the home anchor (a refusal then costs ~40 ms, not 5 s).
  const r = reached(await s.navigate(HOME, { until: { any: [
    { selector: anchors.home.el, label: "home" },
    { selector: anchors.login.el, label: "login" },
  ] } }), "go home");
  const which = r.until?.which as "home" | "login";
  if (which === "login" && !opts.allowLogin) throw new Error(`go home: redirected to ${s.page.url()} — log in first`);
  return { act: r.action, which };
}

// ---------------------------------------------------------------- ctl (the app's knobs)

/** POST /ctl from inside the page (page cookies + it lands in the log). Returns the effective config. */
export async function ctl(s: Session, patch: Record<string, unknown>): Promise<any> {
  return await s.evaluate(
    `fetch('/ctl',{method:'POST',headers:{'content-type':'application/json'},` +
    `body:JSON.stringify(${JSON.stringify(patch)})}).then(r=>r.json())`);
}

/** POST /ctl/reset — back to the documented defaults. Do this first in any check. */
export async function ctlReset(s: Session): Promise<any> {
  return await s.evaluate(`fetch('/ctl/reset',{method:'POST'}).then(r=>r.json())`);
}

export async function ctlGet(s: Session): Promise<any> {
  return await s.evaluate(`fetch('/ctl').then(r=>r.json())`);
}

// ---------------------------------------------------------------- 1. chart

/** Three concurrent fetches, one slow. #chart-status never leaves "idle" — anchor on #chart. */
export async function loadChart(s: Session, budgetMs = 4000) {
  const r = reached(await s.click("#load-chart", {
    until: { selector: "#chart:has-text('Chart loaded')" }, timeout: budgetMs,
  }), "load chart");
  const a = s.store.latestJson("/api/chart/a", r.action);
  const b = s.store.latestJson("/api/chart/b", r.action);
  const slow = s.store.requests({ url: "/api/slow", action: r.action })[0];
  return { act: r.action, series: [a, b], slowMs: slow?.t_end && slow?.t_start ? Math.round(slow.t_end - slow.t_start) : null,
           text: await s.evaluate("document.querySelector('#chart').textContent") as string };
}

// ---------------------------------------------------------------- 2. records + conditional modal

/**
 * Open a record. The "Allergy Review Required" modal is optional (ctl.modal) and may be
 * delayed (ctl.modalDelayMs) — handled both ways.  Fields come from the wire.
 */
export async function openRecord(
  s: Session, id: number, opts: { budgetMs?: number; modalGraceMs?: number } = {},
) {
  const budgetMs = opts.budgetMs ?? 4000;
  // ctl.modalDelayMs can push the dialog AFTER the record renders, and nothing on the page
  // says "no dialog is coming" — so a delayed interstitial costs a grace window, once.
  const modalGraceMs = opts.modalGraceMs ?? 1200;
  const r = reached(await s.click(`#record-${id}`, {
    until: { any: [
      { selector: "#record-modal", label: "modal" },
      { selector: `#record h3:text-is("Record ${id}")`, label: "record" },
    ] },
    timeout: budgetMs,
  }), `open record ${id}`);
  const rec = s.store.latestJson(`/api/record/${id}`, r.action);
  let modal = r.until?.which === "modal";
  if (!modal) {
    // it may still be coming (modalDelayMs); look once, cheaply, without failing.
    const late = await s.until({ selector: "#record-modal" }, { timeout: modalGraceMs });
    modal = !!late.until?.ok;
  }
  if (modal) await acknowledgeModal(s);
  return { act: r.action, record: rec, sawModal: modal };
}

export async function acknowledgeModal(s: Session) {
  return reached(await s.click("#record-modal button", { until: { gone: "#record-modal" } }), "acknowledge");
}

// ---------------------------------------------------------------- 3. optimistic save

/**
 * The UI says "Saved ✓" before the server answers and never takes it back.
 * The truth is the STATUS CODE of /api/save/status (its body is never read by the page).
 */
export async function save(s: Session, budgetMs = 6000) {
  const r = reached(await s.click("#save", { until: { request: "/api/save/status" }, timeout: budgetMs }), "save");
  const rows = s.store.requests({ url: "/api/save/status", action: r.action });
  const status = rows.length ? rows[rows.length - 1].status : null;
  const posted = s.store.latestJson("/api/save", r.action);
  return { act: r.action, status, ok: status === 200, saveId: posted?.id ?? null,
           uiSays: await s.evaluate("document.querySelector('#save-state').textContent") as string };
}

// ---------------------------------------------------------------- 4. spinner that never resolves

/** Proves the negative: #spinner is perpetual. Returns true when it is STILL there after budgetMs. */
export async function spinnerStillSpinning(s: Session, budgetMs = 800) {
  const r = await s.until({ gone: "#spinner" }, { timeout: budgetMs });
  return r.until?.ok === false;
}

// ---------------------------------------------------------------- 7. debounced search

/** 250 ms trailing debounce: one XHR for the whole word. Hits come from the wire. */
export async function search(s: Session, q: string) {
  reached(await s.fill("#search", ""), "clear search");
  const r = reached(await s.type("#search", q, {
    until: { request: `/api/search?q=${encodeURIComponent(q)}`, landed: true }, timeout: 4000,
  }), `search ${q}`);
  return { act: r.action, hits: (s.store.latestJson("/api/search", r.action)?.hits ?? []) as string[] };
}

// ---------------------------------------------------------------- 17. keyboard-only combobox

/**
 * #med ignores nothing, but the list is replaced faster than a mouse can land and it is
 * not debounced. Recipe: clear, type, wait for the LAST suggestion request, ArrowDown, Enter.
 */
export async function pickMed(s: Session, prefix: string) {
  reached(await s.fill("#med", ""), "clear med");                 // s.type APPENDS — always clear
  reached(await s.type("#med", prefix, {
    until: { request: `/api/meds?q=${encodeURIComponent(prefix)}`, landed: true }, timeout: 4000,
  }), "type med");
  reached(await s.press("ArrowDown", {
    target: "#med", until: { fn: "document.querySelector('#med').getAttribute('aria-activedescendant')" },
  }), "arrow down");
  const r = reached(await s.press("Enter", {
    target: "#med", until: { selector: "#med-selected:has-text('Selected:')" },
  }), "enter");
  return { act: r.action, selected: (await s.evaluate("document.querySelector('#med-selected').textContent") as string).replace(/^Selected:\s*/, "") };
}

// ---------------------------------------------------------------- 8. virtualised rows

/** 10 000 rows on the wire, ~24 in the DOM. Total and any row's data come from /api/rows. */
export async function loadRows(s: Session) {
  const r = reached(await s.click("#load-rows", { until: { selector: "#rows .row" }, timeout: 4000 }), "load rows");
  const all = s.store.latestJson("/api/rows", r.action) as Array<{ id: number; name: string; group: string }>;
  const dom = await s.evaluate("document.querySelectorAll('#rows .row').length") as number;
  return { act: r.action, total: all.length, domCount: dom, all };
}

/** Move the virtual window. Row height is 24 px; wait on the EFFECT, never on the scroll call. */
export async function scrollRowsTo(s: Session, index: number) {
  const before = await s.evaluate("document.querySelector('#rows .row')?.dataset.id") as string;
  await s.evaluate(`document.querySelector('#rows').scrollTop = 24 * ${index}`);
  const r = reached(await s.until(
    { fn: `document.querySelector('#rows .row')?.dataset.id !== ${JSON.stringify(before)}` }, { timeout: 3000 },
  ), "rows scrolled");
  return { act: r.action, firstId: await s.evaluate("document.querySelector('#rows .row').dataset.id") as string };
}

// ---------------------------------------------------------------- 9. re-render race

/** The button is replaced on hover; a real mouse click is diagnosed `detached` after 3 s. Use js:true. */
export async function clickRerender(s: Session) {
  const before = Number(await s.evaluate("document.querySelector('#rerender-count').textContent"));
  const r = reached(await s.click("#rerender", {
    js: true, until: { fn: `Number(document.querySelector('#rerender-count').textContent) > ${before}` },
  }), "rerender");
  return { act: r.action, count: Number(await s.evaluate("document.querySelector('#rerender-count').textContent")) };
}

// ---------------------------------------------------------------- 10. iframes

export async function submitSameFrame(s: Session, name: string) {
  reached(await s.fill("#if-name", name, { frame: "#same-origin" }), "fill same-origin");
  const r = reached(await s.click("#if-submit", {
    frame: "#same-origin", until: { request: "/api/iframe-submit", landed: true },
  }), "submit same-origin");
  return { act: r.action, body: s.store.latestJson("/api/iframe-submit", r.action),
           text: await s.frame("#same-origin").locator("#if-result").textContent() };
}

export async function submitCrossFrame(s: Session, name: string) {
  reached(await s.fill("#xf-name", name, { frame: "#cross-origin" }), "fill cross-origin");
  const r = reached(await s.click("#xf-submit", {
    frame: "#cross-origin", until: { request: "/api/xframe-submit", landed: true },
  }), "submit cross-origin");
  return { act: r.action, body: s.store.latestJson("/api/xframe-submit", r.action),
           text: await s.frame("#cross-origin").locator("#xf-result").textContent() };
}

/** Depth 2: /iframe.html embeds /iframe2.html. */
export async function submitDeepFrame(s: Session, name: string) {
  reached(await s.fill("#deep-name", name, { frame: "#same-origin >> #nested2" }), "fill deep");
  const r = reached(await s.click("#deep-submit", {
    frame: "#same-origin >> #nested2",
    until: { selector: "#deep-result:not(:empty)", frame: "#same-origin >> #nested2" },
    timeout: 3000,
  }), "submit deep");
  const text = await s.frame("#same-origin >> #nested2").locator("#deep-result").textContent();
  return { act: r.action, text };
}

// ---------------------------------------------------------------- 11. native dialogs

/** Session policy handles them (open(..., { dialogs: "accept" | "dismiss" })); the row lands in `dialogs`. */
export async function nativeDialog(s: Session, which: "alert" | "confirm") {
  const sel = which === "alert" ? "#alert" : "#confirm";
  const out = which === "alert" ? "#alert-result" : "#confirm-result";
  const r = reached(await s.click(sel, { until: { selector: `${out}:not(:empty)` } }), which);
  const row = s.store.sql(`SELECT type,message,handled FROM dialogs WHERE action_id=? ORDER BY seq DESC LIMIT 1`, r.action)[0];
  return { act: r.action, dialog: row, result: await s.evaluate(`document.querySelector('${out}').textContent`) as string };
}

/** Arm beforeunload, follow the link, come back. With dialogs:"accept" the navigation goes through. */
export async function armUnloadAndNavigateAway(s: Session) {
  reached(await s.click("#arm-unload", { until: { selector: "#unload-armed:text-is('armed')" } }), "arm");
  const r = reached(await s.click("#nav-away", { until: { url: "/away.html" } }), "navigate away");
  const row = s.store.sql(`SELECT type,message,handled FROM dialogs WHERE action_id=? ORDER BY seq DESC LIMIT 1`, r.action)[0];
  reached(await s.click("a#back", { until: { selector: anchors.home.el } }), "back to shell");
  return { act: r.action, dialog: row };
}

// ---------------------------------------------------------------- 15. child window

export async function openChildWindow(s: Session) {
  const r = reached(await s.click("#open-child", { until: { page: "child.html" } }), "open child");
  const child = s.context.pages().find((p) => p.url().includes("child.html"))!;
  const text = await child.locator("body").innerText();
  await s.closeOtherPages();                      // a background page is throttled to 1 fps — always clean up
  return { act: r.action, text };
}

// ---------------------------------------------------------------- 16. canvas

/** 400x200, 4 rows x 8 cols, 50 px cells. Pixels are the only evidence — read them back. */
export async function pickCanvasCell(s: Session, row: number, col: number) {
  const x = col * 50 + 25, y = row * 50 + 25;
  const probe = `(()=>{const c=document.querySelector('#grid');return Array.from(c.getContext('2d').getImageData(${x},${y},1,1).data).join(',')})()`;
  const before = await s.evaluate(probe) as string;
  const r = reached(await s.click("#grid", {
    position: { x, y }, until: { fn: `${probe} !== ${JSON.stringify(before)}` }, timeout: 2000,
  }), `canvas cell ${row},${col}`);
  return { act: r.action, before, after: await s.evaluate(probe) as string,
           label: (s.store.latestJson("/api/grid")?.cells ?? []).find((c: any) => c.r === row && c.c === col)?.label };
}

// ---------------------------------------------------------------- 24 / 25. context menu, dblclick

export async function contextMenuPick(s: Session, item: "open" | "rename" | "delete") {
  reached(await s.rightclick("#ctx-target", { until: { selector: "#ctx-menu li", visible: true } }), "open ctx menu");
  const r = reached(await s.click(`#ctx-${item}`, { until: { gone: "#ctx-menu li" } }), `ctx ${item}`);
  return { act: r.action, result: await s.evaluate("document.querySelector('#ctx-result').textContent") as string };
}

export async function doubleClickToEdit(s: Session) {
  const r = reached(await s.dblclick("#dbl-target", { until: { selector: "#dbl-state:text-is('editing')" } }), "dblclick edit");
  return { act: r.action, editable: await s.evaluate("!!document.querySelector('#s-25 input')") as boolean };
}

// ---------------------------------------------------------------- 26. drag

/** Slider: an offset drag from the thumb's centre. value = percent of the 280 px of travel. */
export async function setSlider(s: Session, dx: number) {
  const before = await s.evaluate("document.querySelector('#slider-value').textContent") as string;
  // `all` of the rendered value AND the wire, so the POST is guaranteed inside this act's window.
  const r = reached(await s.drag("#slider-thumb", { dx, dy: 0 }, {
    until: { all: [
      { fn: `document.querySelector('#slider-value').textContent !== ${JSON.stringify(before)}`, label: "value" },
      { request: "/api/drag-report", label: "reported" },
    ] },
  }), "slider");
  return { act: r.action, value: Number(await s.evaluate("document.querySelector('#slider-value').textContent")),
           reported: s.store.requests({ url: "/api/drag-report", action: r.action }).at(-1)?.req_body };
}

/**
 * Reorder: dragTo is ONE straight move, so it must land past the target's midpoint.
 * Dropping on the ADJACENT item does nothing (and still POSTs an unchanged /api/drag-report);
 * drop on the item two slots away to move one slot.
 */
export async function moveItemDownOneSlot(s: Session) {
  const before = await s.evaluate("document.querySelector('#sort-order').textContent") as string;
  const r = reached(await s.drag("#sort-a", "#sort-c", {
    until: { fn: `document.querySelector('#sort-order').textContent !== ${JSON.stringify(before)}` }, timeout: 3000,
  }), "reorder");
  return { act: r.action, before, after: await s.evaluate("document.querySelector('#sort-order').textContent") as string };
}

// ---------------------------------------------------------------- 18. shadow DOM

/** The root is OPEN, so ordinary CSS pierces it; the count is only reachable through .shadowRoot. */
export async function clickShadowButton(s: Session) {
  const root = "document.querySelector('#shadow-host').shadowRoot";
  const before = Number(await s.evaluate(`${root}.querySelector('#shadow-count').textContent`));
  const r = reached(await s.click("#shadow-host #shadow-btn", {
    until: { fn: `Number(${root}.querySelector('#shadow-count').textContent) > ${before}` },
  }), "shadow click");
  return { act: r.action, count: Number(await s.evaluate(`${root}.querySelector('#shadow-count').textContent`)) };
}

// ---------------------------------------------------------------- 20. GraphQL

export async function graphql(s: Session, kind: "query" | "mutate") {
  const r = reached(await s.click(kind === "query" ? "#gql-query" : "#gql-mutate", {
    until: { request: "/api/graphql", landed: true },
  }), `graphql ${kind}`);
  const row = s.store.requests({ url: "/api/graphql", action: r.action }).at(-1)!;
  return { act: r.action, sent: row.req_body, body: s.store.latestJson("/api/graphql", r.action) };
}

// ---------------------------------------------------------------- 28. fake stream

/** mime says text/event-stream, the body is finite XML — and it IS captured (body_state "ok"). */
export async function loadFakeStream(s: Session) {
  const r = reached(await s.click("#load-fake-stream", {
    until: { request: "/api/fake-stream", landed: true },
  }), "fake stream");
  const row = s.store.requests({ url: "/api/fake-stream", action: r.action }).at(-1)!;
  return { act: r.action, mime: row.mime, bodyState: row.body_state, body: s.store.body(row.body_hash!) };
}

// ---------------------------------------------------------------- 23. push channels

/**
 * Deliver one notification over a chosen channel.  Arm FIRST, trigger second.
 * ws  -> visible as a ws_frame (only if the socket opened inside this session: goHome first)
 * poll-> visible as a /api/notify-poll response (needs ctl.notify = true)
 * sse -> invisible on the wire (body_state "streaming"); DOM only.
 */
export async function pushNotification(s: Session, via: "ws" | "sse" | "poll", budgetMs = 8000) {
  const before = await s.evaluate("document.querySelectorAll('#notif-list li').length") as number;
  const arms: any[] = [{ fn: `document.querySelectorAll('#notif-list li').length > ${before}`, label: "dom" }];
  if (via === "ws") arms.unshift({ ws: "notify", label: "ws-frame" });
  if (via === "poll") arms.unshift({ request: "/api/notify-poll", landed: true, label: "poll-response" });
  const pending = s.until({ all: arms }, { timeout: budgetMs });
  await ctl(s, { push: via });
  const r = reached(await pending, `push ${via}`);
  const items = await s.evaluate("[...document.querySelectorAll('#notif-list li')].map(li=>li.textContent)") as string[];
  return { act: r.action, which: r.until?.which, latest: items.at(-1)!, count: items.length };
}

// ---------------------------------------------------------------- 5/22. ambient traffic

/** Turn the background on and prove it: heartbeat every ctl.heartbeatMs, /api/poll holding ctl.pollHoldMs. */
export async function observeAmbient(s: Session, beats = 1, budgetMs = 12000) {
  await ctl(s, { ambient: true });
  await goHome(s);
  const r = reached(await s.until(
    { fn: `Number(document.querySelector('#heartbeat-count').textContent) >= ${beats}` }, { timeout: budgetMs },
  ), "ambient heartbeats");
  const hb = s.store.requests({ url: "/api/heartbeat", action: r.action });
  const poll = s.store.requests({ url: "/api/poll", action: r.action });
  await ctl(s, { ambient: false });
  return { act: r.action, heartbeats: hb.length, polls: poll.length,
           pollHoldMs: poll.filter((p) => p.t_end).map((p) => Math.round(p.t_end! - p.t_start)) };
}

// ---------------------------------------------------------------- 12. session timeout

/** ctl.timeoutMs of idle raises a [role=dialog]; "Stay signed in" clears it. */
export async function sessionTimeoutAndRecover(s: Session, timeoutMs = 2500) {
  await ctl(s, { timeoutMs });
  await goHome(s);
  const r = reached(await s.until({ selector: "[role=dialog]" }, { timeout: timeoutMs + 4000 }), "session dialog");
  const text = await s.evaluate("document.querySelector('[role=dialog]').innerText") as string;
  reached(await s.click("button:has-text('Stay signed in')", { until: { gone: "[role=dialog]" } }), "stay signed in");
  await ctl(s, { timeoutMs: 0 });
  return { act: r.action, text, state: await s.evaluate("document.querySelector('#timeout-state').textContent") as string };
}

// ---------------------------------------------------------------- 21. auth

/** requireAuth makes /secure.html a 302 to /login.html?next=… . Returns which anchor we landed on. */
export async function gotoSecure(s: Session) {
  const r = reached(await s.click("#go-secure", {
    until: { any: [
      { selector: anchors.secure.el, label: "secure" },
      { selector: anchors.login.el,  label: "login" },
    ] },
  }), "go to secure");
  return { act: r.action, which: r.until?.which as "secure" | "login", url: s.page.url() };
}

/**
 * From the login page. POST /api/login accepts ANY non-empty user/pass (the cookie value is
 * the username); only an EMPTY field is a 401, which renders #login-error "login failed".
 */
export async function login(s: Session, user: string, pass: string) {
  reached(await s.until({ selector: anchors.login.el }, { timeout: 1500 }), "at login");
  // A leftover "login failed" from the previous attempt makes the `error` arm alreadyTrue.
  // Reload the form instead of asserting on a stale span.
  if (await s.evaluate("document.querySelector('#login-error').textContent !== ''"))
    reached(await s.navigate(s.page.url(), { until: { selector: anchors.login.el } }), "reload login");
  reached(await s.fill("#user", user), "user");
  reached(await s.fill("#pass", pass), "pass");
  // where you land depends on ?next= — the shell, the secure page, or nowhere (bad password).
  const r = reached(await s.click("#login", {
    until: { any: [
      { selector: anchors.secure.el, label: "secure" },
      { selector: anchors.home.el,   label: "home" },
      { selector: "#login-error:not(:empty)", label: "error" },
    ] },
  }), "submit login");
  const cookie = (await s.context.cookies()).find((c) => c.name === "gauntlet_auth");
  return { act: r.action, which: r.until?.which as "secure" | "home" | "error", cookie: cookie?.value ?? null,
           who: r.until?.which === "secure" ? await s.evaluate("document.querySelector('#who').textContent") as string : null };
}

export async function logout(s: Session) { await s.context.clearCookies(); }

// ---------------------------------------------------------------- 14. delete

export async function deleteItem(s: Session) {
  const r = reached(await s.click("#delete", { until: { request: "/api/item/", landed: true } }), "delete");
  return { act: r.action, body: s.store.latestJson("/api/item/", r.action),
           text: await s.evaluate("document.querySelector('#delete-result').textContent") as string };
}
