// Function library for **the gauntlet** — a single-page app served at http://localhost:4800/ that packs
// 26 numbered sections, each a different way for naive UI automation to be wrong. Product instance #5.
// Plain, importable, composable, anchor-oriented, wire-first, defensive functions.
//
//   import { connect } from "../../src/client.ts";
//   import * as g from "./lib.ts";
//   const s = await connect("gauntlet");
//   await g.registerRules(s);                       // ambient overrides, with evidence (see nav-and-quirks §2)
//   await g.home(s);                                // anchor: the shell
//   const chart = await g.loadChart(s);             // 3 concurrent fetches, one 400ms slow; wire-first
//   const rec = await g.openRecord(s, 2);           // handles the "Allergy Review Required" modal both ways
//   const rows = await g.loadRows(s);               // 10,000 rows off the wire — the DOM renders ~23
//   await g.save(s);                                // WRITE, verified on the wire (the screen lies)
//
// ===========================================================================================
// WRITE FOOTPRINT — declared honestly, per GUIDANCE §9.
//   READ-ONLY (every request they issue is a GET, or a POST the server answers as a read):
//     home, loadChart, openRecord, loadRows, findRow, search, selectMedication, graphqlQuery,
//     startSse, dismissBlockers, readCanvasGrid, waitForPush, assertShell.
//     * `graphqlQuery` POSTs to /api/graphql but the daemon classifies that request `write_kind=read`
//       (body peek: `operation: "query"`, `sawMutation:false`) — observed act:21.
//   WRITES (they change server state — refuse to run these under a read-only stance):
//     save            -> POST /api/save (202) then the app's own GET /api/save/status   (act:4, act:37)
//     deleteItem      -> DELETE /api/item/<id>                                          (act:5)
//     graphqlMutate   -> POST /api/graphql with a `mutation` (write_kind=write)         (act:22)
//     login           -> POST /api/login (sets an HttpOnly session cookie)              (act:41)
//     setScenario     -> POST /ctl  (the app's own scenario-control channel; changes app
//                        behaviour globally for every viewer — see nav-and-quirks §1)   (act:32 etc.)
//   INCIDENTAL, unavoidable through the UI: every click on a button EXCEPT `#noop` makes the page send
//   a WebSocket `{"type":"echo", …}` frame on ws://localhost:4800/ws. It changes no server state but it
//   does bump the header counter, so the aria delta of every act carries the status bar (act:1..act:63).
// ===========================================================================================
import type { Session } from "../../src/client.ts";
import { reached, until, assertVisible, actIfPresent } from "../../lib/nav.ts";
import { extractFromWire } from "../../lib/wire.ts";

export const BASE = "http://localhost:4800";
export const XORIGIN = "http://localhost:4801";      // the cross-origin iframe island

/** The shell anchor: section 1's button exists only on the app's own page (not /away.html, /login.html,
 *  /secure.html, /child.html — all of which are real states this app can leave you in). */
export const SHELL = "#load-chart";
/** The two overlays that occlude EVERYTHING when they are up (both `role=dialog[aria-modal]`). */
export const RECORD_MODAL = "#record-modal";
export const RECORD_MODAL_ACK = "#modal-ack";
export const EXPIRY_MODAL = "#session-timeout";
export const EXPIRY_STAY = "#stay";

// ---------------------------------------------------------------------------------------------
// Per-app rules — ambient overrides, each with its measured evidence (nav-and-quirks.md §2)
// ---------------------------------------------------------------------------------------------

/** Register this product's attribution rules. Idempotent (rules dedupe per app).
 *
 *  The gauntlet ships its ambient traffic **off** (`ctl.ambient === false` at boot), so a session that
 *  never turns it on has nothing to learn and the classifier stays empty — correct, but it means the
 *  moment anything flips `ambient:true` the heartbeat/long-poll start holding settlement open until the
 *  classifier has three samples. These three rules are the conclusions of a measured 26s idle
 *  observation with ambient ON (`disco idle 26000` -> "33 families, 3 ambient"), promoted into the pack
 *  so a fresh run confirms instead of re-learning:
 *    GET /api/heartbeat   ×5 periodic, ctl.heartbeatMs = 5000
 *    GET /api/poll        ×9 periodic — a long-poll held ctl.pollHoldMs = 3000 then re-issued
 *    GET /api/notify-sse  ×4 periodic — the EventSource opened at page load and re-connected
 *  NOT ignored deliberately: GET /api/sse (section 19) — same shape, but it is the *result* of clicking
 *  #start-sse and must stay attributed. And /favicon.ico, which the classifier eyed (cv 1.58) but never
 *  reached, is left alone: it only fires on navigation, and it is harmless there. */
