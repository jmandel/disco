// The log. One SQLite file per app (apps/<app>/store/store.sqlite) plus content-addressed blobs.
// Every row carries the `run` (one browser's life = one run) and a `t` in ms since that run started.
// There is no API layer in front of the tables: `disco sql` and `s.sql()` are the API.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { makeShaper, collectValues, readVocab } from "./shape.ts";
import { join } from "node:path";

export const STORE_VERSION = 5;
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS runs (
  run INTEGER PRIMARY KEY,           -- one browser's life; every other table carries it
  started_wall TEXT NOT NULL,        -- ISO
  ended_wall TEXT,
  anchor_epoch_ms REAL NOT NULL,     -- t = 0 for this run, in wall-clock ms
  url TEXT,                          -- the URL open navigated to (or the attached page's URL)
  mode TEXT NOT NULL                 -- launch | attach
);

CREATE TABLE IF NOT EXISTS actions (
  run INTEGER NOT NULL,
  id TEXT PRIMARY KEY,               -- act:<n>
  n INTEGER NOT NULL,
  t0 REAL NOT NULL,                  -- start of the observation window (before the code ran)
  t1 REAL,                           -- end of the observation window
  label TEXT NOT NULL,               -- what the agent called it
  code TEXT,                         -- the source of the function it ran
  ok INTEGER NOT NULL DEFAULT 1,     -- 0 = the code threw (see report.diagnosis)
  report TEXT                        -- JSON: the report exactly as returned
);

CREATE TABLE IF NOT EXISTS requests (
  run INTEGER NOT NULL,
  id TEXT PRIMARY KEY,               -- r<run>-<n>
  t_start REAL NOT NULL,
  t_response REAL,
  t_end REAL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT, path TEXT,
  resource_type TEXT,                -- document | xhr | fetch | script | image | eventsource | websocket | ...
  frame_url TEXT,                    -- URL of the frame that issued it
  req_headers TEXT,                  -- JSON
  req_body TEXT,                     -- capped text
  status INTEGER,
  mime TEXT,
  resp_headers TEXT,                 -- JSON (includes set-cookie)
  body_hash TEXT,                    -- -> bodies.hash; blobs/<hh>/<hash>
  body_size INTEGER,
  body_state TEXT,                   -- pending | ok | truncated | missing | streaming | error
  error TEXT,
  action_id TEXT                     -- the act whose window this started in, if any
);
CREATE INDEX IF NOT EXISTS requests_t ON requests(t_start);
CREATE INDEX IF NOT EXISTS requests_action ON requests(action_id);

CREATE TABLE IF NOT EXISTS bodies (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT,
  text TEXT,                         -- NULL for binary; the first 512 KB for text (the blob is always complete)
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS bodies_fts USING fts5(text, content='bodies', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS bodies_ai AFTER INSERT ON bodies BEGIN
  INSERT INTO bodies_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS ws_frames (
  run INTEGER NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  url TEXT NOT NULL,
  dir TEXT NOT NULL,                 -- in | out | open | close
  payload TEXT,                      -- capped at 16 KB
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS console (
  run INTEGER NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  level TEXT NOT NULL,               -- log | info | warning | error | exception
  text TEXT,
  url TEXT,
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS dialogs (
  run INTEGER NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  type TEXT NOT NULL,                -- alert | confirm | prompt | beforeunload
  message TEXT,
  handled TEXT,                      -- accept | dismiss
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS nav (
  run INTEGER NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  kind TEXT NOT NULL,                -- navigated | popup | closed | download
  url TEXT,
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS shots (
  run INTEGER NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  hash TEXT NOT NULL,                -- blob (jpeg, stored as blobs/<hh>/<hash>.jpg)
  reason TEXT,                       -- look | diagnosis
  url TEXT,                          -- the page's URL when it was taken
  action_id TEXT
);
`;

export const BODY_TEXT_CAP = 512 * 1024;   // bodies.text keeps the first 512 KB; the blob is always complete
export const REQ_BODY_CAP = 64 * 1024;
export const WS_PAYLOAD_CAP = 16 * 1024;

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
/** blobs/<hh>/<hash>, or <hash>.jpg for a screenshot. */
export function blobPath(dir: string, hash: string): string { const p = join(dir, "blobs", hash.slice(0, 2), hash); return !existsSync(p) && existsSync(p + ".jpg") ? p + ".jpg" : p; }

export function isTextual(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return m.startsWith("text/") || /json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|event-stream|ndjson/.test(m);
}

function norm(v: unknown): any {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/** A store from an older disco is moved aside rather than migrated. */
function retireOldStore(dir: string): void {
  const p = join(dir, "store.sqlite");
  if (!existsSync(p)) return;
  let old = false;
  try {
    const probe = new DatabaseSync(p);
    const v = (probe.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0;
    const has = probe.prepare("SELECT 1 x FROM sqlite_master WHERE name='actions'").get();
    probe.close();
    old = !!has && v < STORE_VERSION;
  } catch { old = false; }
  if (!old) return;
  for (const suf of ["", "-wal", "-shm"]) if (existsSync(p + suf)) renameSync(p + suf, join(dir, `store.old.sqlite${suf}`));
}

/** Read/write handle used by a live Session. */
export class Store {
  db: DatabaseSync;
  run = 0;
  anchor = 0;
  closed = false;
  dir: string;
  stmts = new Map<string, any>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "blobs"), { recursive: true });
    retireOldStore(dir);
    this.db = new DatabaseSync(join(dir, "store.sqlite"));
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${STORE_VERSION}`);
    const open = this.db.prepare("SELECT run, anchor_epoch_ms FROM runs ORDER BY run DESC LIMIT 1").get() as any;
    if (open) { this.run = open.run; this.anchor = open.anchor_epoch_ms; }
  }

  beginRun(meta: { url?: string | null; mode: "launch" | "attach" }): number {
    this.run = ((this.db.prepare("SELECT COALESCE(MAX(run),0) m FROM runs").get() as any)?.m ?? 0) + 1;
    this.anchor = Date.now();
    this.db.prepare("INSERT INTO runs(run, started_wall, anchor_epoch_ms, url, mode) VALUES (?,?,?,?,?)").run(this.run, new Date(this.anchor).toISOString(), this.anchor, meta.url ?? null, meta.mode);
    return this.run;
  }
  /** Continue the latest run (a second process reconnecting to the same browser). */
  resumeRun(): boolean {
    const r = this.db.prepare("SELECT run, anchor_epoch_ms, ended_wall FROM runs ORDER BY run DESC LIMIT 1").get() as any;
    if (!r || r.ended_wall) return false;
    this.run = r.run; this.anchor = r.anchor_epoch_ms; return true;
  }
  endRun(): void { this.db.prepare("UPDATE runs SET ended_wall=? WHERE run=? AND ended_wall IS NULL").run(new Date().toISOString(), this.run); }

  /** ms since this run started. */
  now(): number { return Date.now() - this.anchor; }

  stmt(sql: string) { let s = this.stmts.get(sql); if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); } return s; }
  insert(table: string, row: Record<string, unknown>): number {
    if (this.closed) return -1;
    const r = row.run === undefined && table !== "bodies" ? { ...row, run: this.run } : row;
    const keys = Object.keys(r);
    return Number(this.stmt(`INSERT INTO ${table}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => norm(r[k]))).lastInsertRowid);
  }
  update(table: string, patch: Record<string, unknown>, where: string, args: unknown[] = []): void {
    if (this.closed) return;
    const keys = Object.keys(patch); if (!keys.length) return;
    this.stmt(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE ${where}`).run(...keys.map((k) => norm(patch[k])), ...(args as any[]));
  }
  get<T = any>(sql: string, ...args: unknown[]): T | null { return (this.stmt(sql).get(...(args as any[])) as T) ?? null; }
  all<T = any>(sql: string, ...args: unknown[]): T[] { return this.stmt(sql).all(...(args as any[])) as T[]; }

  writeBlob(bytes: Uint8Array, ext = ""): string {
    const hash = sha256(bytes);
    const p = join(this.dir, "blobs", hash.slice(0, 2), hash + ext);
    if (!existsSync(p)) { mkdirSync(join(this.dir, "blobs", hash.slice(0, 2)), { recursive: true }); writeFileSync(p, bytes); }
    return hash;
  }
  /** The file a blob lives in (screenshots carry .jpg). */
  blobFile(hash: string): string { return blobPath(this.dir, hash); }
  storeBody(bytes: Uint8Array, mime: string | null): { hash: string; size: number; truncated: boolean } {
    const hash = this.writeBlob(bytes);
    const textual = isTextual(mime);
    const truncated = textual && bytes.byteLength > BODY_TEXT_CAP;
    if (!this.get("SELECT 1 FROM bodies WHERE hash=?", hash)) {
      const text = textual ? new TextDecoder().decode(truncated ? bytes.subarray(0, BODY_TEXT_CAP) : bytes) : null;
      this.insert("bodies", { hash, size: bytes.byteLength, mime, text, truncated });
    }
    return { hash, size: bytes.byteLength, truncated };
  }
  nextActionN(): number { return ((this.get<{ m: number }>("SELECT COALESCE(MAX(n),0) m FROM actions")?.m ?? 0) + 1); }
  close() { if (this.closed) return; this.closed = true; try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} this.db.close(); }
}

// ---------------------------------------------------------------------------------------------
// Reader — a store without a browser (the CLI's `sql`, and `s.sql/body` on a live session).
// ---------------------------------------------------------------------------------------------
export function openStore(dir: string, opts: { readonly?: boolean } = {}) {
  if (!existsSync(join(dir, "store.sqlite"))) throw new Error(`no store at ${dir}`);
  const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: opts.readonly ?? true });
  const columns = (table: string): string[] => { try { return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name); } catch { return []; } };
  const explain = (e: unknown, q: string): Error => {
    const msg = String((e as Error)?.message ?? e);
    const col = msg.match(/no such column: (\S+)/); const tab = msg.match(/no such table: (\S+)/);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'bodies_fts%' AND name NOT LIKE 'sqlite_%'").all() as any[]).map((t) => t.name);
    if (tab) return new Error(`${msg} — tables: ${tables.join(", ")}`);
    if (col) {
      const used = tables.filter((t) => new RegExp(`\\b${t}\\b`).test(q));
      return new Error(`${msg} — ${used.map((t) => `${t}(${columns(t).join(", ")})`).join("; ") || "requests keys on id and t_start/t_end; every other table on seq and t"}`);
    }
    return new Error(msg);
  };
  const sql = <T = any>(q: string, ...args: unknown[]): T[] => { try { return db.prepare(q).all(...(args as any[])) as T[]; } catch (e) { throw explain(e, q); } };
  const one = <T = any>(q: string, ...args: unknown[]): T | null => (sql<T>(q, ...args)[0] ?? null);
  const fullHash = (h: string): string => {
    if (h.length >= 64) return h;
    const row = one<{ hash: string }>("SELECT hash FROM bodies WHERE hash LIKE ? LIMIT 1", h + "%") ?? one<{ hash: string }>("SELECT hash FROM shots WHERE hash LIKE ? LIMIT 1", h + "%");
    if (row?.hash) return row.hash;
    const shard = join(dir, "blobs", h.slice(0, 2));
    if (existsSync(shard)) { const m = readdirSync(shard).find((f) => f.startsWith(h)); if (m) return m.replace(/\.jpg$/, ""); }
    throw new Error(`no blob matches prefix ${h}`);
  };
  const api = {
    db, dir, sql, one,
    /** Bytes of a body/screenshot by hash or prefix. */
    bytes(hash: string): Uint8Array { return new Uint8Array(readFileSync(blobPath(dir, fullHash(hash)))); },
    /** Text of a body by hash or prefix — the whole blob, even when bodies.text was capped. */
    body(hash: string): string {
      const full = fullHash(hash);
      const row = one<{ text: string | null; truncated: number }>("SELECT text, truncated FROM bodies WHERE hash=?", full);
      return row?.text != null && !row.truncated ? row.text : new TextDecoder().decode(api.bytes(full));
    },
    blobPath: (hash: string) => blobPath(dir, fullHash(hash)),
    close() { db.close(); },
  };
  return api;
}
export type StoreReader = ReturnType<typeof openStore>;

