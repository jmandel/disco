// The session store (GUIDANCE §6, BRIEF §1.5/1.6): SQLite (WAL) + content-addressed blobs.
// Writer: the daemon only (class Store). Readers: anyone, directly (openStore / bun:sqlite / sqlite3).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "../defaults.ts";

const SCHEMA_PATH = join(import.meta.dir, "..", "schema.sql");

export interface SessionManifest {
  name: string; dir: string; anchorEpochMs: number; startedWall: string; endedWall?: string;
  mode: "attach" | "launch"; scope?: string; browser?: string; endpoint?: { port?: number; wsUrl?: string };
  dialogPolicy: "accept" | "dismiss"; contract?: unknown; pid?: number; launched?: { pid: number; userDataDir: string; port: number; headless: boolean };
}

export function blobPath(dir: string, hash: string): string { return join(dir, "blobs", hash.slice(0, 2), hash); }
export function sha256(data: Uint8Array | string): string { return new Bun.CryptoHasher("sha256").update(data).digest("hex"); }

/** Daemon-side writer. One instance per session. */
export class Store {
  db: Database;
  private stmts = new Map<string, ReturnType<Database["prepare"]>>();
  private anchorEpochMs: number;
  private anchorPerf: number;

  constructor(public dir: string, manifest: SessionManifest) {
    mkdirSync(join(dir, "blobs"), { recursive: true });
    this.db = new Database(join(dir, "store.sqlite"), { create: true });
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
    this.anchorEpochMs = manifest.anchorEpochMs;
    this.anchorPerf = performance.now() - (Date.now() - manifest.anchorEpochMs);
    this.db.run(
      `INSERT OR REPLACE INTO session(id, name, anchor_epoch_ms, started_wall, mode, scope, browser, contract, dialog_policy) VALUES (1,?,?,?,?,?,?,?,?)`,
      [manifest.name, manifest.anchorEpochMs, manifest.startedWall, manifest.mode, manifest.scope ?? null, manifest.browser ?? null, manifest.contract ? JSON.stringify(manifest.contract) : null, manifest.dialogPolicy],
    );
  }

  /** Session clock: ms since anchor, monotonic (performance.now based). */
  now(): number { return performance.now() - this.anchorPerf; }
  /** Wall-clock epoch ms → session clock. */
  fromEpochMs(epochMs: number): number { return epochMs - this.anchorEpochMs; }
  toEpochMs(t: number): number { return t + this.anchorEpochMs; }

