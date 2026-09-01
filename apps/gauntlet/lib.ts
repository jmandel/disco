// apps/gauntlet/lib.ts
// Workflows for the disco "gauntlet" test app, as importable functions.
// Convention: anchor in -> anchor out, an `until` on every transition,
// wire-first reads, and reached(...) on every step so failures explain themselves.
//
// The app is a single server-rendered page (/) driven by app.js. Server-side
// behavior is tuned through /ctl (see setCtl/resetCtl). Nothing here sleeps.

import { reached, type Session } from "../../src/index.ts";

export const HOME = "http://localhost:4800";

// ---------------------------------------------------------------------------
// ctl: the server-side knob store. GET reads, POST merges, POST /ctl/reset
// restores defaults. We drive it from inside the page so cookies/origin match.
// ---------------------------------------------------------------------------

export type Ctl = Record<string, unknown>;

export async function getCtl(s: Session): Promise<Ctl> {
  return (await s.evaluate(`fetch("/ctl").then(r=>r.json())`)) as Ctl;
}

export async function setCtl(s: Session, patch: Ctl): Promise<Ctl> {
  return (await s.evaluate(
    `fetch("/ctl",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(${JSON.stringify(
      patch,
    )})}).then(r=>r.json())`,
  )) as Ctl;
}

export async function resetCtl(s: Session): Promise<void> {
  await s.evaluate(`fetch("/ctl/reset",{method:"POST"}).then(r=>r.text())`);
}

export async function pushNotify(s: Session, via: "ws" | "sse" | "poll"): Promise<void> {
  await s.evaluate(
    `fetch("/ctl",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({push:${JSON.stringify(
      via,
    )}})}).then(r=>r.json())`,
  );
}

// The shell anchor: the app's own header status line is always present on "/".
export async function atShell(s: Session, timeout = 2000) {
  return reached(
    await s.until({ selector: "#statusbar", label: "shell" }, { timeout }),
    "not on the gauntlet shell",
  );
}

export async function goHome(s: Session) {
  reached(await s.navigate(HOME, { until: { selector: "#statusbar", label: "shell" } }));
  return atShell(s);
}

// ---------------------------------------------------------------------------
// 1. Load Chart — three concurrent fetches, one slow.
// ---------------------------------------------------------------------------
export async function loadChart(s: Session) {
  await atShell(s);
  // Note: #chart-status stays "idle" — the app writes the result into the
  // #chart div, not the status span. Anchor on #chart.
  const r = reached(
    await s.click("#load-chart", {
      until: { selector: "#chart:has-text('Chart loaded')", label: "loaded" },
      timeout: 4000,
    }),
  );
  // wire-first: the slow response carries the round-trip ms it waited
  const slow = s.store.latestJson("/api/slow");
  return { act: r.action, slow };
}

// ---------------------------------------------------------------------------
// 2. Records — GET /api/record/N; optional allergy modal when ctl.modal.
// The record body is the source of truth (read it off the wire).
// The modal, when present, occludes the page until acknowledged.
// ---------------------------------------------------------------------------
export async function openRecord(s: Session, id: number) {
  await atShell(s);
  const r = reached(
    await s.click(`#record-${id}`, {
      until: { selector: `#record h3:has-text('Record ${id}')`, label: "record" },
      timeout: 4000,
    }),
  );
  const record = s.store.latestJson(`/api/record/${id}`);
  const hasModal =
    (await s.evaluate(`!!document.querySelector('#record-modal')`)) === true;
  return { act: r.action, record, hasModal };
}

// Acknowledge the allergy modal if it is open. Idempotent both ways.
export async function ackModalIfPresent(s: Session) {
  const open = (await s.evaluate(`!!document.querySelector('#record-modal')`)) === true;
  if (!open) return false;
  reached(
    await s.click("#modal-ack", { until: { gone: "#record-modal", label: "closed" }, timeout: 3000 }),
  );
  return true;
}