export async function registerRules(s: Session): Promise<void> {
  await s.ignore("/api/heartbeat");
  await s.ignore("/api/poll");
  await s.ignore("/api/notify-sse");
}

// ---------------------------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------------------------

/** Assert we are on the gauntlet shell (cheap: URL + the section-1 landmark). Throws with a diagnosis. */
export async function assertShell(s: Session): Promise<void> {
  await assertVisible(s, SHELL, "anchor not reached: gauntlet shell (#load-chart)");
}

/** Reach the shell anchor. Idempotent: if we are already there it costs one in-page predicate and no
 *  navigation. Clears whichever of the two blocking overlays happens to be up first, because both of
 *  them survive a scenario reset and occlude every subsequent click (act:48, act:55). */
export async function home(s: Session): Promise<void> {
  await dismissBlockers(s);
  if (await s.evaluate<boolean>(() => !!document.querySelector("#load-chart"))) return;
  reached(await s.navigate(`${BASE}/`, { until: { selector: SHELL, visible: true } }), "home");
  await dismissBlockers(s);
}

/** Dismiss the two modal overlays if either is up; returns which ones it cleared. Present-or-absent is
 *  first-class — the absent path pays only the watch budget and never throws. Budgets are short because
 *  both overlays are already in the DOM when they matter; the *delayed* one is handled in openRecord. */
export async function dismissBlockers(s: Session): Promise<string[]> {
  const cleared: string[] = [];
  if (await actIfPresent(s, EXPIRY_STAY, { budgetMs: 400 })) cleared.push("session-expiry");
  if (await actIfPresent(s, RECORD_MODAL_ACK, { budgetMs: 400 })) cleared.push("record-modal");
  return cleared;
}

// ---------------------------------------------------------------------------------------------
// Section 1 — Load Chart: three concurrent fetches, one slow, and a render that lags the wire
// ---------------------------------------------------------------------------------------------

export interface Chart { series: { series: string; points: number[] }[]; slowMs: number; status: string }

/** Click "Load Chart" and return the three responses **off the wire**, not the DOM.
 *
 *  The trap this function exists for: settlement closes when the network goes quiet (~450ms, gated by
 *  GET /api/slow), but the app renders `#chart-status = "idle"` `ctl.renderDelayMs` later. With the
 *  default 0 they coincide; with renderDelayMs=900 the same click reports `settled:network` at 415ms
 *  while the screen still says "loading…" (act:35 — verdict true, state wrong). The postcondition is on
 *  the act, so the causality window stays open and all three bodies land attributed either way
 *  (act:36: settled 591ms, until matched 618ms). */
export async function loadChart(s: Session, opts: { budgetMs?: number } = {}): Promise<Chart> {
  await assertShell(s);
  const r = reached(await s.click(SHELL, {
    budgetMs: opts.budgetMs ?? 8000,
    until: { fn: () => document.querySelector("#chart-status")?.textContent === "idle", budgetMs: opts.budgetMs ?? 8000 },
    evaluateAfter: () => document.querySelector("#chart-status")?.textContent ?? "",
  }), "loadChart");
  const series = ["a", "b"].map((k) => extractFromWire<{ series: string; points: number[] }>(s.store, { urlLike: `/api/chart/${k}` }));
  const slow = extractFromWire<{ ms: number }>(s.store, { urlLike: "/api/slow" });
  return { series, slowMs: slow.ms, status: String(r.evaluateAfter ?? "") };
}

// ---------------------------------------------------------------------------------------------
// Section 2 — Records: the conditional interstitial, handled BOTH ways
// ---------------------------------------------------------------------------------------------