  private stmt(sql: string) { let s = this.stmts.get(sql); if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); } return s; }

  /** Insert a row from an object; returns lastInsertRowid. */
  insert(table: string, row: Record<string, unknown>): number {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
    const r = this.stmt(sql).run(...keys.map((k) => norm(row[k])));
    return Number(r.lastInsertRowid);
  }
  upsert(table: string, row: Record<string, unknown>): void {
    const keys = Object.keys(row);
    const sql = `INSERT OR REPLACE INTO ${table}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
    this.stmt(sql).run(...keys.map((k) => norm(row[k])));
  }
  update(table: string, patch: Record<string, unknown>, where: string, whereArgs: unknown[] = []): number {
    const keys = Object.keys(patch);
    if (!keys.length) return 0;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE ${where}`;
    return this.stmt(sql).run(...keys.map((k) => norm(patch[k])), ...(whereArgs as any[])).changes;
  }
  get<T = any>(sql: string, ...args: unknown[]): T | null { return (this.stmt(sql).get(...(args as any[])) as T) ?? null; }
  all<T = any>(sql: string, ...args: unknown[]): T[] { return this.stmt(sql).all(...(args as any[])) as T[]; }
  run(sql: string, ...args: unknown[]) { return this.stmt(sql).run(...(args as any[])); }

  /** Append to the unified event stream; returns seq. */
  event(kind: string, e: { t?: number; target_id?: string | null; frame_id?: string | null; action_id?: string | null; ref?: string | number | null; summary?: unknown }): number {
    return this.insert("events", {
      t: e.t ?? this.now(), target_id: e.target_id ?? null, frame_id: e.frame_id ?? null, kind,
      action_id: e.action_id ?? null, ref: e.ref == null ? null : String(e.ref), summary: e.summary === undefined ? null : JSON.stringify(e.summary),
    });
  }

  /** Content-addressed blob write; returns the hash. Idempotent. */
  writeBlob(data: Uint8Array | string): string {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const hash = sha256(bytes);
    const p = blobPath(this.dir, hash);
    if (!existsSync(p)) { mkdirSync(join(this.dir, "blobs", hash.slice(0, 2)), { recursive: true }); writeFileSync(p, bytes); }
    return hash;
  }
  hasBlob(hash: string): boolean { return existsSync(blobPath(this.dir, hash)); }

  /** Store a body: blob always; `bodies` row with text when textual and under cap. */
  storeBody(bytes: Uint8Array, mime: string | null): { hash: string; size: number; truncated: boolean } {
    const hash = this.writeBlob(bytes);
    const textual = isTextual(mime);
    const truncated = textual && bytes.byteLength > defaults.bodyTextCap;
    const exists = this.get("SELECT 1 FROM bodies WHERE hash=?", hash);
    if (!exists) {
      const text = textual ? new TextDecoder().decode(truncated ? bytes.subarray(0, defaults.bodyTextCap) : bytes) : null;
      this.insert("bodies", { hash, size: bytes.byteLength, mime, text, truncated: truncated ? 1 : 0 });
    }
    return { hash, size: bytes.byteLength, truncated };
  }

  nextActionN(): number { return (this.get<{ m: number }>("SELECT COALESCE(MAX(n),0) m FROM actions")?.m ?? 0) + 1; }
  lastSeq(): number { return this.get<{ s: number }>("SELECT COALESCE(MAX(seq),0) s FROM events")?.s ?? 0; }
  close() { try { this.db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} this.db.close(); }
}

function norm(v: unknown): any {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}
export function isTextual(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return m.startsWith("text/") || m.includes("json") || m.includes("xml") || m.includes("javascript") || m.includes("ecmascript") || m.includes("x-www-form-urlencoded") || m.includes("graphql") || m.includes("event-stream");
}

// ---------------------------------------------------------------------------------------------
// Readers (client-side). Open the store directly — no daemon needed. Each helper documents its
// desugaring so agents graduate to raw SQL/TS when the canned form falls short (GUIDANCE §6.2).
// ---------------------------------------------------------------------------------------------
export interface RequestRow { id: string; t_start: number; t_end: number | null; method: string; url: string; host: string; path: string; family: string; status: number | null; mime: string | null; resp_size: number | null; body_hash: string | null; body_state: string | null; action_id: string | null; attribution: string | null; write_kind: string | null; resource_type: string | null; target_id: string; frame_id: string | null }

export function readManifest(dir: string): SessionManifest { return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); }

