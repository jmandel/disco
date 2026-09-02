/**
 * The gauntlet server — milestone 0 of disco (see BRIEF.md §3, REVIEW.md §C).
 *
 * A deliberately hostile, fully deterministic test target for a browser-
 * instrumentation daemon. Two Bun.serve instances:
 *   - the MAIN origin: SPA, JSON API, WebSocket, SSE, control plane (/ctl)
 *   - the X origin: a second port that only serves /xframe.html and its
 *     submit endpoint, so the SPA can embed a genuinely cross-origin iframe.
 *
 * Everything is deterministic: no Math.random, all ids/counters monotonic,
 * all latencies driven by explicit knobs. Every response carries
 * `Cache-Control: no-store`.
 *
 * Run directly:  bun run gauntlet/server.ts [--port N] [--verbose]
 */

import type { Server, ServerWebSocket } from "bun";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Control-plane state
// ---------------------------------------------------------------------------

/** Persisted knobs. All ambient traffic is OFF by default (deterministic timing). */
export type State = {
  /** latency for /api/slow when the page's Load Chart fires (ms) */
  slowMs: number;
  /** Load Chart: delay between the last response landing and the chart rendering (ms) — a >Q gap in
   *  the causal chain, so settlement closes before the screen shows the result (scenario 27) */
  renderDelayMs: number;
  /** show the "Allergy Review Required" dialog after opening a record */
  modal: boolean;
  /** delay between record render and dialog append (ms) */
  modalDelayMs: number;
  /** toast lifetime (ms) */
  toastMs: number;
  /** /api/save/status answers 500 {ok:false} */
  saveFails: boolean;
  /** heartbeat interval + long-poll loop + periodic WS push on/off */
  ambient: boolean;
  /** client heartbeat interval (ms) */
  heartbeatMs: number;
  /** how long the server holds /api/poll before answering (ms) */
  pollHoldMs: number;
  /** interval of server-initiated WS pushes while ambient is on (ms) */
  wsPushMs: number;
  /** idle time before the session-timeout dialog appears (ms); 0 = off */
  timeoutMs: number;
  /** replace #rerender node synchronously on mousemove/mouseover */
  rerenderOnHover: boolean;
  /** `/` 302s to /login.html without the auth cookie */
  requireAuth: boolean;
  /** how long /api/notify-poll is held waiting for a push trigger (ms) */
  notifyPollHoldMs: number;
  notify: boolean;
};

export const DEFAULTS: Readonly<State> = Object.freeze({
  slowMs: 400,
  renderDelayMs: 0,
  modal: false,
  modalDelayMs: 0,
  toastMs: 2000,
  saveFails: false,
  ambient: false,
  heartbeatMs: 5000,
  pollHoldMs: 3000,
  wsPushMs: 7000,
  timeoutMs: 0,
  rerenderOnHover: true,
  requireAuth: false,
  notifyPollHoldMs: 25000,
  notify: false,
});

/** Patch accepted by POST /ctl and ctl.set(): knobs plus the write-only triggers. */
export type CtlPatch = Partial<State> & { wsPush?: boolean; push?: "ws" | "sse" | "poll" };

/** What GET/POST /ctl and the `ctl` WS frame carry: knobs + the x-origin URL. */
export type CtlView = State & { xOrigin: string };