/** The pack rule, made mechanical: every `act:N` cited in apps/<app>/README.md gets its report copied to evidence/act-N.json
 *  (the plain report object) and its diagnosis shot to evidence/act-N.jpg, once; cites with no report behind them are returned. */
export type EvidenceSummary = { cited: number; copied: string[]; present: number; missing: string[]; unbacked: string[]; uncited: string[]; bare: string[]; absolutes: string[]; wide: string[]; leaks: string[]; storeBytes: number; storeDir: string; app: string };
/** The summary as `close` prints it (the CLI's and a script's alike). */
export function formatEvidence(ev: EvidenceSummary, app: string): string[] {
  const L: string[] = [];
  if (ev.cited) {
    L.push(`evidence: README cites ${ev.cited} act${ev.cited === 1 ? "" : "s"}; ${ev.copied.length ? `copied ${ev.copied.length} new (shaped: templates, skeletons, no values) to apps/${app}/evidence/` : "nothing new to copy"}${ev.present ? `, ${ev.present} already there` : ""}${ev.missing.length ? `; NO REPORT for ${ev.missing.join(", ")} — a cite with nothing behind it is a guess` : ""}`);
    for (const w of ev.wide) L.push(`  wide range: ${w}`);
    for (const u of ev.unbacked) L.push(`  claim check: ${u}`);
    if (ev.uncited.length) L.push(`  uncited numbers (a number without an act id is a guess): ${ev.uncited.length}${ev.uncited.length >= 8 ? "+" : ""} sentence${ev.uncited.length === 1 ? "" : "s"}, e.g. "${ev.uncited[0]}"`);
    if (ev.absolutes.length) L.push(`  absolutes with nothing behind them (only / never / always / identical / exactly — the claims most often wrong): ${ev.absolutes.length}${ev.absolutes.length >= 8 ? "+" : ""}, e.g. "${ev.absolutes[0]}"`);
    if (ev.bare.length) L.push(`  sentences with neither an act id nor an sdk function behind them: ${ev.bare.length}${ev.bare.length >= 8 ? "+" : ""}, e.g. "${ev.bare[0]}" — narrative is fine; a fact there is a guess`);
  }
  for (const l of ev.leaks) L.push(`  data in the pack: ${l} — the pack is documentation; values belong in the store`);
  if (ev.storeBytes) L.push(`store: ${(ev.storeBytes / 1048576).toFixed(1)} MB of bodies, shots and rows at ${ev.storeDir} — local only, never committed; rm -rf it when the pack is done`);
  return L;
}
function dirBytes(dir: string): number { let n = 0; try { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) n += dirBytes(p); else { try { n += statSync(p).size; } catch {} } } } catch {} return n; }