export interface RecordData { id: number; name: string; dob: string; mrn: string; allergies: string[] }

/** Open record `id` and return it off `GET /api/record/<id>`.
 *
 *  The interstitial: when `ctl.modal` is true the app raises `#record-modal` ("Allergy Review Required")
 *  `ctl.modalDelayMs` (400ms) **after** the click has already settled — so the act itself succeeds and
 *  the NEXT click is the one that dies (`diagnosis: occluded by #record-modal`, act:33). It is therefore
 *  wrong to look for the modal before settlement and wrong to assume it will never come: this waits for
 *  the record body (the real postcondition), then gives the delayed overlay a budget it is allowed to
 *  miss. `ack:false` leaves it standing on purpose, for callers testing the blocked path.
 *  Evidence: absent path act:8; present path act:32 + act:34. */
export async function openRecord(s: Session, id: number, opts: { ack?: boolean } = {}): Promise<RecordData> {
  await assertShell(s);
  reached(await s.click(`#record-${id}`, {
    until: { all: [{ urlLike: `/api/record/${id}`, landed: true }, { selector: `#record >> text=Record ${id}` }] },
  }), `openRecord(${id})`);
  if (opts.ack !== false) await actIfPresent(s, RECORD_MODAL_ACK, { budgetMs: 900 });   // present OR absent
  return extractFromWire<RecordData>(s.store, { urlLike: `/api/record/${id}` });
}

/** Is the "Allergy Review Required" overlay standing? `budgetMs` matters: the app raises it
 *  `ctl.modalDelayMs` (400ms) AFTER the click settles, so a 0-budget check immediately after
 *  `openRecord(..., {ack:false})` answers **false** and is wrong — the first check run failed exactly
 *  there (`modalUp:false` at 467ms). Pass a budget that covers modalDelayMs to ask "will it come?";
 *  pass 0 only to ask "is it up right now?" (which is what `dismissBlockers` wants). */
export async function recordModalUp(s: Session, budgetMs = 0): Promise<boolean> {
  return !!(await s.watch({ selector: RECORD_MODAL, visible: true }, { budgetMs })).matched;
}

// ---------------------------------------------------------------------------------------------
// Section 8 — Virtualized rows: the fact the DOM never shows
// ---------------------------------------------------------------------------------------------

export interface Row { id: number; name: string; group: string }

/** Load the row set and return **all 10,000 rows from the response body**.
 *  The DOM is virtualized: `#rows` is a 400px-tall `overflow:auto` box over a 240,000px spacer holding
 *  ~23 recycled `.row` nodes (measured: scrollTop 0 -> "Aardvark-Row-0"; scrollTop 120000 -> the same
 *  23-28 nodes now reading "Zebra-Row-4995"). Scraping it can never see row 9,999; `GET /api/rows`
 *  carries every row in one 200 (act:6). This is the flow that reads a fact the screen does not have. */
export async function loadRows(s: Session): Promise<Row[]> {
  await assertShell(s);
  reached(await s.click("#load-rows", {
    until: { all: [{ urlLike: "/api/rows", landed: true }, { fn: () => /\d+ rows/.test(document.querySelector("#rows-count")?.textContent ?? "") }] },
  }), "loadRows");
  return extractFromWire<Row[]>(s.store, { urlLike: "/api/rows" });
}

/** Find one row by exact name across the whole 10,000 — impossible from the rendered DOM. */
export async function findRow(s: Session, name: string): Promise<Row | undefined> {
  return (await loadRows(s)).find((r) => r.name === name);
}

/** How many `.row` nodes the DOM actually holds right now (the virtualization proof, for the ledger). */
export async function renderedRowCount(s: Session): Promise<number> {
  return await s.evaluate<number>(() => document.querySelectorAll("#rows .row").length);
}

// ---------------------------------------------------------------------------------------------
// Section 3 — Save: optimistic UI. The screen lies; the wire does not.
// ---------------------------------------------------------------------------------------------

export interface SaveResult { ok: boolean; statusCode: number; screen: string; saveId: number }

