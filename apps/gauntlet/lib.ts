// apps/gauntlet/lib.ts
//
// Workflows for the disco "gauntlet" app as importable functions.
// Convention: anchor in -> anchor out, an `until` on every transition, reads come
// from the wire (s.store) whenever the fact travels on it, and reached(...) guards
// every step so a failure explains itself.
//
// The app is a single page at http://localhost:4800/. Server behaviour is tuned by
// POST /ctl (a JSON knob bag); helpers that need a specific knob set it themselves
// and, where it matters, restore it. Nothing here sleeps.

import { reached, type Session } from "../../src/index.ts";

// ---------------------------------------------------------------------------
// Anchors + control plane
// ---------------------------------------------------------------------------

export const SHELL = "#load-chart"; // the main page is up once this exists
export const WS_OPEN = '#ws-status:text-is("open")';

/** POST /ctl to change server behaviour; returns the effective state. */
export async function setCtl(s: Session, knobs: Record<string, unknown>): Promise<any> {
  return await s.evaluate(
    `fetch('/ctl',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(
      JSON.stringify(knobs),
    )}}).then(r=>r.json())`,
  );
}

/** GET /ctl — the effective knob state right now. */
export async function getCtl(s: Session): Promise<any> {
  return await s.evaluate(`fetch('/ctl').then(r=>r.json())`);
}

/** Restore all server knobs to their defaults. */
export async function resetCtl(s: Session): Promise<any> {
  return await s.evaluate(`fetch('/ctl/reset',{method:'POST'}).then(r=>r.json())`);
}

/** Go to the shell and wait for both the DOM and the WebSocket to be live.
 *  Navigating (rather than trusting the current page) is how you guarantee the
 *  WebSocket handshake happens inside your recording window. */
export async function gotoShell(s: Session, base = "http://localhost:4800/") {
  reached(await s.navigate(base, { until: { selector: WS_OPEN } }), "reach shell");
}

/** Assert we are on the shell; cheap recovery check for every workflow. */
export async function assertShell(s: Session) {
  reached(await s.until({ selector: SHELL }, { timeout: 1500 }), "on shell");
}

// ---------------------------------------------------------------------------
// 1. Load Chart — three concurrent fetches, one slow
// ---------------------------------------------------------------------------

/** Click Load Chart; resolve when the slow response lands. Returns {slowMs}. */
export async function loadChart(s: Session): Promise<{ slowMs: number }> {
  await assertShell(s);
  reached(
    await s.click("#load-chart", {
      until: { selector: '#chart:has-text("Chart loaded")' },
      timeout: 4000,
    }),
    "chart loaded",
  );
  const slow = s.store.latestJson("/api/slow"); // { ms, at }
  return { slowMs: slow?.ms ?? -1 };
}

// ---------------------------------------------------------------------------
// 2. Records — with an optional "Allergy Review" modal
// ---------------------------------------------------------------------------

export interface Record {
  id: number;
  name: string;
  dob: string;
  mrn: string;
  allergies: string[];
}

/** Open record N. Handles the conditional modal (ctl.modal) either way and
 *  dismisses it. Reads the record from the wire (GET /api/record/N). */
export async function openRecord(s: Session, n: number): Promise<Record> {
  await assertShell(s);
  const r = await s.click(`#record-${n}`, {
    until: {
      any: [
        { selector: `#record h3:text-is("Record ${n}")`, label: "record" },
        { selector: "#record-modal", label: "modal" },
      ],
    },
    timeout: 4000,
  });
  reached(r, `open record ${n}`);
  // The modal (if any) may arrive slightly after the record; check + dismiss.
  const modalUp = await s.evaluate(`!!document.getElementById('record-modal')`);
  if (modalUp) await acknowledgeAllergyModal(s);
  return s.store.latestJson(`/api/record/${n}`) as Record;
}

/** Dismiss the "Allergy Review Required" modal. */
export async function acknowledgeAllergyModal(s: Session) {
  reached(
    await s.click("#modal-ack", { until: { gone: "#record-modal" }, timeout: 3000 }),
    "ack allergy modal",
  );
}

// ---------------------------------------------------------------------------
// 3. Save — optimistic UI, async success/failure toast
// ---------------------------------------------------------------------------