export type Gauntlet = {
  port: number;
  xPort: number;
  origin: string;
  xOrigin: string;
  ctl: { get(): State; set(patch: CtlPatch): void; reset(): void };
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Fixed data (deterministic)
// ---------------------------------------------------------------------------

export const ANIMALS = ["Aardvark", "Bison", "Cheetah", "Dingo", "Zebra", "Ferret", "Gecko"];

const PATIENT_NAMES = [
  "Ada Lovelace", "Alan Turing", "Grace Hopper", "Edsger Dijkstra", "Donald Knuth",
  "Barbara Liskov", "Dennis Ritchie", "Ken Thompson", "Linus Torvalds", "Margaret Hamilton",
  "Tim Berners-Lee", "Vint Cerf", "John McCarthy", "Marvin Minsky", "Claude Shannon",
  "Frances Allen", "Radia Perlman", "Leslie Lamport", "Niklaus Wirth", "Bjarne Stroustrup",
  "Guido van Rossum", "James Gosling", "Brendan Eich", "Anders Hejlsberg", "Rob Pike",
  "Brian Kernighan", "Alan Kay", "Douglas Engelbart", "Ivan Sutherland", "Seymour Cray",
  "Gordon Moore", "Robert Noyce", "Jean Bartik", "Betty Holberton", "Kathleen Booth",
  "Mary Allen Wilkes", "Adele Goldberg", "Sophie Wilson", "Lynn Conway", "Carver Mead",
  "Hedy Lamarr", "Katherine Johnson", "Dorothy Vaughan", "Mary Jackson", "Annie Easley",
  "Evelyn Boyd Granville", "Gladys West", "Shafi Goldwasser", "Silvio Micali", "Whitfield Diffie",
];

const MEDS = [
  "Acetaminophen", "Amoxicillin", "Atorvastatin", "Azithromycin", "Amlodipine",
  "Albuterol", "Aspirin", "Lisinopril", "Levothyroxine", "Losartan",
  "Metformin", "Metoprolol", "Montelukast", "Omeprazole", "Ondansetron",
  "Prednisone", "Pantoprazole", "Sertraline", "Simvastatin", "Tramadol",
  "Trazodone", "Warfarin", "Gabapentin", "Hydrochlorothiazide", "Ibuprofen",
  "Insulin glargine", "Fluoxetine", "Furosemide", "Clopidogrel", "Cetirizine",
];

const RECORDS: Record<string, unknown>[] = [1, 2, 3, 4, 5].map((n) => ({
  id: n,
  name: PATIENT_NAMES[n - 1],
  dob: `19${60 + n * 3}-0${n}-1${n}`,
  mrn: `MRN-000${n}`,
  allergies: n % 2 ? ["Penicillin"] : ["Penicillin", "Latex"],
}));

/** 10,000 rows; row 9741 is exactly "Zebra-Row-9741". Serialized once. */
const ROWS_JSON = JSON.stringify(
  Array.from({ length: 10000 }, (_, i) => ({ id: i, name: `${ANIMALS[i % 7]}-Row-${i}`, group: `G${i % 10}` })),
);

const GRID = {
  rows: 4,
  cols: 8,
  cells: Array.from({ length: 32 }, (_, i) => ({ r: Math.floor(i / 8), c: i % 8, label: `${Math.floor(i / 8)},${i % 8}` })),
};

const APP_DIR = join(import.meta.dir, "app");

// ---------------------------------------------------------------------------
// Response helpers — every response gets Cache-Control: no-store
// ---------------------------------------------------------------------------

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE, ...extra },
  });
}

function text(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType, ...NO_STORE } });
}

/** Manual redirect (Response.redirect() has immutable headers). */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...NO_STORE } });
}

async function staticFile(name: string): Promise<Response> {
  const f = Bun.file(join(APP_DIR, name));
  if (!(await f.exists())) return text("not found", "text/plain", 404);
  const ct = name.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
  return text(await f.text(), ct);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Cancellable sleep: resolvers are tracked so stop() can release held requests. */
class Holds {
  private pending = new Set<() => void>();
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.pending.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      this.pending.add(done);
    });
  }
  releaseAll(): void {
    for (const r of [...this.pending]) r();
  }
}

// ---------------------------------------------------------------------------
// startGauntlet
// ---------------------------------------------------------------------------

type WsData = { id: number };

/** #29 the people table's data. */
const PEOPLE = [
  { name: "Ada Lovelace", role: "Analyst", dept: "Engines", since: "1843" },
  { name: "Alan Turing", role: "Logician", dept: "Hut 8", since: "1939" },
  { name: "Grace Hopper", role: "Rear Admiral", dept: "Compilers", since: "1952" },
  { name: "Katherine Johnson", role: "Computer", dept: "Flight", since: "1953" },
  { name: "Edsger Dijkstra", role: "Professor", dept: "Algorithms", since: "1962" },
  { name: "Barbara Liskov", role: "Professor", dept: "Types", since: "1972" },
];
/** #34 a FHIR-style Patient in XML. */
const PATIENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Patient xmlns="http://hl7.org/fhir">
  <id value="0f3c2a1b-1234-4c56-8d9e-a0b1c2d3e4f5"/>
  <identifier><system value="http://gauntlet.local/mrn"/><value value="MRN-0042"/></identifier>
  <name><text value="Ada Lovelace"/><family value="Lovelace"/><given value="Ada"/></name>
  <gender value="female"/><birthDate value="1815-12-10"/>
  <address><line value="12 St James's Square"/><city value="London"/></address>