/** ***WRITE*** — POST /api/save.
 *
 *  The app flips `#save-state` to "Saved ✓" synchronously, POSTs, gets `202 {pending:true}`, and only
 *  ~1.8s later asks `GET /api/save/status` whether it really saved. When `ctl.saveFails` is set that
 *  second request returns **500** and the screen still reads "Saved ✓" — permanently (act:37; the only
 *  on-screen tell is a 2s toast, gone before most scripts look). So the return value's `ok` comes from
 *  the attributed status code, never from the DOM. `throwOnFailure` (default) turns the lie into an
 *  exception. The status body itself is `[unread]` — the page never reads it — so the *code* is the
 *  fact, and `landed:true` is what waits for it. */
export async function save(s: Session, opts: { throwOnFailure?: boolean } = {}): Promise<SaveResult> {
  await assertShell(s);
  const r = reached(await s.click("#save", {
    until: { urlLike: "/api/save/status", landed: true, budgetMs: 8000 },
    evaluateAfter: () => document.querySelector("#save-state")?.textContent ?? "",
  }), "save");
  const status = r.wire?.attributed?.find((a) => a.p.includes("/api/save/status"));
  const posted = r.wire?.attributed?.find((a) => a.p.endsWith("/api/save"));
  if (!status) throw new Error(`save: no /api/save/status in the attributed window (verdict ${r.verdict}) — the app never confirmed`);
  const body = posted?.body ? s.store.json(posted.body) as { id: number } : { id: -1 };
  const out: SaveResult = { ok: status.s === 200, statusCode: status.s ?? 0, screen: String(r.evaluateAfter ?? ""), saveId: body.id };
  if (!out.ok && opts.throwOnFailure !== false)
    throw new Error(`save failed on the wire: GET /api/save/status -> ${out.statusCode} while the screen reads ${JSON.stringify(out.screen)} (optimistic UI)`);
  return out;
}

/** ***WRITE*** — DELETE /api/item/<id>. Idempotent server-side (repeat deletes answer 200 the same way);
 *  the postcondition is the DOM receipt AND the response, so a swallowed click cannot pass. (act:5) */
export async function deleteItem(s: Session, id = 1): Promise<{ deleted: number }> {
  await assertShell(s);
  reached(await s.click("#delete", {
    until: { all: [{ urlLike: `/api/item/${id}`, landed: true }, { fn: () => /deleted/.test(document.querySelector("#delete-result")?.textContent ?? "") }] },
  }), `deleteItem(${id})`);
  return extractFromWire<{ deleted: number }>(s.store, { urlLike: `/api/item/${id}` });
}

// ---------------------------------------------------------------------------------------------
// Section 7 — Debounced search   |   Section 17 — keyboard-only combobox
// ---------------------------------------------------------------------------------------------

/** Type into the 250ms-trailing-debounced search box and return the hits **off `GET /api/search`**.
 *  `fill` replaces (real key events, so the debounce still fires); the postcondition is the response,
 *  not the keystrokes — waiting on the DOM alone races the trailing XHR. (act:9) */
export async function search(s: Session, term: string): Promise<{ q: string; hits: string[] }> {
  await assertShell(s);
  reached(await s.fill("#search", term, {
    until: { urlLike: `/api/search?q=${encodeURIComponent(term)}`, landed: true, budgetMs: 6000 },
  }), `search(${term})`);
  // The body echoes the query it actually ran: `{"q":"ad","hits":[…]}`. That echo is the debounce proof —
  // two keystrokes produced ONE request, `q=ad`, never `q=a` (contrast /api/meds, one per keystroke).
  return extractFromWire<{ q: string; hits: string[] }>(s.store, { urlLike: "/api/search?q=" });
}

/** Section 17's combobox is **genuinely keyboard-only**: the options render but are not hit-testable —
 *  a click on `#med-opt-1` comes back `diagnosis: occluded by <section id="s-17">` (act:55). The recipe,
 *  verbatim and verified (act:57..act:60):
 *      fill #med ""  ->  type #med "<prefix>"  ->  press ArrowDown  (xN, aria-selected walks the list)
 *      ->  press Enter  ->  #med-selected reads "Selected: <name>"
 *  Note the input is NOT debounced (unlike #search): typing "as" fired TWO `/api/meds` requests, one per
 *  keystroke (act:10) — so `type` (appends, one event per char) is the honest spelling here.
 *  `index` is 1-based: 1 = the first option. */