/** Click Save and wait for the async status to land. Returns the real outcome
 *  from the wire status code (the body is never read by the page, so it is
 *  `missing`; the status code is authoritative). */
export async function save(s: Session): Promise<{ ok: boolean; status: number }> {
  await assertShell(s);
  reached(
    await s.click("#save", { until: { request: "/api/save/status" }, timeout: 5000 }),
    "save status landed",
  );
  const rows = s.store.requests({ url: "/api/save/status" });
  const status = rows.length ? rows[rows.length - 1].status ?? 0 : 0;
  return { ok: status === 200, status };
}

// ---------------------------------------------------------------------------
// 7. Debounced search (250 ms trailing XHR)
// ---------------------------------------------------------------------------

/** Type a query; wait for the debounced XHR; return hits from the wire. */
export async function search(s: Session, q: string): Promise<string[]> {
  await assertShell(s);
  reached(
    await s.fill("#search", q, { until: { request: "/api/search", landed: true }, timeout: 3000 }),
    "search landed",
  );
  const j = s.store.latestJson("/api/search");
  return j?.hits ?? [];
}

// ---------------------------------------------------------------------------
// 8. Virtualized rows — 10k rows, ~23 in the DOM
// ---------------------------------------------------------------------------

/** Load the rows; return the full list from the wire (NOT the DOM, which is
 *  windowed). Also returns how many .row nodes are actually mounted. */
export async function loadRows(s: Session): Promise<{ total: number; mounted: number; rows: any[] }> {
  await assertShell(s);
  reached(
    await s.click("#load-rows", { until: { request: "/api/rows", landed: true }, timeout: 3000 }),
    "rows landed",
  );
  const rows = (s.store.latestJson("/api/rows") as any[]) ?? [];
  const mounted = Number(await s.evaluate(`document.querySelectorAll('#rows .row').length`));
  return { total: rows.length, mounted, rows };
}

// ---------------------------------------------------------------------------
// 9. Re-render race
// ---------------------------------------------------------------------------

/** Click the self-replacing button reliably. Disables ctl.rerenderOnHover for
 *  the duration so a normal click can land, then restores it. */
export async function clickRerender(s: Session): Promise<number> {
  await assertShell(s);
  const prev = (await getCtl(s)).rerenderOnHover;
  await setCtl(s, { rerenderOnHover: false });
  try {
    const before = Number(await s.evaluate(`+document.getElementById('rerender-count').textContent`));
    reached(
      await s.click("#rerender", {
        until: { selector: `#rerender-count:text-is("${before + 1}")` },
        timeout: 3000,
      }),
      "rerender counted",
    );
    return before + 1;
  } finally {
    await setCtl(s, { rerenderOnHover: prev });
  }
}

// ---------------------------------------------------------------------------
// 10. Iframes (same-origin, nested depth-2, cross-origin)
// ---------------------------------------------------------------------------

/** Submit the same-origin iframe form. frameSel default "#same-origin";
 *  pass "#same-origin >> #nested2" for the depth-2 island, or the cross frame. */
export async function submitIframe(
  s: Session,
  name: string,
  opts: { frame?: string; nameSel?: string; submitSel?: string; api?: string } = {},
) {
  const frame = opts.frame ?? "#same-origin";
  const nameSel = opts.nameSel ?? "#if-name";
  const submitSel = opts.submitSel ?? "#if-submit";
  const api = opts.api ?? "/api/iframe-submit";
  reached(await s.fill(nameSel, name, { frame }), "iframe name");
  reached(
    await s.click(submitSel, { frame, until: { request: api, landed: true }, timeout: 3000 }),
    "iframe submit landed",
  );
  return s.store.latestJson(api);
}

export const submitNestedIframe = (s: Session, name: string) =>
  submitIframe(s, name, {
    frame: "#same-origin >> #nested2",
    nameSel: "#deep-name",
    submitSel: "#deep-submit",
    api: "/api/iframe-submit",
  });

export const submitCrossIframe = (s: Session, name: string) =>
  submitIframe(s, name, {
    frame: "#cross-origin",
    nameSel: "#xf-name",
    submitSel: "#xf-submit",
    api: "/api/xframe-submit",
  });

// ---------------------------------------------------------------------------
// 16. Canvas grid — pixels only
// ---------------------------------------------------------------------------

