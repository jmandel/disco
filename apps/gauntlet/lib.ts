// apps/gauntlet/lib.ts — the gauntlet's workflows as functions.
// Every function: assert an anchor on the way in, put an `until` on every transition,
// read facts from the wire when they travel on it, `reached(...)` every step, leave a known anchor.
import { open, reached } from "../../src/index.ts";

export type S = Awaited<ReturnType<typeof open>>;

export const HOME = "http://localhost:4800/";
export const XORIGIN = "http://localhost:4801";

// ------------------------------------------------------------ wire reads

/**
 * The body of a request *this act* made. Always prefer this to store.latestJson():
 * `t` is milliseconds since the run started, so "newest" across a store that has seen more than one
 * browser is not the newest in time — a stale row from an older run can win. `action_id` cannot.
 */
export function jsonFrom<T = any>(s: S, rep: any, url: string): T {
  const rows = s.store.requests({ action: rep.action, url });
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`${rep.action} made no request matching ${url}`);
  if (!row.body_hash) throw new Error(`${rep.action} ${url}: body_state=${row.body_state} (the page never read it); status=${row.status}`);
  return s.store.json(String(row.body_hash)) as T;
}

/** The status code of a request this act made — for bodies the page never reads. */
export function statusFrom(s: S, rep: any, url: string): number {
  const rows = s.store.requests({ action: rep.action, url });
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`${rep.action} made no request matching ${url}`);
  return Number(row.status);
}

// ---------------------------------------------------------------- anchors

/** The shell. Cheap and specific: the section-1 button only exists on the app shell. */
export const SHELL = { selector: "#load-chart" } as const;
export const LOGIN = { selector: "#login-form" } as const;
export const SECURE = { selector: "#who" } as const;

/** Assert we are on the shell; if we are not, go there. Also clears a leftover modal by reloading. */
export async function atShell(s: S, { reload = false } = {}) {
  if (reload || !(await s.evaluate("!!document.getElementById('load-chart')"))) {
    reached(await s.navigate(HOME, { until: SHELL }), "navigate home");
  } else {
    reached(await s.until(SHELL, { timeout: 1500 }), "shell anchor");
  }
}

// ------------------------------------------------------------------- ctl
// The gauntlet's knobs. GET /ctl reads them, POST /ctl merges, POST /ctl/reset restores defaults.
// Driven through the page so the calls land in disco's log like any other request.

export type Ctl = Record<string, unknown>;

export async function ctl(s: S, patch: Ctl): Promise<Ctl> {
  return (await s.evaluate(
    `fetch('${HOME}ctl',{method:'POST',headers:{'Content-Type':'application/json'},` +
      `body:${JSON.stringify(JSON.stringify(patch))}}).then(r=>r.json())`,
  )) as Ctl;
}
export async function readCtl(s: S): Promise<Ctl> {
  return (await s.evaluate(`fetch('${HOME}ctl').then(r=>r.json())`)) as Ctl;
}
export async function resetCtl(s: S): Promise<Ctl> {
  return (await s.evaluate(`fetch('${HOME}ctl/reset',{method:'POST'}).then(r=>r.json())`)) as Ctl;
}
/** Knobs the client reads once, at page load. Set them, then reload, or they do nothing. */
export async function ctlAndReload(s: S, patch: Ctl) {
  await ctl(s, patch);
  await atShell(s, { reload: true });
}

// -------------------------------------------------------- 1. load chart

/**
 * Three concurrent GETs, one artificially slow (ctl.slowMs).
 * NOT #chart-status: it goes "loading…" and back to "idle", so it is already-true on both sides.
 */
export async function loadChart(s: S): Promise<{ responses: number; a: number[]; b: number[] }> {
  await atShell(s);
  const rep = await s.click("#load-chart", { until: { selector: "#chart:has-text('Chart loaded')" }, timeout: 8000 });
  reached(rep, "load chart");
  const text = String(await s.evaluate("document.getElementById('chart').textContent"));
  const responses = Number(/\((\d+) responses\)/.exec(text)?.[1] ?? 0);
  return {
    responses,
    a: jsonFrom(s, rep, "/api/chart/a").points,
    b: jsonFrom(s, rep, "/api/chart/b").points,
  };
}