/** The pack rule, made mechanical: every `act:N` the README cites gets its report, its wire and the accessibility tree it left behind
 *  copied to evidence/ — SHAPED (urls as templates, bodies as skeletons, data blanked, no headers, no shots) — once; cites with no report,
 *  numbers the cited evidence does not contain, uncited numbers and absolutes are named; so is data that leaked into the pack's prose. */
export function syncEvidence(packDir: string, storeDir: string): EvidenceSummary {
  const readme = join(packDir, "README.md");
  const app = packDir.split("/").filter(Boolean).at(-1) ?? "";
  const none: EvidenceSummary = { cited: 0, copied: [], present: 0, missing: [], unbacked: [], uncited: [], bare: [], absolutes: [], wide: [], leaks: [], storeBytes: 0, storeDir, app };
  if (!existsSync(readme) || !existsSync(join(storeDir, "store.sqlite"))) return none;
  const text = readFileSync(readme, "utf8");
  // a range copies each act; a long one is a check run, not a citation — cap it and say so
  const wide: string[] = [];
  const ids = [...new Set([...text.matchAll(/\bact:(\d+)(?:\s*[-–]\s*(\d+))?\b/g)].flatMap((m) => { const a = Number(m[1]), b = m[2] ? Number(m[2]) : a; if (b > a + 9) { wide.push(`act:${a}-${b} (${b - a + 1} acts; only the first 10 copied — cite the acts that carry the facts)`); } return b >= a ? Array.from({ length: Math.min(b - a + 1, 10) }, (_, i) => `act:${a + i}`) : [`act:${a}`]; }))];
  const st = openStore(storeDir);
  const sdk = sdkFiles(packDir);
  const shaper = makeShaper({ ...collectValues(st), allow: readVocab(sdk.map((f) => f.text).join("\n")) });
  const copied: string[] = [], missing: string[] = []; let present = 0;
  const evPath = (n: string, suffix: string) => join(packDir, "evidence", `act-${n}${suffix}`);
  const evidenceText = (id: string): string | null => {
    const n = id.slice(4); const parts: string[] = [];
    for (const suf of [".json", "-wire.json", "-aria.txt"]) { const p = evPath(n, suf); if (existsSync(p)) parts.push(readFileSync(p, "utf8")); }
    if (!parts.length) { const row = st.one<{ report: string | null }>("SELECT report FROM actions WHERE id=?", id); if (row?.report) parts.push(JSON.stringify(shaper.report(JSON.parse(row.report)))); }
    return parts.length ? parts.join("\n") : null;
  };
  const writeEvidence = (id: string, rep: any) => {
    const n = id.slice(4);
    mkdirSync(join(packDir, "evidence"), { recursive: true });
    writeFileSync(evPath(n, ".json"), JSON.stringify(shaper.report(rep), null, 2) + "\n");
    try { if (rep?.aria) writeFileSync(evPath(n, "-aria.txt"), shaper.aria(st.body(rep.aria))); } catch {}
    try {
      const t0 = rep?.window?.t0 ?? 0, t1 = rep?.window?.t1 ?? 0;
      let budget = 512 * 1024;
      const requests = st.sql<any>("SELECT id, method, url, status, mime, resource_type, req_headers, req_body, resp_headers, body_hash, body_size, body_state, t_start, t_response, t_end FROM requests WHERE action_id=? AND resource_type NOT IN ('script','stylesheet','image','font','media','texttrack','manifest') ORDER BY t_start", id)
        .map((r) => { const size = r.body_size ?? 0; const take = r.body_hash && size <= 65536 && (budget -= size) >= 0; return shaper.wireRow({ ...r, ...(take ? { response_body: rawBody(st, r.body_hash) } : {}) }); });
      const nav = st.sql<any>("SELECT t, kind, url FROM nav WHERE run=(SELECT run FROM actions WHERE id=?) AND t BETWEEN ? AND ? ORDER BY seq", id, t0 - 1, t1 + 1).map((x) => ({ ...x, url: x.url ? shaper.url(x.url) : x.url }));
      if (requests.length || nav.length) writeFileSync(evPath(n, "-wire.json"), JSON.stringify({ action: id, requests, nav }, null, 2) + "\n");
    } catch {}
    try { for (const suf of [".jpg"]) if (existsSync(evPath(n, suf))) unlinkSync(evPath(n, suf)); } catch {}   // screenshots are pixels of data; an older copy goes
  };
  try {
    for (const id of ids) {
      const n = id.slice(4);
      const row = st.one<{ report: string | null }>("SELECT report FROM actions WHERE id=?", id);
      if (existsSync(evPath(n, ".json"))) {
        present++;
        // evidence copied by an earlier disco may hold values: re-shape it in place (shaping is idempotent)
        if (row?.report) writeEvidence(id, JSON.parse(row.report));
        else { try { const old = JSON.parse(readFileSync(evPath(n, ".json"), "utf8")); writeFileSync(evPath(n, ".json"), JSON.stringify(shaper.report(old), null, 2) + "\n"); } catch {} }
        continue;
      }
      if (!row?.report) { missing.push(id); continue; }
      writeEvidence(id, JSON.parse(row.report));
      copied.push(id);
    }
    // the claim behind the cite: a number quoted beside act:N should appear in that act's evidence; a number with no cite is a guess
    const unbacked: string[] = [], uncited: string[] = [], bare: string[] = [], absolutes: string[] = [];
    const exported = sdk.flatMap((f) => [...f.text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map((m) => m[1]));
    const exportsRe = sdk.length ? new RegExp(`\\b(${exported.filter(Boolean).join("|") || "__none__"})\\b`) : null;
    // inline code: a single token (`whoAmI()`, `anchors.chart`, `act:12`) stays visible to the lint; longer code (`max: 15000`) is not a claim
    const body = text.replace(/```[\s\S]*?```/g, "").replace(/`([^`\n]*)`/g, (_, c) => (/^\S+$/.test(c) && !/^\d+([.,]\d+)?$/.test(c) ? c : "`code`")).replace(/^\|.*$/gm, "").replace(/^#.*$/gm, "").replace(/^\s*\d+\.\s+/gm, "").replace(/[§#]\s?\d+/g, "");
    for (const raw of body.split(/(?<=[.!?])\s+(?=[A-Z`])|\n{2,}/)) {
      const sentence = raw.replace(/\s+/g, " ").trim(); if (!sentence) continue;
      const cites = [...new Set([...sentence.matchAll(/\bact:(\d+)\b/g)].map((m) => `act:${m[1]}`))];
      const backed = cites.length > 0 || (exportsRe && exportsRe.test(sentence));
      if (!backed && sentence.length > 40 && !/^(open question|todo|not (yet )?(verified|tested|driven))/i.test(sentence) && bare.length < 8) bare.push(sentence.slice(0, 90));
      // an absolute is the claim most often wrong in a pack ("only", "never", "identical"): it needs an act or a function behind it
      if (!backed && /\b(only|never|always|every|exactly|identical|none of|no other|nothing else|the only)\b/i.test(sentence) && absolutes.length < 8) absolutes.push(sentence.slice(0, 90));
      const numbers = [...sentence.replace(/\bact:\d+\b/g, "").matchAll(/(?<![\w.\/#-])\d{2,}(?:[.,]\d+)?(?![\w\/-])/g)].map((m) => m[0]);
      if (!numbers.length) continue;
      if (!cites.length) { if (uncited.length < 8) uncited.push(sentence.slice(0, 90)); continue; }
      const texts = cites.map(evidenceText).filter((t): t is string => !!t);
      if (!texts.length) continue;
      for (const num of numbers) { const plain = num.replace(/,/g, ""); if (!texts.some((t) => t.includes(plain) || t.includes(num))) { if (unbacked.length < 8) unbacked.push(`${cites.join("/")} is cited for ${num} but its evidence does not contain it`); } }
    }
    // data that leaked into the prose or the code: the same rules that shape the evidence
    const friction = join(packDir, "..", "..", `friction-${app}.md`);   // an exam's friction log sits two levels up; it must be as clean as the pack
    const files = [{ name: "README.md", text }, ...sdk, ...(existsSync(friction) ? [{ name: `friction-${app}.md`, text: readFileSync(friction, "utf8") }] : [])];
    const leaks = shaper.leaks(files);
    return { cited: ids.length, copied, present, missing, unbacked, uncited, bare, absolutes, wide, leaks, storeBytes: dirBytes(storeDir), storeDir, app };
  } finally { st.close(); }
}

/** The pack's sdk: `sdk.ts`, or every .ts file under `sdk/` (index.ts is the entry; the split is the product's own). Names are pack-relative. */
export function sdkFiles(packDir: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  if (existsSync(join(packDir, "sdk.ts"))) out.push({ name: "sdk.ts", text: readFileSync(join(packDir, "sdk.ts"), "utf8") });
  const walk = (rel: string) => { for (const e of readdirSync(join(packDir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walk(r); else if (/\.ts$/.test(e.name)) out.push({ name: r, text: readFileSync(join(packDir, r), "utf8") }); } };
  if (existsSync(join(packDir, "sdk"))) walk("sdk");
  return out;
}
function rawBody(st: StoreReader, hash: string): string | null { try { return st.body(hash); } catch { return null; } }
function safeJson(t: string | null): unknown { if (!t) return t; try { return JSON.parse(t); } catch { return t; } }

/** apps/ next to this checkout (not the process cwd), unless DISCO_APPS_DIR or an explicit root says otherwise. */
export function appsRoot(root?: string): string { return root ?? process.env.DISCO_APPS_DIR ?? join(import.meta.dirname, "..", "apps"); }
export function appDir(app: string, root?: string): string { return join(appsRoot(root), app); }
export function appStoreDir(app: string, root?: string): string { return join(appDir(app, root), "store"); }