export function openStore(dir: string) {
  const db = new Database(join(dir, "store.sqlite"), { readonly: true });
  const manifest = readManifest(dir);
  const q = <T = any>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...(args as any[])) as T[];
  const one = <T = any>(sql: string, ...args: unknown[]): T | null => (db.prepare(sql).get(...(args as any[])) as T) ?? null;
  /** Report handles are 16-char prefixes; resolve to the full sha256 (review F7). */
  const fullHash = (h: string): string => {
    if (h.length >= 64) return h;
    const row = one<{ hash: string }>("SELECT hash FROM bodies WHERE hash LIKE ? LIMIT 1", h + "%")
      ?? one<{ hash: string }>("SELECT hash FROM shots WHERE hash LIKE ? LIMIT 1", h + "%")
      ?? one<{ hash: string }>("SELECT pre_aria hash FROM actions WHERE pre_aria LIKE ? UNION SELECT post_aria FROM actions WHERE post_aria LIKE ? LIMIT 1", h + "%", h + "%")
      ?? one<{ hash: string }>("SELECT shot hash FROM sentinels WHERE shot LIKE ? LIMIT 1", h + "%");
    if (row?.hash) return row.hash;
    const shard = join(dir, "blobs", h.slice(0, 2));
    if (existsSync(shard)) { const m = readdirSync(shard).find((f) => f.startsWith(h)); if (m) return m; }
    throw new Error(`no blob matches prefix ${h}`);
  };
  const api = {
    db, dir, manifest,
    /** Raw SQL, all rows. */
    sql: q,
    one,
    fullHash,
    /** Body bytes by hash or 16-char prefix (blob). Desugars to: readFileSync(blobPath(dir, hash)). */
    bodyBytes(hash: string): Uint8Array { return new Uint8Array(readFileSync(blobPath(dir, fullHash(hash)))); },
    /** Body text by hash/prefix — from `bodies.text` when present (fast), else decoded from the blob. */
    body(hash: string): string {
      const full = fullHash(hash);
      const r = one<{ text: string | null }>("SELECT text FROM bodies WHERE hash=?", full);
      return r?.text ?? new TextDecoder().decode(api.bodyBytes(full));
    },
    /** Parsed JSON body. */
    json<T = any>(hash: string): T { return JSON.parse(api.body(hash)); },
    blobPath: (hash: string) => blobPath(dir, fullHash(hash)),
    /** requests({urlLike, method, actionId, status, since, until}) →
     *  SELECT * FROM requests WHERE url LIKE ? AND method=? AND action_id=? AND status=? AND t_start BETWEEN ? AND ? ORDER BY t_start */
    requests(f: { urlLike?: string; method?: string; actionId?: string; status?: number; since?: number; until?: number; family?: string } = {}): RequestRow[] {
      const w: string[] = []; const a: unknown[] = [];
      if (f.urlLike) { w.push("url LIKE ?"); a.push(f.urlLike); }
      if (f.method) { w.push("method=?"); a.push(f.method.toUpperCase()); }
      if (f.actionId) { w.push("action_id=?"); a.push(f.actionId); }
      if (f.status !== undefined) { w.push("status=?"); a.push(f.status); }
      if (f.family) { w.push("family=?"); a.push(f.family); }
      if (f.since !== undefined) { w.push("t_start>=?"); a.push(f.since); }
      if (f.until !== undefined) { w.push("t_start<=?"); a.push(f.until); }
      return q<RequestRow>(`SELECT * FROM requests ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY t_start`, ...a);
    },
    /** appearances(text): where did this string ever appear? Bodies (FTS5 MATCH → requests via body_hash),
     *  WS frames (FTS5), aria snapshots of actions (LIKE on blob text), notes.
     *  Desugars to three queries: SELECT r.id,r.t_start,r.url FROM bodies b JOIN bodies_fts f ON f.rowid=b.rowid JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH ?; ... */
    appearances(text: string): { bodies: Array<{ id: string; t_start: number; url: string; hash: string }>; ws: Array<{ seq: number; t: number; ws_id: string; dir: string }>; aria: Array<{ id: string; t_start: number; which: "pre" | "post" }> } {
      const phrase = `"${text.replace(/"/g, '""')}"`;
      const bodies = q(`SELECT r.id, r.t_start, r.url, b.hash FROM bodies b JOIN bodies_fts f ON f.rowid=b.rowid JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH ? ORDER BY r.t_start`, phrase);
      const ws = q(`SELECT w.seq, w.t, w.ws_id, w.dir FROM ws_frames w JOIN ws_fts f ON f.rowid=w.seq WHERE ws_fts MATCH ? ORDER BY w.t`, phrase);
      const aria: Array<{ id: string; t_start: number; which: "pre" | "post" }> = [];
      for (const a of q<{ id: string; t_start: number; pre_aria: string | null; post_aria: string | null }>("SELECT id,t_start,pre_aria,post_aria FROM actions")) {
        for (const which of ["pre", "post"] as const) {
          const h = which === "pre" ? a.pre_aria : a.post_aria;
          if (h && api.hasBlob(h) && api.body(h).includes(text)) aria.push({ id: a.id, t_start: a.t_start, which });
        }
      }
      return { bodies, ws, aria };
    },
    hasBlob(hash: string) { try { return existsSync(blobPath(dir, fullHash(hash))); } catch { return false; } },
    /** timeline(t0,t1): SELECT seq,t,kind,target_id,action_id,ref,summary FROM events WHERE t BETWEEN ? AND ? ORDER BY seq — plus notes interleaved. */
    timeline(t0: number, t1: number): Array<{ seq: number; t: number; kind: string; target_id: string | null; action_id: string | null; ref: string | null; summary: any }> {
      const ev = q("SELECT seq,t,kind,target_id,action_id,ref,summary FROM events WHERE t BETWEEN ? AND ? ORDER BY seq", t0, t1).map((r: any) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null }));
      const notes = q("SELECT seq,t,kind,action_id,name,text FROM notes WHERE t BETWEEN ? AND ?", t0, t1).map((n: any) => ({ seq: -n.seq, t: n.t, kind: "note:" + n.kind, target_id: null, action_id: n.action_id, ref: n.name, summary: n.text }));
      return [...ev, ...notes].sort((a, b) => a.t - b.t);
    },
    /** screenshotAt(t): the persisted frame nearest (at or before) t. SELECT * FROM shots WHERE t<=? ORDER BY t DESC LIMIT 1 */
    screenshotAt(t: number, targetId?: string): { seq: number; t: number; hash: string; kind: string; target_id: string } | null {
      return one(`SELECT seq,t,hash,kind,target_id FROM shots WHERE t<=? ${targetId ? "AND target_id=?" : ""} ORDER BY t DESC LIMIT 1`, ...(targetId ? [t, targetId] : [t]))
        ?? one(`SELECT seq,t,hash,kind,target_id FROM shots ${targetId ? "WHERE target_id=?" : ""} ORDER BY t ASC LIMIT 1`, ...(targetId ? [targetId] : []));
    },
    /** action(id): the stored action row with its report parsed. SELECT * FROM actions WHERE id=? */
    action(id: string): any | null { const r = one<any>("SELECT * FROM actions WHERE id=?", id); if (r) for (const k of ["spec", "resolved", "timeline", "report"]) if (r[k]) r[k] = JSON.parse(r[k]); return r; },
    /** frames(t0,t1): persisted screencast frames in a range. SELECT * FROM shots WHERE t BETWEEN ? AND ? ORDER BY t */
    frames(t0: number, t1: number) { return q("SELECT seq,t,hash,w,h,kind,reason,target_id FROM shots WHERE t BETWEEN ? AND ? ORDER BY t", t0, t1); },
    /** diffTrace(a,b): structural comparison of two actions — request families, UI delta lines, sentinels, verdicts.
     *  Desugars to: two `action(id)` reads + set differences over report.wire[].family, report.ui.*, sentinels rows by action_id. */
    diffTrace(a: string, b: string) {
      const A = api.action(a), B = api.action(b);
      if (!A || !B) throw new Error("diffTrace: unknown action id");
      const fams = (r: any) => new Set<string>((r.report?.wire?.attributed ?? []).map((x: any) => x.family));
      const ui = (r: any) => new Set<string>([...(r.report?.ui?.added ?? []), ...(r.report?.ui?.removed ?? []), ...(r.report?.ui?.changed ?? [])]);
      const sent = (id: string) => q<{ name: string; detail: string }>("SELECT name, detail FROM sentinels WHERE action_id=?", id).map((s) => s.name + ":" + (JSON.parse(s.detail || "{}").title ?? ""));
      const diff = (x: Set<string>, y: Set<string>) => ({ onlyA: [...x].filter((v) => !y.has(v)), onlyB: [...y].filter((v) => !x.has(v)) });
      return { a: { id: a, verdict: A.verdict, settle_ms: A.settle_ms }, b: { id: b, verdict: B.verdict, settle_ms: B.settle_ms }, families: diff(fams(A), fams(B)), ui: diff(ui(A), ui(B)), sentinels: diff(new Set(sent(a)), new Set(sent(b))) };
    },
    close() { db.close(); },
  };
  return api;
}
export type StoreReader = ReturnType<typeof openStore>;