// ------------------------------------------------------------ 2. records

export type Record_ = { id: number; name: string; dob: string; mrn: string; allergies: string[] };

/**
 * Open record `id`. The "Allergy Review Required" modal appears whenever ctl.modal is true
 * (for every record, not just the ones with allergies) and, with ctl.modalDelayMs, it can land
 * *after* the record renders — so both arms are optional and we always sweep the dialog afterwards.
 * The record is read from the wire, never scraped.
 */
export async function openRecord(s: S, id: number): Promise<Record_> {
  await atShell(s);
  const rep = await s.click(`#record-${id}`, {
    until: {
      any: [
        { selector: "[role=dialog]", label: "dialog" },
        { selector: `#record h3:text-is("Record ${id}")`, label: "record" },
      ],
    },
  });
  reached(rep, `open record ${id}`);
  await dismissRecordModal(s);
  reached(await s.until({ selector: `#record h3:text-is("Record ${id}")` }, { timeout: 3000 }), "record rendered");
  return jsonFrom<Record_>(s, rep, `/api/record/${id}`);
}

/** Idempotent: acknowledges the allergy modal if one is up (including one that lands late). */
export async function dismissRecordModal(s: S, { settle = 900 } = {}) {
  const seen = await s.until(
    { any: [{ selector: "#record-modal", label: "up" }] },
    { timeout: settle },
  );
  if (!seen.until?.ok) return false;
  reached(await s.click("#modal-ack", { until: { gone: "#record-modal" } }), "acknowledge allergy modal");
  return true;
}

// --------------------------------------------------------------- 3. save

/**
 * Optimistic UI. #save-state flips to "Saved ✓" immediately and NEVER corrects itself,
 * so the screen cannot tell you whether the save worked. The truth is the status code of
 * GET /api/save/status (200 ok / 500 failed) — the page never reads that body, so the
 * status is all there is, and it is enough.
 */
export async function save(s: S): Promise<{ ok: boolean; status: number; toast: string }> {
  await atShell(s);
  reached(await s.until({ gone: "[role=status]" }, { timeout: 4000 }), "previous toast gone");
  const rep = await s.click("#save", {
      until: {
        any: [
          { selector: "[role=status]:has-text('Save failed')", label: "failed" },
          { selector: "[role=status]:has-text('Saved')", label: "saved" },
        ],
      },
      timeout: 8000,
  });
  reached(rep, "save");
  const toast = String(await s.evaluate("document.querySelector('[role=status]')?.textContent ?? ''"));
  const status = statusFrom(s, rep, "/api/save/status");   // the page never reads this body
  return { ok: status === 200, status, toast };
}

// ------------------------------------------------------------- 7. search

/** Debounced 250 ms trailing. `type` (keystrokes), never `fill`. Hits come off the wire. */
export async function search(s: S, q: string): Promise<string[]> {
  await atShell(s);
  reached(await s.fill("#search", ""), "clear search");
  const rep = await s.type("#search", q, { until: { request: "/api/search", landed: true } });
  reached(rep, `search ${q}`);
  return jsonFrom(s, rep, "/api/search").hits as string[];
}

// --------------------------------------------------------------- 8. rows

/**
 * 10 000 rows, 24px each, ~23 in the DOM at a time. #rows-count exists but is EMPTY before the
 * click, so `{ selector: "#rows-count" }` is already-true — anchor on its text instead.
 * Row N comes from GET /api/rows (484 KB, fully captured), not from the DOM.
 */
export async function loadRows(s: S): Promise<{ total: number; rows: any[] }> {
  await atShell(s);
  const rep = await s.click("#load-rows", { until: { selector: "#rows-count:has-text('rows')" }, timeout: 8000 });
  reached(rep, "load rows");
  const body = jsonFrom(s, rep, "/api/rows") as any;
  const rows = Array.isArray(body) ? body : (body.rows ?? body.items ?? []);
  return { total: rows.length, rows };
}