// ---------------------------------------------------------------------------
// 3. Save — optimistic UI ("Saved ✓" immediately), async outcome as a toast.
// The client checks Response.ok but never reads the status body, so a
// {request:"/api/save/status", landed:true} predicate NEVER fires. The toast
// [role=status] is the real postcondition. Returns "ok" | "fail".
// ---------------------------------------------------------------------------
export async function save(s: Session): Promise<{ act: string; outcome: "ok" | "fail" }> {
  await atShell(s);
  // clear any stale toast so has-text() can't match a previous one (alreadyTrue)
  await s.until({ gone: "[role=status]" }, { timeout: 2500 }).catch(() => {});
  const r = reached(
    await s.click("#save", {
      until: {
        any: [
          { selector: "[role=status]:has-text('Save failed')", label: "fail" },
          { selector: "[role=status]:has-text('Saved')", label: "ok" },
        ],
      },
      timeout: 4000,
    }),
  );
  return { act: r.action, outcome: r.until!.which === "fail" ? "fail" : "ok" };
}

// ---------------------------------------------------------------------------
// 7. Debounced search — 250 ms trailing XHR. Read hits off the wire.
// ---------------------------------------------------------------------------
export async function search(s: Session, q: string): Promise<{ act: string; hits: string[] }> {
  await atShell(s);
  const r = reached(
    await s.type("#search", q, {
      until: { request: `/api/search?q=${encodeURIComponent(q)}`, landed: true, label: "search" },
      timeout: 4000,
    }),
  );
  const body = s.store.latestJson("/api/search") as { q: string; hits: string[] } | null;
  return { act: r.action, hits: body?.hits ?? [] };
}

// ---------------------------------------------------------------------------
// 8. Virtualized rows — 10000 rows, only ~two dozen mounted. Total count comes
// from the wire; the DOM only ever holds the visible window.
// ---------------------------------------------------------------------------
export async function loadRows(s: Session) {
  await atShell(s);
  const r = reached(
    await s.click("#load-rows", {
      until: { selector: "#rows-count:has-text('rows')", label: "loaded" },
      timeout: 4000,
    }),
  );
  const rows = s.store.latestJson("/api/rows") as Array<unknown> | null;
  const mounted = (await s.evaluate(`document.querySelectorAll('#rows-inner > *').length`)) as number;
  return { act: r.action, total: rows?.length ?? 0, mounted };
}

// Scroll the virtual list and wait for it to re-render (first mounted row changes).
export async function scrollRowsTo(s: Session, top: number) {
  const before = await s.evaluate(`document.querySelector('#rows-inner > *')?.dataset.id`);
  await s.evaluate(`document.getElementById('rows').scrollTop = ${top}`);
  reached(
    await s.until(
      { fn: `document.querySelector('#rows-inner > *')?.dataset.id !== ${JSON.stringify(before)}`, label: "rerender" },
      { timeout: 2000 },
    ),
  );
  return {
    firstId: await s.evaluate(`document.querySelector('#rows-inner > *')?.dataset.id`),
    mounted: (await s.evaluate(`document.querySelectorAll('#rows-inner > *').length`)) as number,
  };
}

// ---------------------------------------------------------------------------
// 17. Keyboard-only combobox — type (keystrokes), ArrowDown, Enter.
// fill() does not work; the widget only listens to keystrokes.
// ---------------------------------------------------------------------------
export async function pickMed(s: Session, q: string): Promise<{ act: string; selected: string }> {
  await atShell(s);
  reached(
    await s.type("#med", q, {
      until: { request: "/api/meds", landed: true, label: "meds" },
      timeout: 4000,
    }),
  );
  reached(
    await s.press("ArrowDown", {
      target: "#med",
      until: { selector: "#med-list li[aria-selected='true']", label: "highlight" },
      timeout: 3000,
    }),
  );
  const r = reached(
    await s.press("Enter", {
      target: "#med",
      until: { selector: "#med-selected:has-text('Selected')", label: "picked" },
      timeout: 3000,
    }),
  );
  const selected = (await s.evaluate(`document.getElementById('med-selected').textContent`)) as string;
  return { act: r.action, selected };
}

// ---------------------------------------------------------------------------
// 20. GraphQL over POST.
// ---------------------------------------------------------------------------
export async function gqlQuery(s: Session) {
  await atShell(s);
  const r = reached(
    await s.click("#gql-query", { until: { request: "/api/graphql", landed: true, label: "gql" }, timeout: 4000 }),
  );
  return { act: r.action, body: s.store.latestJson("/api/graphql") };
}