export async function selectMedication(s: Session, prefix: string, index = 1): Promise<string> {
  await assertShell(s);
  await s.fill("#med", "");
  reached(await s.type("#med", prefix, {
    until: { all: [{ urlLike: "/api/meds", landed: true }, { selector: "#med-list >> css=li" }] },
  }), `selectMedication(${prefix}): options`);
  for (let i = 0; i < index; i++)
    reached(await s.press("ArrowDown", { until: { selector: `css=#med-opt-${i}[aria-selected="true"]` } }), `ArrowDown ${i + 1}`);
  reached(await s.press("Enter", {
    until: { fn: () => /^Selected: .+/.test(document.querySelector("#med-selected")?.textContent ?? "") },
    evaluateAfter: () => document.querySelector("#med-selected")?.textContent ?? "",
  }), "selectMedication: commit");
  return (await s.evaluate<string>(() => document.querySelector("#med-selected")?.textContent ?? "")).replace(/^Selected:\s*/, "");
}

// ---------------------------------------------------------------------------------------------
// Section 21 — Auth: the interstitial that is a whole page
// ---------------------------------------------------------------------------------------------

/** ***WRITE*** (POST /api/login; sets an HttpOnly cookie — `document.cookie` stays empty).
 *
 *  Reach `/secure.html`, logging in only if the app asks. With `ctl.requireAuth` false the link goes
 *  straight through; with it true, `GET /secure.html` answers **302 -> /login.html?next=/secure.html`**
 *  and the form appears (act:38). Both paths are first-class here — this is the "handles an interstitial
 *  both ways" flow at page granularity. Credentials: the server accepts **any non-empty pair** (probed
 *  `nobody`/`wrong` -> "Welcome, nobody", act:41); empty user or pass is refused
 *  `401 {"ok":false,"error":"user and pass required"}`. There is no password check to characterize. */
export async function openSecureArea(s: Session, user = "disco", pass = "disco"): Promise<{ loggedIn: boolean; welcome: string }> {
  reached(await s.navigate(`${BASE}/secure.html`, {
    until: { any: [{ selector: "#login", name: "login-required" }, { fn: () => /Secure area/.test(document.body.textContent ?? ""), name: "already-in" }], budgetMs: 8000 },
  }), "openSecureArea");
  let loggedIn = false;
  if ((await s.watch({ selector: "#login", visible: true }, { budgetMs: 0 })).matched) {
    await s.fill("#user", user);
    await s.fill("#pass", pass);
    reached(await s.click("#login", {
      until: { any: [{ fn: () => /Secure area/.test(document.body.textContent ?? ""), name: "ok" }, { selector: "#login-error", name: "refused" }], budgetMs: 8000 },
    }), "login");
    if ((await s.watch({ selector: "#login-error", visible: true }, { budgetMs: 0 })).matched)
      throw new Error(`login refused: ${await s.evaluate(() => document.querySelector("#login-error")?.textContent)}`);
    loggedIn = true;
  }
  await until(s, { fn: () => /Secure area/.test(document.body.textContent ?? "") }, { budgetMs: 3000, msg: "anchor not reached: secure area" });
  const welcome = await s.evaluate<string>(() => document.querySelector("main p, p")?.textContent ?? "");
  return { loggedIn, welcome };
}

// ---------------------------------------------------------------------------------------------
// Section 20 — GraphQL over POST: a read and a write behind one URL
// ---------------------------------------------------------------------------------------------

/** Read over POST. `POST /api/graphql` with a `query` operation is classified `write_kind=read` by the
 *  daemon's body peek and never trips the write flag (act:21) — the counterpart to `graphqlMutate`. */
export async function graphqlQuery(s: Session): Promise<any> {
  await assertShell(s);
  reached(await s.click("#gql-query", { until: { urlLike: "/api/graphql", landed: true } }), "graphqlQuery");
  return extractFromWire<any>(s.store, { urlLike: "/api/graphql" });
}