/** Scroll the virtualised viewport and wait for the *effect* (the first rendered row changing). */
export async function scrollRowsTo(s: S, index: number): Promise<string> {
  await s.evaluate(`document.getElementById('rows').scrollTop = ${index} * 24`);
  reached(
    await s.until({ fn: `document.querySelector('#rows .row[data-id="${index}"]') !== null` }, { timeout: 3000 }),
    `row ${index} rendered`,
  );
  return String(await s.evaluate(`document.querySelector('#rows .row[data-id="${index}"]').textContent`));
}

// ----------------------------------------------------------- 9. rerender

/** #rerender is replaced on every mousemove: a real click times out with `detached`. js:true only. */
export async function clickRerender(s: S): Promise<number> {
  await atShell(s);
  const before = Number(await s.evaluate("document.getElementById('rerender-count').textContent"));
  reached(
    await s.click("#rerender", { js: true, until: { selector: `#rerender-count:text-is('${before + 1}')` } }),
    "rerender click",
  );
  return before + 1;
}

// ------------------------------------------------------------ 10. frames

export async function iframeSubmit(s: S, name: string): Promise<string> {
  await atShell(s);
  reached(await s.fill("#if-name", name, { frame: "#same-origin" }), "same-origin name");
  const rep = await s.click("#if-submit", { frame: "#same-origin", until: { request: "/api/iframe-submit", landed: true } });
  reached(rep, "same-origin submit");
  return jsonFrom(s, rep, "/api/iframe-submit").name;
}

/** Depth-2: /iframe.html embeds /iframe2.html. Chain frames with ">>". */
export async function deepIframeSubmit(s: S, name: string): Promise<string> {
  await atShell(s);
  const frame = "#same-origin >> #nested2";
  reached(await s.fill("#deep-name", name, { frame }), "deep name");
  reached(await s.click("#deep-submit", { frame, until: { request: "/api/iframe-submit", landed: true } }), "deep submit");
  return String(await s.frame(frame).locator("#deep-result").textContent()).replace("Deep submitted: ", "");
}

/** Cross-origin (localhost:4801). Its requests are in the log under the other origin's URL. */
export async function xframeSubmit(s: S, name: string): Promise<{ name: string; origin: string }> {
  await atShell(s);
  reached(await s.fill("#xf-name", name, { frame: "#cross-origin" }), "cross-origin name");
  const rep = await s.click("#xf-submit", { frame: "#cross-origin", until: { request: "/api/xframe-submit", landed: true } });
  reached(rep, "cross-origin submit");
  return jsonFrom(s, rep, "/api/xframe-submit");
}

// ----------------------------------------------------------- 11. dialogs

export async function nativeAlert(s: S): Promise<string> {
  await atShell(s);
  reached(await s.click("#alert", { until: { selector: "#alert-result:text-is('alerted')" } }), "alert");
  return "alerted";
}

/** "confirmed" when the session is dialogs:"accept", "cancelled" when it is "dismiss". */
export async function nativeConfirm(s: S): Promise<string> {
  await atShell(s);
  reached(
    await s.click("#confirm", {
      until: {
        any: [
          { selector: "#confirm-result:text-is('confirmed')", label: "confirmed" },
          { selector: "#confirm-result:text-is('cancelled')", label: "cancelled" },
        ],
      },
    }),
    "confirm",
  );
  return String(await s.evaluate("document.getElementById('confirm-result').textContent"));
}

/**
 * Arms beforeunload, then leaves. With dialogs:"accept" the dialog is accepted and we land on
 * /away.html; with dialogs:"dismiss" the page stays put.
 * "stayed" has no positive landmark of its own — every candidate (#load-chart, url "/") is already
 * true before the click, so it is diagnosed as the *absence* of the landing page inside a short budget.
 */
