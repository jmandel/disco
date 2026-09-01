// The log. One SQLite file per app (apps/<app>/store/store.sqlite) plus content-addressed blobs.
// Every row is stamped with the `run` (one `open` = one run) and a `t` in milliseconds since that run
// started. There is no API layer in front of the tables: read SCHEMA (`disco schema`) and write SQL.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS runs (
  run INTEGER PRIMARY KEY,           -- one \`open\` = one run; every other table carries it
  started_wall TEXT NOT NULL,        -- ISO
  ended_wall TEXT,
  anchor_epoch_ms REAL NOT NULL,     -- t = 0 for this run, in wall-clock ms
  url TEXT,                          -- the URL \`open\` navigated to (or the attached page's URL)
  mode TEXT NOT NULL                 -- launch | attach
);

CREATE TABLE IF NOT EXISTS actions (
  run INTEGER NOT NULL,
  id TEXT PRIMARY KEY,               -- act:<n>
  n INTEGER NOT NULL,
  t0 REAL NOT NULL,                  -- dispatch
  t1 REAL,                           -- end of the observation window
  kind TEXT NOT NULL,                -- click | dblclick | fill | type | press | select | hover | scroll | navigate | until | noop
  target TEXT,
  ok INTEGER NOT NULL DEFAULT 1,     -- 0 = the action itself failed (see report.diagnosis)
  report TEXT                        -- JSON: the report exactly as returned
);

CREATE TABLE IF NOT EXISTS requests (
  run INTEGER NOT NULL,
  id TEXT PRIMARY KEY,
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
  body_state TEXT,                   -- pending | ok | truncated | missing | error
  error TEXT,
  action_id TEXT                     -- the act whose window [t0,t1] this started in, if any
);
CREATE INDEX IF NOT EXISTS requests_t ON requests(t_start);
CREATE INDEX IF NOT EXISTS requests_action ON requests(action_id);

CREATE TABLE IF NOT EXISTS bodies (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT,
  text TEXT,                         -- NULL for binary or over-cap bodies (the blob is always complete)
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
  payload TEXT,                      -- capped
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
  hash TEXT NOT NULL,                -- blob (jpeg)
  reason TEXT,                       -- shot | diagnosis | until
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  run INTEGER NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  text TEXT NOT NULL,
  action_id TEXT
);
`;

export const BODY_TEXT_CAP = 512 * 1024;   // bodies.text keeps the first 512 KB; the blob is always complete
export const REQ_BODY_CAP = 64 * 1024;
export const WS_PAYLOAD_CAP = 16 * 1024;

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function blobPath(dir: string, hash: string): string { return join(dir, "blobs", hash.slice(0, 2), hash); }

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

/** Read/write handle used by a live Session. */
export class Store {
  db: DatabaseSync;
  run = 0;
  private anchor = 0;
  private stmts = new Map<string, any>();
  closed = false;
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "blobs"), { recursive: true });
    this.db = new DatabaseSync(join(dir, "store.sqlite"));
    this.db.exec(SCHEMA);
    const open = this.db.prepare("SELECT run, anchor_epoch_ms FROM runs ORDER BY run DESC LIMIT 1").get() as any;
    if (open) { this.run = open.run; this.anchor = open.anchor_epoch_ms; }
  }

  beginRun(meta: { url?: string | null; mode: "launch" | "attach" }): number {
    this.run = ((this.db.prepare("SELECT COALESCE(MAX(run),0) m FROM runs").get() as any)?.m ?? 0) + 1;
    this.anchor = Date.now();
    this.db.prepare("INSERT INTO runs(run, started_wall, anchor_epoch_ms, url, mode) VALUES (?,?,?,?,?)").run(this.run, new Date(this.anchor).toISOString(), this.anchor, meta.url ?? null, meta.mode);
    return this.run;
  }
  /** Continue the latest run (a second process reconnecting to the same browser: the CLI, or a script). */
  resumeRun(): boolean {
    const r = this.db.prepare("SELECT run, anchor_epoch_ms, ended_wall FROM runs ORDER BY run DESC LIMIT 1").get() as any;
    if (!r || r.ended_wall) return false;
    this.run = r.run; this.anchor = r.anchor_epoch_ms; return true;
  }
  endRun(): void { this.db.prepare("UPDATE runs SET ended_wall=? WHERE run=? AND ended_wall IS NULL").run(new Date().toISOString(), this.run); }

  /** ms since this run started. */
  now(): number { return Date.now() - this.anchor; }
  toEpoch(t: number): number { return t + this.anchor; }

  private stmt(sql: string) { let s = this.stmts.get(sql); if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); } return s; }
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

  writeBlob(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    const p = blobPath(this.dir, hash);
    if (!existsSync(p)) { mkdirSync(join(this.dir, "blobs", hash.slice(0, 2)), { recursive: true }); writeFileSync(p, bytes); }
    return hash;
  }
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
// Readers — open a store without a browser. Everything desugars to one SQL statement.
// ---------------------------------------------------------------------------------------------
export interface RequestRow {
  run: number; id: string; t_start: number; t_response: number | null; t_end: number | null; method: string; url: string;
  host: string | null; path: string | null; resource_type: string | null; frame_url: string | null; req_headers: string | null;
  req_body: string | null; status: number | null; mime: string | null; resp_headers: string | null; body_hash: string | null;
  body_size: number | null; body_state: string | null; error: string | null; action_id: string | null;
}