</Patient>`;
/** /big.html — 10,000 real rows in the DOM (not virtualised): the report-overhead ceiling target. */
const BIG_HTML = `<!doctype html><meta charset="utf-8"><title>big</title><link rel="stylesheet" href="/style.css">
<h1>10,000 rows</h1><button id="big-btn">Count</button> <span id="big-out">-</span>
<table id="big"><tbody>${Array.from({ length: 10000 }, (_, i) => `<tr><td>${i + 1}</td><td>row ${i + 1}</td><td>${["alpha", "bravo", "charlie", "delta"][i % 4]}</td></tr>`).join("")}</tbody></table>
<script>document.getElementById("big-btn").addEventListener("click", () => { document.getElementById("big-out").textContent = String(document.querySelectorAll("#big tr").length); });</script>`;

export async function startGauntlet(opts: { port?: number; verbose?: boolean } = {}): Promise<Gauntlet> {
  const verbose = !!opts.verbose;
  const wantPort = opts.port ?? 4800;
  const log = (...a: unknown[]) => { if (verbose) console.log("[gauntlet]", ...a); };

  // --- state -----------------------------------------------------------------
  let state: State = { ...DEFAULTS };
  let xOrigin = ""; // filled once the x server is listening
  const view = (): CtlView => ({ ...state, xOrigin });

  // monotonic counters
  const counters = { poll: 0, heartbeat: 0, save: 0, ws: 0, echo: 0, push: 0, sse: 0, notif: 0 };
  const holds = new Holds();

  // --- client bundle (built once, in memory) ---------------------------------
  const build = await Bun.build({ entrypoints: [join(APP_DIR, "main.ts")], target: "browser" });
  if (!build.success) throw new Error("gauntlet client build failed:\n" + build.logs.map(String).join("\n"));
  const appJs = await build.outputs[0]!.text();

  // --- websocket plumbing ----------------------------------------------------
  let mainServer: Server<WsData>;
  const TOPIC = "gauntlet";
  const broadcast = (frame: unknown) => { mainServer.publish(TOPIC, JSON.stringify(frame)); };
  const pushOnce = () => { counters.push++; broadcast({ type: "push", n: counters.push, at: Date.now() }); };

  // --- #23 push-channel notifications: one monotonic n, channel-exclusive delivery
  type Notif = { n: number; via: "ws" | "sse" | "poll"; text: string };
  const sseEnc = new TextEncoder();
  const notifySseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const notifyPollWaiters = new Set<(v: Notif | null) => void>();
  const pushNotif = (via: "ws" | "sse" | "poll") => {
    counters.notif++;
    const notif: Notif = { n: counters.notif, via, text: `Result ${counters.notif} via ${via}` };
    if (via === "ws") {
      broadcast({ type: "notify", ...notif });
    } else if (via === "sse") {
      const chunk = sseEnc.encode(`data: ${JSON.stringify(notif)}