/** Click the canvas; the app exposes the selected cell as window.__gridSelected. */
export async function selectGridCell(s: Session): Promise<{ r: number; c: number } | null> {
  await assertShell(s);
  reached(
    await s.click("#grid", { until: { fn: "window.__gridSelected !== null" }, timeout: 2000 }),
    "grid cell selected",
  );
  return (await s.evaluate("window.__gridSelected")) as any;
}

// ---------------------------------------------------------------------------
// 17. Keyboard-only combobox
// ---------------------------------------------------------------------------

/** Pick a medication by keyboard: type, arrow to the option, Enter. Mouse
 *  clicks on options are ignored/occluded by design. index is 0-based. */
export async function pickMed(s: Session, query: string, index = 0): Promise<string> {
  await assertShell(s);
  reached(
    await s.type("#med", query, { until: { request: "/api/meds", landed: true }, timeout: 3000 }),
    "meds landed",
  );
  for (let i = 0; i <= index; i++) {
    reached(
      await s.press("ArrowDown", {
        target: "#med",
        until: { selector: `#med-opt-${i}[aria-selected="true"]` },
        timeout: 1500,
      }),
      `arrow to option ${i}`,
    );
  }
  reached(
    await s.press("Enter", {
      target: "#med",
      until: { selector: '#med-selected:has-text("Selected")' },
      timeout: 1500,
    }),
    "med selected",
  );
  return String(await s.evaluate(`document.getElementById('med-selected').textContent`)).replace(
    /^Selected:\s*/,
    "",
  );
}

// ---------------------------------------------------------------------------
// 18. Shadow DOM
// ---------------------------------------------------------------------------

export async function clickShadowButton(s: Session): Promise<number> {
  await assertShell(s);
  const cur = Number(
    await s.evaluate(`document.getElementById('shadow-host').shadowRoot.getElementById('shadow-count').textContent`),
  );
  reached(
    await s.click("#shadow-host >> #shadow-btn", {
      until: { selector: `#shadow-count:text-is("${cur + 1}")` },
      timeout: 2000,
    }),
    "shadow click counted",
  );
  return cur + 1;
}

// ---------------------------------------------------------------------------
// 19. Server-sent events
// ---------------------------------------------------------------------------

/** Start the SSE stream; wait for it to finish (5 events); return the events
 *  scraped from the log list. The response body itself is `missing`. */
export async function runSse(s: Session): Promise<string[]> {
  await assertShell(s);
  reached(
    await s.click("#start-sse", {
      until: { selector: '#sse-status:text-is("done")' },
      timeout: 8000,
    }),
    "sse done",
  );
  return (await s.evaluate(
    `[...document.querySelectorAll('#sse-log li')].map(l=>l.textContent)`,
  )) as string[];
}

// ---------------------------------------------------------------------------
// 20. GraphQL over POST
// ---------------------------------------------------------------------------

export async function gqlQuery(s: Session): Promise<any> {
  await assertShell(s);
  reached(
    await s.click("#gql-query", { until: { request: "/api/graphql", landed: true }, timeout: 3000 }),
    "gql query landed",
  );
  return s.store.latestJson("/api/graphql");
}

export async function gqlMutate(s: Session): Promise<any> {
  await assertShell(s);
  reached(
    await s.click("#gql-mutate", { until: { request: "/api/graphql", landed: true }, timeout: 3000 }),
    "gql mutation landed",
  );
  return s.store.latestJson("/api/graphql");
}

// ---------------------------------------------------------------------------
// 21. Auth
// ---------------------------------------------------------------------------

/** Log in (any credentials are accepted). Lands on `next` (default /secure.html).
 *  Sets cookie gauntlet_auth=<user>. */
export async function login(s: Session, user: string, pass: string, next = "/secure.html") {
  reached(
    await s.navigate(`http://localhost:4800/login.html?next=${encodeURIComponent(next)}`, {
      until: { selector: "#login" },
    }),
    "login page",
  );
  reached(await s.fill("#user", user), "user");
  reached(await s.fill("#pass", pass), "pass");
  // Wait on the landmark of the destination, not on {url:"/..."} which is a
  // substring test that is often already true.
  const landmark = next === "/secure.html" ? { selector: "#who" } : { selector: SHELL };
  reached(await s.click("#login", { until: landmark, timeout: 4000 }), "logged in");
}