export async function armAndNavigateAway(s: S, budget = 2500): Promise<"left" | "stayed"> {
  await atShell(s);
  reached(await s.click("#arm-unload", { until: { selector: "#unload-armed:text-is('armed')" } }), "arm beforeunload");
  const rep = await s.click("#nav-away", {
    until: { selector: "h1:text-is('You navigated away')" },
    timeout: budget,
  });
  if (!rep.ok) reached(rep, "navigate away");                    // the click itself must have happened
  const which = rep.until?.ok ? "left" : "stayed";
  if (!rep.dialogs?.some((d: any) => d.type === "beforeunload")) throw new Error("no beforeunload dialog was raised");
  await atShell(s, { reload: true });
  return which;
}

// --------------------------------------------------- 12. session timeout

/** Arm the idle timer, wait for the dialog, then "Stay signed in" (which re-arms it). */
export async function sessionTimeoutAndStay(s: S, timeoutMs = 1200): Promise<number> {
  await ctlAndReload(s, { timeoutMs });
  const fired = await s.until({ selector: "#session-timeout" }, { timeout: timeoutMs + 4000 });
  reached(fired, "session expiring dialog");
  reached(await s.click("#stay", { until: { gone: "#session-timeout" } }), "stay signed in");
  reached(await s.until({ selector: "#timeout-state:has-text('armed')" }, { timeout: 2000 }), "timer re-armed");
  await ctlAndReload(s, { timeoutMs: 0 });
  return fired.until?.elapsedMs ?? -1;
}

// ------------------------------------------------------------- 14. delete

export async function deleteItem(s: S, id = 1): Promise<number> {
  await atShell(s);
  const rep = await s.click("#delete", { until: { request: "/api/item/", landed: true } });
  reached(rep, "delete");
  return jsonFrom(s, rep, "/api/item/" + id).deleted;
}

// ------------------------------------------------------- 15. child window

/**
 * There is no `until` for "a new page opened" — act bare with a window and read report.pages.
 * Always close it: a background page is throttled to 1 fps and slows the driven page down.
 */
export async function openChildAndPing(s: S): Promise<string> {
  await atShell(s);
  const rep = await s.click("#open-child", { window: 1200 });
  reached(rep, "open child window");
  const child = s.context.pages().find((p: any) => p.url().includes("child.html"));
  if (!child) throw new Error("child window did not open; report.pages=" + JSON.stringify(rep.pages));
  await child.bringToFront();
  await child.click("#child-fetch");
  await child.waitForSelector("#child-result:not(:empty)", { timeout: 3000 });
  const out = String(await child.locator("#child-result").textContent());
  await s.page.bringToFront();
  await s.closeOtherPages();
  return out;
}

// -------------------------------------------------------------- 16. canvas

/**
 * Pixels only: nothing in the DOM changes. `act` has no position option, so address the cell
 * with raw mouse coordinates. Readback: window.__gridSelected, and the cell pixel turning amber.
 */
export async function selectGridCell(s: S, r: number, c: number): Promise<{ r: number; c: number; pixel: number[] }> {
  await atShell(s);
  reached(await s.scroll("#grid"), "scroll canvas into view");
  const box = JSON.parse(String(await s.evaluate("JSON.stringify(document.getElementById('grid').getBoundingClientRect())")));
  const cw = 400 / 8, ch = 200 / 4;                       // from GET /api/grid: 4 rows x 8 cols
  const x = c * cw + cw / 2, y = r * ch + ch / 2;
  await s.page.mouse.click(box.x + 1 + x, box.y + 1 + y);   // +1 for the canvas border
  reached(
    await s.until({ fn: `window.__gridSelected && window.__gridSelected.r===${r} && window.__gridSelected.c===${c}` }, { timeout: 2000 }),
    `grid cell ${r},${c}`,
  );
  const pixel = JSON.parse(
    String(await s.evaluate(`JSON.stringify([...document.getElementById('grid').getContext('2d').getImageData(${x},${y},1,1).data])`)),
  );
  return { r, c, pixel };
}