/** ***WRITE*** — the same URL with a `mutation` operation; `write_kind=write`, write flag fires (act:22). */
export async function graphqlMutate(s: Session): Promise<any> {
  await assertShell(s);
  reached(await s.click("#gql-mutate", { until: { urlLike: "/api/graphql", landed: true } }), "graphqlMutate");
  return extractFromWire<any>(s.store, { urlLike: "/api/graphql" });
}

// ---------------------------------------------------------------------------------------------
// Sections 19 / 23 — standing channels: SSE stream, and results delivered by push
// ---------------------------------------------------------------------------------------------

/** Start the 5-event SSE stream (section 19) and wait for `n` events **in the store**, not the DOM.
 *  `GET /api/sse`'s body is never captured (`body_state=streaming`) — the facts are rows in `sse_events`
 *  (act:23 attributed events 1-2; the tail arrives after settlement and lands unattributed or on the
 *  next action — an honest instance of "results on a standing channel"). */
export async function startSse(s: Session, n = 5): Promise<string[]> {
  await assertShell(s);
  reached(await s.click("#start-sse", {
    budgetMs: 10000,
    until: { fn: (want: number) => document.querySelectorAll("#sse-log li").length >= want, fnArg: n, budgetMs: 10000 },
  }), "startSse");
  return await s.evaluate<string[]>(() => [...document.querySelectorAll("#sse-log li")].map((l) => l.textContent ?? ""));
}

/** ***WRITE*** — POST /ctl. The app's own scenario-control channel (it advertises it in section 23's own
 *  copy: `POST /ctl {"push":"ws"|"sse"|"poll"}`). It rewrites *global* app behaviour, so it is a write in
 *  the fullest sense; every flow above that mentions a `ctl.*` key is describing state this sets.
 *  Returns the full server state after the patch. */
export async function setScenario(s: Session, patch: Record<string, unknown>): Promise<Record<string, any>> {
  const text = await s.evaluate<string>(async (p: any) =>
    (await fetch("/ctl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) })).text(), { args: [patch] });
  return JSON.parse(text);
}

/** Read the current scenario state without changing it (GET /ctl). */
export async function getScenario(s: Session): Promise<Record<string, any>> {
  return JSON.parse(await s.evaluate<string>(async () => (await fetch("/ctl")).text()));
}

/** Section 23: ask the server to deliver a *result* over a standing channel and wait for it to land.
 *  `via` picks the carrier — "ws" (the socket opened at load), "sse" (the notify EventSource) or "poll"
 *  (the long-poll, held up to `ctl.notifyPollHoldMs` = 25s, so give it room). All three deliver into
 *  `#notif-list`; the wait is a DOM predicate because the payload is rendered, and the carrier frames are
 *  in `ws_frames` / `sse_events` for the audit. Measured: ws 1ms, sse ~1ms, poll 3ms after the trigger. */
export async function waitForPush(s: Session, via: "ws" | "sse" | "poll", opts: { budgetMs?: number } = {}): Promise<string> {
  const before = await s.evaluate<number>(() => document.querySelectorAll("#notif-list li").length);
  await setScenario(s, { notify: true, push: via });
  const w = await s.watch({ fn: (n: number) => document.querySelectorAll("#notif-list li").length > n, fnArg: before },
    { budgetMs: opts.budgetMs ?? (via === "poll" ? 30000 : 8000) });
  if (!w.matched) throw new Error(`waitForPush(${via}): nothing arrived on the ${via} channel in ${w.elapsedMs}ms`);
  return await s.evaluate<string>(() => document.querySelector("#notif-list li:last-child")?.textContent ?? "");
}

// ---------------------------------------------------------------------------------------------
// Section 16 — canvas: the region with no DOM at all
// ---------------------------------------------------------------------------------------------

/** The 4x8 grid in section 16 is painted on a `<canvas>` — there is no DOM to select and clicking it
 *  leaves no readable trace (act:17: `settled:visual`, no attributed request, `data-last` null). Its
 *  contents are nonetheless wire-available: the page fetched `GET /api/grid` at load. Read it there. */
export async function readCanvasGrid(s: Session): Promise<{ rows: number; cols: number; cells: { r: number; c: number; label: string }[] }> {
  return extractFromWire(s.store, { urlLike: "/api/grid" });
}