export function openStore(dir: string, opts: { readonly?: boolean } = {}) {
  if (!existsSync(join(dir, "store.sqlite"))) throw new Error(`no store at ${dir}`);
  const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: opts.readonly ?? true });
  const sql = <T = any>(q: string, ...args: unknown[]): T[] => db.prepare(q).all(...(args as any[])) as T[];
  const one = <T = any>(q: string, ...args: unknown[]): T | null => (db.prepare(q).get(...(args as any[])) as T) ?? null;
  const fullHash = (h: string): string => {
    if (h.length >= 64) return h;
    const row = one<{ hash: string }>("SELECT hash FROM bodies WHERE hash LIKE ? LIMIT 1", h + "%") ?? one<{ hash: string }>("SELECT hash FROM shots WHERE hash LIKE ? LIMIT 1", h + "%");
    if (row?.hash) return row.hash;
    const shard = join(dir, "blobs", h.slice(0, 2));
    if (existsSync(shard)) { const m = readdirSync(shard).find((f) => f.startsWith(h)); if (m) return m; }
    throw new Error(`no blob matches prefix ${h}`);
  };
  const api = {
    db, dir, sql, one,
    /** Bytes of a body/screenshot by hash or prefix. */
    bytes(hash: string): Uint8Array { return new Uint8Array(readFileSync(blobPath(dir, fullHash(hash)))); },
    /** Text of a body by hash or prefix — bodies.text when present, else the decoded blob. */
    body(hash: string): string {
      const full = fullHash(hash);
      return one<{ text: string | null }>("SELECT text FROM bodies WHERE hash=?", full)?.text ?? new TextDecoder().decode(api.bytes(full));
    },
    json<T = any>(hash: string): T { return JSON.parse(api.body(hash)); },
    blobPath: (hash: string) => blobPath(dir, fullHash(hash)),
    /** requests({url, method, action, status, run, since}) → SELECT * FROM requests WHERE url LIKE '%…%' AND method=? AND action_id=? AND status=? AND run=? AND t_start>=? ORDER BY run, t_start */
    requests(f: { url?: string; method?: string; action?: string; status?: number; run?: number; since?: number } = {}): RequestRow[] {
      const w: string[] = []; const a: unknown[] = [];
      if (f.url) { w.push("url LIKE ?"); a.push(f.url.includes("%") ? f.url : `%${f.url}%`); }
      if (f.method) { w.push("method=?"); a.push(f.method.toUpperCase()); }
      if (f.action) { w.push("action_id=?"); a.push(f.action); }
      if (f.status !== undefined) { w.push("status=?"); a.push(f.status); }
      if (f.run !== undefined) { w.push("run=?"); a.push(f.run); }
      if (f.since !== undefined) { w.push("t_start>=?"); a.push(f.since); }
      return sql<RequestRow>(`SELECT * FROM requests ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY run, t_start`, ...a);
    },
    /** The latest JSON body whose URL contains `urlPart` — within an action and/or of one method: `latestJson("/encounter", { action, method: "POST" })` reads back a write even when the app fired newer GETs afterwards. */
    latestJson<T = any>(urlPart: string, scope?: string | { action?: string; method?: string }): T | null {
      const f = typeof scope === "string" ? { action: scope } : (scope ?? {});
      const r = api.requests({ url: urlPart, action: f.action, method: f.method }).filter((x) => x.body_hash).at(-1);
      return r ? api.json<T>(r.body_hash!) : null;
    },
    /** Every JSON body whose URL contains `urlPart` (optionally within an action), oldest first — when one screen calls one endpoint twice, pick by shape, not by recency. */
    jsonAll<T = any>(urlPart: string, scope?: string | { action?: string; method?: string }): T[] {
      const f = typeof scope === "string" ? { action: scope } : (scope ?? {});
      return api.requests({ url: urlPart, action: f.action, method: f.method }).filter((x) => x.body_hash).map((x) => { try { return api.json<T>(x.body_hash!); } catch { return null as any; } }).filter((x) => x !== null);
    },
    /** The stored action row with its report parsed. */
    action(id: string): any | null { const r = one<any>("SELECT * FROM actions WHERE id=?", id); if (r?.report) r.report = JSON.parse(r.report); return r; },
    runs() { return sql("SELECT run, started_wall, ended_wall, url, mode FROM runs ORDER BY run DESC"); },
    close() { db.close(); },
  };
  return api;
}
export type StoreReader = ReturnType<typeof openStore>;

/** apps/ next to this checkout (not the process cwd), unless DISCO_APPS_DIR or an explicit root says otherwise. */
export function appsRoot(root?: string): string { return root ?? process.env.DISCO_APPS_DIR ?? join(import.meta.dirname, "..", "apps"); }
export function appDir(app: string, root?: string): string { return join(appsRoot(root), app); }
export function appStoreDir(app: string, root?: string): string { return join(appDir(app, root), "store"); }
/** Open an app's store read-only, no browser needed: `openApp("gauntlet").requests({ url: "/api/record" })`. */
export function openApp(app: string, root?: string): StoreReader { return openStore(appStoreDir(app, root)); }