// ------------------------------------------------------------ 17. combobox

/**
 * Keyboard only. The <li role=option>s are pointer-events:none — clicking one is `unclickable`.
 * type -> wait for /api/meds -> ArrowDown per option -> Enter.
 */
export async function pickMedication(s: S, prefix: string, name: string): Promise<string> {
  await atShell(s);
  reached(await s.fill("#med", ""), "clear med");
  const typed = await s.type("#med", prefix, { until: { request: "/api/meds", landed: true } });
  reached(typed, "type medication");
  const hits = jsonFrom(s, typed, "/api/meds").hits as string[];
  const idx = hits.indexOf(name);
  if (idx < 0) throw new Error(`"${name}" not in /api/meds?q=${prefix}: ${hits.join(", ")}`);
  for (let i = 0; i <= idx; i++) {
    reached(await s.press("ArrowDown", { target: "#med", until: { selector: `#med-opt-${i}[aria-selected="true"]` } }), `ArrowDown ${i}`);
  }
  reached(await s.press("Enter", { target: "#med", until: { selector: `#med-selected:has-text("${name}")` } }), "Enter");
  return String(await s.evaluate("document.getElementById('med-selected').textContent"));
}

// ---------------------------------------------------------- 18. shadow DOM

/** Open shadow root; Playwright pierces it, so "#shadow-host >> #shadow-btn" just works. */
export async function clickShadowButton(s: S): Promise<number> {
  await atShell(s);
  const before = Number(await s.evaluate("document.getElementById('shadow-host').shadowRoot.getElementById('shadow-count').textContent"));
  reached(
    await s.click("#shadow-host >> #shadow-btn", {
      until: { fn: `+document.getElementById('shadow-host').shadowRoot.getElementById('shadow-count').textContent > ${before}` },
    }),
    "shadow button",
  );
  return before + 1;
}

// ----------------------------------------------------------------- 19. SSE

/** #sse-status idle -> open -> done; 5 events ~500 ms apart. The messages exist only in the DOM. */
export async function runSse(s: S): Promise<string[]> {
  await atShell(s);
  reached(await s.click("#start-sse", { until: { selector: "#sse-status:text-is('open')" } }), "start SSE");
  reached(await s.until({ selector: "#sse-status:text-is('done')" }, { timeout: 8000 }), "SSE finished");
  return (await s.evaluate("[...document.querySelectorAll('#sse-log li')].map(e=>e.textContent)")) as string[];
}

// ------------------------------------------------------------- 20. GraphQL

/** One path for both operations — tell them apart by the REQUEST body (requests.req_body). */
export async function graphql(s: S, op: "query" | "mutation"): Promise<any> {
  await atShell(s);
  const rep = await s.click(op === "query" ? "#gql-query" : "#gql-mutate", { until: { request: "/api/graphql", landed: true } });
  reached(rep, `graphql ${op}`);
  return jsonFrom(s, rep, "/api/graphql");
}

// ---------------------------------------------------------------- 21. auth

/** With ctl.requireAuth every page 302s to /login.html?next=…, including "/". */
export async function logout(s: S) {
  await s.context.clearCookies();
}

export async function login(s: S, user: string, pass: string): Promise<string> {
  reached(await s.until(LOGIN, { timeout: 2000 }), "on the login page");
  const next = new URL(s.page.url()).searchParams.get("next") ?? "/secure.html";
  reached(await s.fill("#user", user), "user");
  reached(await s.fill("#pass", pass), "pass");
  reached(
    await s.click("#login", {
      until: {
        any: [
          { selector: "#who", label: "secure" },
          { selector: "#load-chart", label: "shell" },
          { selector: "#login-error:has-text('login failed')", label: "rejected" },
        ],
      },
    }),
    `login (next=${next})`,
  );
  return String(await s.evaluate("document.getElementById('who')?.textContent ?? document.title"));
}