export async function gqlMutate(s: Session) {
  await atShell(s);
  const r = reached(
    await s.click("#gql-mutate", { until: { request: "/api/graphql", landed: true, label: "gql" }, timeout: 4000 }),
  );
  return { act: r.action, body: s.store.latestJson("/api/graphql") };
}

// ---------------------------------------------------------------------------
// 21. Auth — requireAuth gates /secure.html behind /login.html.
// Any non-empty user/pass logs in (cookie gauntlet_auth=<user>).
// Do NOT use {url:"/secure.html"} — the login URL is ?next=/secure.html and
// would match already. Use location.pathname.
// ---------------------------------------------------------------------------
export async function login(s: Session, user: string, pass: string) {
  // must be on the login page
  reached(
    await s.until({ fn: "location.pathname === '/login.html'", label: "login-page" }, { timeout: 3000 }),
    "not on the login page",
  );
  reached(await s.fill("#user", user));
  reached(await s.fill("#pass", pass));
  const r = reached(
    await s.click("#login", {
      until: {
        any: [
          { fn: "location.pathname === '/secure.html'", label: "secure" },
          { selector: "#login-error:has-text('login failed')", label: "error" },
        ],
      },
      timeout: 5000,
    }),
  );
  if (r.until!.which === "error") throw new Error("login failed");
  return { act: r.action };
}

// Navigate to the secure area, logging in if redirected. Returns the greeting.
export async function enterSecure(s: Session, user = "admin", pass = "hunter2") {
  reached(
    await s.navigate(`${HOME}/secure.html`, {
      until: {
        any: [
          { fn: "location.pathname === '/secure.html'", label: "secure" },
          { fn: "location.pathname === '/login.html'", label: "login" },
        ],
      },
      timeout: 4000,
    }),
  );
  if ((await s.evaluate("location.pathname")) === "/login.html") {
    await login(s, user, pass);
  }
  reached(await s.until({ selector: "h1:has-text('Secure area')", label: "secure" }, { timeout: 3000 }));
  return (await s.evaluate(`document.querySelector('p')?.textContent`)) as string;
}

// ---------------------------------------------------------------------------
// 9. Re-render race — the button is swapped out every 100 ms and on hover.
// A normal Playwright click races the detach and times out. The click handler
// is delegated on #rerender-host, so a programmatic click always lands.
// ---------------------------------------------------------------------------
export async function clickRerender(s: Session) {
  await atShell(s);
  const before = Number(await s.evaluate(`document.getElementById('rerender-count').textContent`));
  await s.evaluate(`document.getElementById('rerender').click()`);
  reached(
    await s.until(
      { fn: `Number(document.getElementById('rerender-count').textContent) > ${before}`, label: "counted" },
      { timeout: 2000 },
    ),
  );
  return Number(await s.evaluate(`document.getElementById('rerender-count').textContent`));
}

// ---------------------------------------------------------------------------
// 14. Delete (write endpoint).
// ---------------------------------------------------------------------------
export async function deleteItem(s: Session) {
  await atShell(s);
  const r = reached(
    await s.click("#delete", { until: { selector: "#delete-result:has-text('deleted')", label: "done" }, timeout: 3000 }),
  );
  return { act: r.action, body: s.store.latestJson("/api/item/1") };
}

// ---------------------------------------------------------------------------
// 23. Push channels — trigger one notification over ws | sse | poll and wait
// for #notif-count to advance. The poll channel only runs when ctl.notify.
// ---------------------------------------------------------------------------
export async function notifyVia(s: Session, via: "ws" | "sse" | "poll") {
  await atShell(s);
  if (via === "poll") await setCtl(s, { notify: true, notifyPollHoldMs: 800 });
  const before = Number(await s.evaluate(`document.getElementById('notif-count').textContent`));
  await pushNotify(s, via);
  const r = reached(
    await s.until(
      { fn: `Number(document.getElementById('notif-count').textContent) > ${before}`, label: `notif-${via}` },
      { timeout: 5000 },
    ),
  );
  const last = (await s.evaluate(`document.querySelector('#notif-list li:last-child')?.textContent`)) as string;
  return { act: r.action, last };
}