// ---------------------------------------------------------------------------
// 23. Push channels
// ---------------------------------------------------------------------------

/** Inject one push notification over channel ("ws" | "sse" | "poll") and wait
 *  for #notif-count to advance. NOTE: "poll" only delivers when ctl.notify=true
 *  (this helper turns it on for the poll case). Returns the new notification. */
export async function pushNotification(s: Session, channel: "ws" | "sse" | "poll"): Promise<string> {
  await assertShell(s);
  if (channel === "poll") await setCtl(s, { notify: true, notifyPollHoldMs: 1500 });
  const before = Number(await s.evaluate(`+document.getElementById('notif-count').textContent`));
  await setCtl(s, { push: channel });
  reached(
    await s.until(
      { fn: `+document.getElementById('notif-count').textContent > ${before}` },
      { timeout: 5000 },
    ),
    `push ${channel} arrived`,
  );
  const text = String(
    await s.evaluate(`[...document.querySelectorAll('#notif-list li')].pop()?.textContent`),
  );
  if (channel === "poll") await setCtl(s, { notify: false });
  return text;
}

// ---------------------------------------------------------------------------
// 24. Context menu
// ---------------------------------------------------------------------------

export async function contextMenuAction(s: Session, item: "Open" | "Rename" | "Delete") {
  await assertShell(s);
  reached(
    await s.rightclick("#ctx-target", { until: { selector: "#ctx-menu", visible: true }, timeout: 2000 }),
    "ctx menu open",
  );
  const id = { Open: "#ctx-open", Rename: "#ctx-rename", Delete: "#ctx-delete" }[item];
  // The menu is position:fixed at the pointer's viewport Y, so its items can sit
  // below the fold where Playwright cannot scroll a fixed element into view.
  // The click handler is delegated on #ctx-menu, so a dispatched event (js:true)
  // reaches it without any actionability/scroll step.
  reached(
    await s.click(id, { js: true, until: { selector: `#ctx-result:has-text("${item}")` }, timeout: 1500 }),
    `ctx ${item}`,
  );
  return String(await s.evaluate(`document.getElementById('ctx-result').textContent`));
}

// ---------------------------------------------------------------------------
// 25. Double-click to edit
// ---------------------------------------------------------------------------

export async function editInline(s: Session, value: string): Promise<string> {
  await assertShell(s);
  reached(await s.dblclick("#dbl-target", { until: { selector: "#dbl-input" }, timeout: 2000 }), "editing");
  reached(await s.fill("#dbl-input", value), "typed");
  reached(
    await s.press("Enter", {
      target: "#dbl-input",
      until: { selector: `#dbl-state:has-text("committed")` },
      timeout: 1500,
    }),
    "committed",
  );
  return String(await s.evaluate(`document.getElementById('dbl-state').textContent`));
}

// ---------------------------------------------------------------------------
// 26. Drags
// ---------------------------------------------------------------------------

/** Drag the slider thumb to the track (lands near the drop x); returns value. */
export async function dragSlider(s: Session): Promise<number> {
  await assertShell(s);
  reached(
    await s.drag("#slider-thumb", "#slider-track", {
      until: { request: "/api/drag-report", landed: true },
      timeout: 3000,
    }),
    "slider drag reported",
  );
  return Number(await s.evaluate(`+document.getElementById('slider-value').textContent`));
}

/** Reorder: drag one list item onto another; returns the new order string. */
export async function reorder(s: Session, from = "#sort-a", to = "#sort-c"): Promise<string> {
  await assertShell(s);
  reached(
    await s.drag(from, to, { until: { request: "/api/drag-report", landed: true }, timeout: 3000 }),
    "reorder reported",
  );
  return String(await s.evaluate(`document.getElementById('sort-order').textContent`));
}

// ---------------------------------------------------------------------------
// 14. Delete (write endpoint)
// ---------------------------------------------------------------------------

export async function deleteItem(s: Session): Promise<number> {
  await assertShell(s);
  reached(
    await s.click("#delete", { until: { request: "/api/item/1", landed: true }, timeout: 3000 }),
    "delete landed",
  );
  return s.store.latestJson("/api/item/1")?.deleted ?? -1;
}