/** Anchor in: anywhere. Anchor out: /secure.html showing "Welcome, <user>". */
export async function reachSecureArea(s: S, user = "demo", pass = "s3cret"): Promise<string> {
  const rep = await s.navigate("http://localhost:4800/secure.html", {
    until: { any: [{ selector: "#who", label: "secure" }, { selector: "#login-form", label: "login" }] },
  });
  reached(rep, "go to secure area");
  if (rep.until?.which === "login") await login(s, user, pass);
  reached(await s.until(SECURE, { timeout: 3000 }), "secure area");
  return String(await s.evaluate("document.getElementById('who').textContent"));
}

// ------------------------------------------------------- 23. push channels

export type Channel = "ws" | "sse" | "poll";

/** Fire one notification down a channel and wait for it to show up in the list. */
export async function push(s: S, channel: Channel, timeout = 8000): Promise<string> {
  await atShell(s);
  const before = Number(await s.evaluate("document.getElementById('notif-count').textContent"));
  await s.evaluate(
    `fetch('${HOME}ctl',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"push":"${channel}"}'}).then(r=>r.text())`,
  );
  reached(
    await s.until({ fn: `+document.getElementById('notif-count').textContent > ${before}` }, { timeout }),
    `push via ${channel}`,
  );
  return String(await s.evaluate("[...document.querySelectorAll('#notif-list li')].pop().textContent"));
}

/** The long-poll channel only exists when ctl.notify is true (read at page load). */
export async function enablePollChannel(s: S, notifyPollHoldMs = 4000) {
  await ctlAndReload(s, { notify: true, notifyPollHoldMs });
}

// -------------------------------------------------------- 24. context menu

export async function contextMenuPick(s: S, item: "open" | "rename" | "delete"): Promise<string> {
  await atShell(s);
  reached(await s.rightclick("#ctx-target", { until: { selector: "#ctx-menu[role=menu]", visible: true } }), "open context menu");
  reached(await s.click(`#ctx-${item}`, { until: { gone: "#ctx-menu" } }), `pick ${item}`);
  return String(await s.evaluate("document.getElementById('ctx-result').textContent"));
}

// --------------------------------------------------- 25. double-click edit

export async function editValue(s: S, text: string): Promise<string> {
  await atShell(s);
  reached(await s.dblclick("#dbl-target", { until: { selector: "#dbl-input" } }), "enter edit mode");
  reached(await s.fill("#dbl-input", text), "type value");
  reached(await s.press("Enter", { target: "#dbl-input", until: { selector: `#dbl-state:has-text("committed: ${text}")` } }), "commit");
  return String(await s.evaluate("document.getElementById('dbl-target').textContent"));
}

// ----------------------------------------------------------------- 26. drag

/** s.drag() only accepts a selector as the destination, so a slider needs raw mouse moves. */
export async function setSlider(s: S, fraction: number): Promise<number> {
  await atShell(s);
  reached(await s.scroll("#slider-track"), "scroll slider into view");
  const track = JSON.parse(String(await s.evaluate("JSON.stringify(document.getElementById('slider-track').getBoundingClientRect())")));
  const thumb = JSON.parse(String(await s.evaluate("JSON.stringify(document.getElementById('slider-thumb').getBoundingClientRect())")));
  const y = thumb.y + thumb.height / 2;
  await s.page.mouse.move(thumb.x + thumb.width / 2, y);
  await s.page.mouse.down();
  await s.page.mouse.move(track.x + track.width * fraction, y, { steps: 12 });
  await s.page.mouse.up();
  reached(await s.until({ fn: `+document.getElementById('slider-value').textContent > 0` }, { timeout: 2000 }), "slider moved");
  return Number(await s.evaluate("document.getElementById('slider-value').textContent"));
}