`);
      for (const c of [...notifySseClients]) { try { c.enqueue(chunk); } catch { notifySseClients.delete(c); } }
    } else {
      for (const w of [...notifyPollWaiters]) w(notif); // each waiter removes itself
    }
  };

  // periodic WS push while ambient is on; re-armed whenever ctl changes
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const armPush = () => {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (!state.ambient) return;
    pushTimer = setTimeout(() => { pushOnce(); armPush(); }, state.wsPushMs);
  };

  // --- ctl --------------------------------------------------------------------
  const applyPatch = (patch: CtlPatch) => {
    const next: State = { ...state };
    let touched = false; // at least one known knob was present (even if unchanged)
    for (const key of Object.keys(DEFAULTS) as (keyof State)[]) {
      if (!(key in patch)) continue;
      const v = patch[key];
      const want = typeof DEFAULTS[key];
      if (typeof v !== want) continue; // ignore wrong-typed values
      if (want === "number" && !Number.isFinite(v)) continue;
      (next as Record<string, unknown>)[key] = v;
      touched = true;
    }
    if (touched) {
      state = next;
      armPush();
      broadcast({ type: "ctl", state: view() }); // live pages apply without reload
    }
    if (patch.wsPush === true) pushOnce(); // write-only trigger, never persisted, no ctl frame
    const via = patch.push;
    if (via === "ws" || via === "sse" || via === "poll") pushNotif(via); // ditto
  };
  const ctl = {
    get: (): State => ({ ...state }),
    set: (patch: CtlPatch) => applyPatch(patch),
    reset: () => applyPatch({ ...DEFAULTS }),
  };

  // --- main fetch handler ----------------------------------------------------
  async function route(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = req.method;

    // WebSocket
    if (path === "/ws") {
      counters.ws++;
      if (server.upgrade(req, { data: { id: counters.ws } })) return undefined;
      return text("websocket upgrade failed", "text/plain", 400);
    }

    // control plane
    if (path === "/ctl" && m === "GET") return json(view());
    if (path === "/ctl" && m === "POST") {
      const body = await readJson(req);
      if (!body) return json({ error: "invalid JSON body" }, 400);
      applyPatch(body as CtlPatch);
      return json(view());
    }
    if (path === "/ctl/reset" && m === "POST") { ctl.reset(); return json(view()); }
    if (path === "/origins") return json({ origin: `http://localhost:${server.port}`, xOrigin });

    // pages
    const authed = readCookie(req, "gauntlet_auth");
    if (path === "/" || path === "/index.html") {
      if (state.requireAuth && !authed) return redirect("/login.html?next=/");
      return staticFile("index.html");
    }
    if (path === "/big.html") return text(BIG_HTML, "text/html; charset=utf-8");
    if (path === "/app.js") return text(appJs, "text/javascript; charset=utf-8");
    if (path === "/favicon.ico") return new Response(null, { status: 204, headers: NO_STORE }); // keep consoles clean
    if (path === "/secure.html") {
      if (!authed) return redirect("/login.html?next=/secure.html");
      const tpl = await Bun.file(join(APP_DIR, "secure.html")).text();
      return text(tpl.replaceAll("{{USER}}", escapeHtml(authed)), "text/html; charset=utf-8");
    }
    if (/^\/(iframe|iframe2|child|away|login)\.html$/.test(path) || path === "/style.css") return staticFile(path.slice(1));

    // API
    if (path.startsWith("/api/")) return api(req, url, path, m);
    return text("not found", "text/plain", 404);
  }

  async function api(req: Request, url: URL, path: string, m: string): Promise<Response> {
    const q = url.searchParams;

    if (path === "/api/slow") {
      const ms = Math.max(0, Number(q.get("ms") ?? state.slowMs) || 0);
      await holds.sleep(ms);
      return json({ ms, at: Date.now() });
    }
    if (path === "/api/chart/a") return json({ series: "a", points: [1, 3, 2, 5, 4] });
    if (path === "/api/chart/b") return json({ series: "b", points: [2, 2, 3, 1, 6] });

    const rec = path.match(/^\/api\/record\/(\d+)$/);
    if (rec) {
      const r = RECORDS[Number(rec[1]) - 1];
      return r ? json(r) : json({ error: "no such record" }, 404);
    }

    if (path === "/api/save" && m === "POST") {
      const body = await readJson(req);
      counters.save++;
      return json({ id: counters.save, pending: true, received: body }, 202);
    }
    if (path === "/api/save/status") {
      const id = Number(q.get("id") ?? 0);
      return state.saveFails ? json({ id, ok: false, error: "write failed" }, 500) : json({ id, ok: true });
    }

    if (path === "/api/heartbeat") { counters.heartbeat++; return json({ ok: true, n: counters.heartbeat }); }
    if (path === "/api/poll") {
      await holds.sleep(state.pollHoldMs); // read at request time
      counters.poll++;
      return json({ n: counters.poll, heldMs: state.pollHoldMs });
    }

    if (path === "/api/search") {
      const needle = (q.get("q") ?? "").toLowerCase();
      const hits = needle ? PATIENT_NAMES.filter((n) => n.toLowerCase().includes(needle)) : [];
      return json({ q: q.get("q") ?? "", hits });
    }
    if (path === "/api/meds") {
      const needle = (q.get("q") ?? "").toLowerCase();
      const hits = needle ? MEDS.filter((n) => n.toLowerCase().includes(needle)) : MEDS;
      return json({ q: q.get("q") ?? "", hits });
    }
    if (path === "/api/patient.xml") return text(PATIENT_XML, "application/fhir+xml; charset=utf-8");
    if (path === "/api/form" && m === "POST") { const form = new URLSearchParams(await req.text()); return json({ ok: true, received: form.get("fullName") ?? "", consent: form.get("consent") }); }
    if (path === "/api/fragment") return text(`<table id="fragment-people"><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody>${PEOPLE.map((p, i) => `<tr><td><a href="/people/${i + 1}">${p.name}</a></td><td>${p.role}</td></tr>`).join("")}</tbody></table>`, "text/html; charset=utf-8");
    if (path === "/api/people") { await holds.sleep(Math.max(0, Number(q.get("hold") ?? 0) || 0)); return json({ people: PEOPLE }); }
    const tab = path.match(/^\/api\/tab\/([ab])$/);
    if (tab) return json({ tab: tab[1], items: tab[1] === "a" ? ["alpha", "apple", "anchor"] : ["bravo", "banana", "beacon"] });
    if (path === "/api/slow-submit" && m === "POST") { await readJson(req); return json({ ok: true, at: Date.now() }); }
    if (path === "/api/rows") return text(ROWS_JSON, "application/json");

    if (path === "/api/iframe-submit" && m === "POST") {
      const body = await readJson(req);
      return json({ ok: true, name: String(body?.name ?? "") });
    }

    const del = path.match(/^\/api\/item\/(\d+)$/);
    if (del && m === "DELETE") return json({ deleted: Number(del[1]) });

    if (path === "/api/child-ping") return json({ pong: true });
    if (path === "/api/grid") return json(GRID);

    if (path === "/api/notify-sse") {
      // persistent stream, held open until the client goes away or stop(); one event per push trigger
      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          ctrl = controller;
          notifySseClients.add(controller);
          controller.enqueue(sseEnc.encode(": connected\n\n")); // comment line so EventSource fires `open`
        },
        cancel() { if (ctrl) notifySseClients.delete(ctrl); },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream", Connection: "keep-alive", ...NO_STORE },
      });
    }
    if (path === "/api/notify-poll") {
      // held until a push:"poll" trigger, or notifyPollHoldMs (read at request time) -> {n:null}
      const notif = await new Promise<Notif | null>((resolve) => {
        const done = (v: Notif | null) => { clearTimeout(t); notifyPollWaiters.delete(done); resolve(v); };
        const t = setTimeout(() => done(null), state.notifyPollHoldMs);
        notifyPollWaiters.add(done);
      });
      return json(notif ?? { n: null });
    }
    if (path === "/api/drag-report" && m === "POST") {
      const body = await readJson(req);
      return json({ ...(body ?? {}), ok: true });
    }

    if (path === "/api/fake-stream") {
      // one COMPLETE ordinary payload behind a stream mime: the response finishes normally (scenario 28)
      return new Response("<envelope><encounters><e id=\"1\">complete payload behind a stream mime<\/e><\/encounters><\/envelope>", { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
    }
    if (path === "/api/sse") {
      counters.sse++;
      const stream = counters.sse;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          try {
            for (let i = 1; i <= 5; i++) {
              await holds.sleep(500);
              controller.enqueue(enc.encode(`id: ${i}\ndata: ${JSON.stringify({ stream, i, msg: `event ${i} of 5` })}\n\n`));
            }
          } catch { /* client went away */ }
          try { controller.close(); } catch { /* already closed */ }
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream", Connection: "keep-alive", ...NO_STORE },
      });
    }

    if (path === "/api/graphql" && m === "POST") {
      const body = await readJson(req);
      const query = String(body?.query ?? "");
      const sawMutation = /^\s*mutation\b/.test(query);
      const data = sawMutation ? { rename: { name: "Renamed" } } : { patient: { name: PATIENT_NAMES[0] } };
      return json({ data, sawMutation, operation: sawMutation ? "mutation" : "query" });
    }

    if (path === "/api/login" && m === "POST") {
      const body = await readJson(req);
      const user = String(body?.user ?? ""), pass = String(body?.pass ?? "");
      if (!user || !pass) return json({ ok: false, error: "user and pass required" }, 401);
      return json({ ok: true, user }, 200, {
        "Set-Cookie": `gauntlet_auth=${encodeURIComponent(user)}; Path=/; HttpOnly`,
      });
    }

    return json({ error: "not found", path, method: m }, 404);
  }

  // --- main server -------------------------------------------------------------
  mainServer = Bun.serve<WsData>({
    idleTimeout: 120, // long-polls (/api/poll, /api/notify-poll) outlive the 10s default
    port: wantPort,
    async fetch(req, server) {
      const t0 = performance.now();
      let res: Response | undefined;
      try {
        res = await route(req, server);
      } catch (err) {
        res = json({ error: String(err) }, 500);
      }
      if (res) log(req.method, new URL(req.url).pathname + new URL(req.url).search, "->", res.status, `${(performance.now() - t0).toFixed(0)}ms`);
      return res ?? new Response(null, { status: 101 }); // 101 path never sent: upgrade already took the socket
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        ws.subscribe(TOPIC);
        log("ws open", ws.data.id);
        ws.send(JSON.stringify({ type: "hello", id: ws.data.id, state: view() }));
      },
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        if (String(raw) === "ping") { ws.send("pong"); return; }   // keepalive: byte-identical both ways, no counter
        counters.echo++;
        let parsed: unknown = null;
        try { parsed = JSON.parse(String(raw)); } catch { /* non-JSON */ }
        // flatten the client's fields, then force type:"echo" (client's own type is dropped)
        const frame = parsed && typeof parsed === "object"
          ? { ...(parsed as Record<string, unknown>), type: "echo", seq: counters.echo }
          : { type: "echo", raw: String(raw), seq: counters.echo };
        ws.send(JSON.stringify(frame));
      },
      close(ws: ServerWebSocket<WsData>) { log("ws close", ws.data.id); },
    },
  });

  // --- cross-origin server ------------------------------------------------------
  const xServer = Bun.serve({
    idleTimeout: 60,
    port: wantPort === 0 ? 0 : mainServer.port! + 1,
    async fetch(req) {
      const url = new URL(req.url);
      log("x", req.method, url.pathname);
      if (url.pathname === "/xframe.html") return staticFile("xframe.html");
      if (url.pathname === "/api/xframe-submit" && req.method === "POST") {
        const body = await readJson(req);
        return json({ ok: true, name: String(body?.name ?? ""), origin: "x" });
      }
      return text("not found", "text/plain", 404);
    },
  });

  const port = mainServer.port!;
  const xPort = xServer.port!;
  const origin = `http://localhost:${port}`;
  xOrigin = `http://localhost:${xPort}`;

  return {
    port, xPort, origin, xOrigin, ctl,
    async stop() {
      if (pushTimer) clearTimeout(pushTimer);
      holds.releaseAll();
      for (const w of [...notifyPollWaiters]) w(null);
      for (const c of [...notifySseClients]) { try { c.close(); } catch { /* already closed */ } }
      notifySseClients.clear();
      await Promise.all([mainServer.stop(true), xServer.stop(true)]);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry: bun run gauntlet/server.ts [--port N] [--verbose]
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf("--port");
  const port = pi >= 0 ? Number(argv[pi + 1]) : 4800;
  const g = await startGauntlet({ port, verbose: argv.includes("--verbose") });
  console.log(`gauntlet main origin: ${g.origin}`);
  console.log(`gauntlet x-origin:    ${g.xOrigin}`);
  console.log(`ctl: GET/POST ${g.origin}/ctl   reset: POST ${g.origin}/ctl/reset`);
}