/** Move #sort-a below #sort-c. dragTo() only moves it one slot; a stepped path past the bottom works. */
export async function moveItemToEnd(s: S, id = "sort-a"): Promise<string> {
  await atShell(s);
  reached(await s.scroll("#sort-list"), "scroll list into view");
  const box = (sel: string) => s.evaluate(`JSON.stringify(document.getElementById('${sel}').getBoundingClientRect())`).then((x) => JSON.parse(String(x)));
  const from = await box(id), last = await box("sort-c");
  const y0 = from.y + from.height / 2, y1 = last.y + last.height;
  await s.page.mouse.move(from.x + 20, y0);
  await s.page.mouse.down();
  for (const f of [0.3, 0.6, 1.0]) await s.page.mouse.move(from.x + 20, y0 + (y1 - y0) * f, { steps: 6 });
  await s.page.mouse.up();
  reached(await s.until({ selector: `#sort-order:has-text("${id.slice(-1)}")` }, { timeout: 2000 }), "order updated");
  return String(await s.evaluate("document.getElementById('sort-order').textContent"));
}

// --------------------------------------------------------- 28. fake stream

/** text/event-stream mime, ordinary finite body. disco captures it like any other body. */
export async function loadFakeStream(s: S): Promise<{ chars: number; body: string }> {
  await atShell(s);
  const rep = await s.click("#load-fake-stream", { until: { request: "/api/fake-stream", landed: true } });
  reached(rep, "fake stream");
  const row = s.store.requests({ action: rep.action, url: "/api/fake-stream" }).pop()!;
  const chars = Number(/got (\d+) chars/.exec(String(await s.evaluate("document.getElementById('fake-stream-out').textContent")))?.[1] ?? 0);
  return { chars, body: String(s.store.body(String(row.body_hash))) };
}

// ------------------------------------------------------- 5/22. ambient + 6. ws

/** Turn the background noise on and wait for the header counters to move. */
export async function runAmbient(s: S, { heartbeatMs = 700, pollHoldMs = 400, wsPushMs = 900 } = {}) {
  await ctlAndReload(s, { ambient: true, heartbeatMs, pollHoldMs, wsPushMs });
  reached(
    await s.until(
      { fn: "+document.getElementById('heartbeat-count').textContent >= 2 && +document.getElementById('poll-count').textContent >= 2" },
      { timeout: 8000 },
    ),
    "ambient traffic",
  );
  const out = {
    heartbeats: Number(await s.evaluate("document.getElementById('heartbeat-count').textContent")),
    polls: Number(await s.evaluate("document.getElementById('poll-count').textContent")),
    unattributed: s.store.sql("SELECT method, path, count(*) n FROM requests WHERE action_id IS NULL GROUP BY 1,2") as any[],
  };
  await ctlAndReload(s, { ambient: false });
  return out;
}

/** Every button click except #noop sends {"type":"action","id":"<element id>"} up the WebSocket. */
export async function wsActionFrame(s: S, buttonId: string, wireUntil = "/api/"): Promise<any> {
  await atShell(s);
  // ws_frames.seq is a global AUTOINCREMENT; ws_frames.t restarts with every run, so never ORDER BY t.
  const before = Number((s.store.sql("SELECT coalesce(max(seq),0) m FROM ws_frames") as any[])[0].m);
  // Wait on this button's own round trip: it gives the CDP recorder time to flush the outgoing frame.
  reached(await s.click("#" + buttonId, { until: { request: wireUntil, landed: true }, timeout: 5000 }), "click " + buttonId);
  const rows = s.store.sql(
    `SELECT payload FROM ws_frames WHERE dir='out' AND seq > ${before} ORDER BY seq DESC LIMIT 5`,
  ) as any[];
  for (const r of rows) {
    const f = JSON.parse(String(r.payload));
    if (f.type === "action" && f.id === buttonId) return f;
  }
  return null;
}

// ---------------------------------------------------------- 4. the spinner

/** Proves the negative: #spinner is a CSS animation with no request behind it and never resolves. */
export async function spinnerNeverResolves(s: S, budget = 1000): Promise<boolean> {
  await atShell(s);
  const rep = await s.until({ gone: "#spinner" }, { timeout: budget });
  return rep.until?.ok === false;
}
