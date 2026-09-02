// Evidence leaves the environment as shapes, never as values. A committed pack must be readable by a stranger and
// safe to publish: endpoints as templates, bodies as skeletons, the accessibility tree with its data blanked,
// no headers, no screenshots. The same rules find data that leaked into the prose.
import type { StoreReader } from "./store.ts";
import { shapeBody, harvestBody, sniff } from "./shape-bodies.ts";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const DATE = /\b(?:\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
const LONGNUM = /(?<![\w.])\d{5,}(?![\w.])/g;                        // identifiers, phone numbers, epoch stamps; status codes and small counts survive
const TOKEN = /\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{24,}\b/g;   // mixed-case ≥ 24: session ids, JWTs
const HEX = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;                  // needs a letter, so a plain number stays a <number>                                     // a truncated uuid ("755ef0bd…"), a hash prefix — still an identifier
const LONGID = /\b[A-Za-z0-9]{32,}\b/g;                               // concept ids and other long opaque keys

function patterns(s: string): string {
  return s.replace(UUID, "<uuid>").replace(EMAIL, "<email>").replace(DATE, "<date>").replace(TOKEN, "<token>").replace(LONGID, "<id>").replace(HEX, "<hex>").replace(LONGNUM, "<number>");
}
const strip = (w: string) => w.replace(/^[("'\[{<]+|[)"',.;:!?\]}>]+$/g, "");

export interface Shaper {
  isData(phrase: string): boolean;
  text(s: string): string;
  url(u: string): string;
  json(v: unknown): unknown;
  aria(t: string): string;
  report(r: any): any;
  wireRow(r: any): any;
  /** what in these files reads as data: values seen in the app's bodies, identifiers, dates, emails, tokens */
  leaks(files: Array<{ name: string; text: string }>): string[];
  /** how many values the data set holds (0 means the app showed no JSON — shaping then rests on the patterns alone) */
  size: number;
}

/** The pack's own vocabulary: string literals inside `export const vocab = [ … ]` anywhere in the sdk (sdk.ts, or any file under sdk/). */
export function readVocab(sdkSource: string): Set<string> {
  const m = sdkSource.match(/export\s+const\s+vocab\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/["'`]((?:[^"'`\\]|\\.)*)["'`]/g)].map((x) => x[1].trim().toLowerCase()).filter(Boolean));
}

/** What the run says is data: string leaves of its JSON API bodies. And what is vocabulary: every word that occurs in the app's
 *  own bundles and documents, plus every JSON key — a value made only of such words ("Outpatient Clinic", "patient") is a label
 *  the app ships, not a record. */
const NAME_KEYS = /^(name|display|given|family|prefix|suffix|text|identifier|valueString|valueText|comment|description|note|notes|address\w*|city|country|phone|telecom|email|username|subject)$/i;
export function collectValues(st: StoreReader, limit = 2000): { values: Set<string>; vocab: Set<string>; strong: Set<string>; counts: Map<string, number> } {
  const values = new Set<string>(), vocab = new Set<string>(), strong = new Set<string>(), counts = new Map<string, number>();
  let bodies = 0; const seenIn = new Map<string, number>();   // in how many bodies a value occurs: reference data (types, concepts) is everywhere, a record's values are not
  // newest first across runs (t restarts per run), one body per hash: a chart open alone is a hundred JSON answers
  // every textual body the app exchanged (any format), newest first across runs, one per hash — plus the request bodies it sent
  const rows = st.sql<{ text: string | null; mime: string | null }>("SELECT b.text, b.mime FROM bodies b WHERE b.hash IN (SELECT r.body_hash FROM requests r WHERE r.resource_type IN ('xhr','fetch','document','other') AND r.body_hash IS NOT NULL ORDER BY r.run DESC, r.t_start DESC LIMIT ?) AND b.text IS NOT NULL AND b.size <= 262144", limit);
  const sent = st.sql<{ req_body: string | null; req_headers: string | null }>("SELECT req_body, req_headers FROM requests WHERE req_body IS NOT NULL AND resource_type IN ('xhr','fetch','document') ORDER BY run DESC, t_start DESC LIMIT 500");
  // a string under a name-like key (name, display, given, text, identifier, comment…) is data even if some bundle happens to contain the word
  const add = (v: unknown, depth: number, key = "") => {
    if (values.size > 50000 || depth > 12) return;
    if (typeof v === "string") { const t = v.trim(); if (t.length >= 4 && t.length <= 80 && !/^[\d\s.,:/-]+$/.test(t)) { const q = t.toLowerCase(); values.add(q); if (NAME_KEYS.test(key)) strong.add(q); if (seenIn.get(q) !== bodies) { seenIn.set(q, bodies); counts.set(q, (counts.get(q) ?? 0) + 1); } } }
    else if (Array.isArray(v)) v.forEach((x) => add(x, depth + 1, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { vocab.add(k.toLowerCase()); add(x, depth + 1, k); }
  };
  const harvestInto = (text: string, mime: string | null) => {
    const h = harvestBody(text, mime);
    for (const v of h.values) { const q = v.toLowerCase(); values.add(q); if (seenIn.get(q) !== bodies) { seenIn.set(q, bodies); counts.set(q, (counts.get(q) ?? 0) + 1); } }
    for (const v of h.strong) strong.add(v.toLowerCase());
    for (const w of h.vocab) vocab.add(w);
  };
  for (const r of rows) {
    bodies++;
    const kind = sniff(r.mime, r.text);
    if (kind === "json") { try { add(JSON.parse(r.text!), 0); } catch {} }
    else if (kind !== "text" && kind !== "binary") harvestInto(r.text!, r.mime);   // XML, SOAP, HL7, HTML documents and fragments, CSV: by structure, not all words
  }
  for (const r of sent) { bodies++; let ct: string | null = null; try { ct = JSON.parse(r.req_headers ?? "{}")?.["content-type"] ?? null; } catch {} const kind = sniff(ct, r.req_body); if (kind === "json") { try { add(JSON.parse(r.req_body!), 0); } catch {} } else if (kind !== "text" && kind !== "binary") harvestInto(r.req_body!, ct); }
  // the app's own words: its scripts (deduplicated by hash; the text column is capped at 512 KB each) — documents went through the harvest above, where cells are data and labels are vocabulary
  const assets = st.sql<{ text: string | null }>("SELECT DISTINCT b.text FROM requests r JOIN bodies b ON b.hash = r.body_hash WHERE r.resource_type IN ('script') AND b.text IS NOT NULL LIMIT 400");
  for (const a of assets) { for (const w of a.text!.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) { vocab.add(w); if (vocab.size > 400000) break; } }
  return { values, vocab, strong, counts };
}

export function makeShaper(sets: { values: Set<string>; vocab: Set<string>; strong?: Set<string>; counts?: Map<string, number>; allow?: Set<string> } | Set<string>): Shaper {
  const values = sets instanceof Set ? sets : sets.values;
  const vocab = sets instanceof Set ? new Set<string>() : sets.vocab;
  const strong = sets instanceof Set ? new Set<string>() : (sets.strong ?? new Set<string>());
  const counts = sets instanceof Set ? new Map<string, number>() : (sets.counts ?? new Map<string, number>());
  // the pack's own allowlist: `export const vocab = ["Vitals", "Facility Visit", …]` in sdk.ts — labels the author vouches for, kept visible everywhere
  const allow = sets instanceof Set ? new Set<string>() : (sets.allow ?? new Set<string>());
  // reference data — a visit type, an encounter type, a concept — recurs across many bodies; a record's own values do not. Evidence still blanks it; prose is not nagged about it.
  const isReference = (p: string) => (counts.get(strip(p).trim().toLowerCase()) ?? 0) >= 5;
  // a value whose every word the app ships itself is a label, not a record ("outpatient clinic", "patient"); a name is not in any bundle
  const isLabel = (p: string) => { const words = p.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []; return words.length > 0 && words.every((w) => vocab.has(w)); };
  const isData = (p: string) => { const q = strip(p).trim().toLowerCase(); if (allow.has(q)) return false; return strong.has(q) || (values.has(q) && !isLabel(q)); };
  const text = (s: string): string => {
    if (!s) return s;
    const words = patterns(s).split(/(\s+)/);   // keep the whitespace tokens
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
      if (/^\s+$/.test(words[i]) || !words[i]) { out.push(words[i]); continue; }
      let hit = -1;
      for (let n = 4; n >= 1; n--) {                       // the longest phrase first
        const idx: number[] = []; for (let j = i; j < words.length && idx.length < n; j++) if (!/^\s+$/.test(words[j]) && words[j]) idx.push(j);
        if (idx.length < n) continue;
        const phrase = idx.map((j) => words[j]).join(" ");
        if (isData(phrase)) { hit = idx[idx.length - 1]; break; }
      }
      if (hit >= 0) { const lead = words[i].match(/^[("'\[{<]+/)?.[0] ?? ""; const tail = words[hit].match(/[)"',.;:!?\]}>]+$/)?.[0] ?? ""; out.push(`${lead}<data>${tail}`); i = hit; } else out.push(words[i]);
    }
    return out.join("");
  };
  const url = (u: string): string => {
    let parsed: URL; try { parsed = new URL(u); } catch { return text(u); }
    const path = parsed.pathname.split("/").map((seg) => {
      if (!seg) return seg;
      if (UUID.test(seg) || TOKEN.test(seg)) { UUID.lastIndex = 0; TOKEN.lastIndex = 0; return seg.match(UUID) ? "<uuid>" : "<token>"; }
      UUID.lastIndex = 0; TOKEN.lastIndex = 0;
      if (/^\d+$/.test(seg)) return "<id>";   // an all-digit path segment is an id (versions carry letters: v1)
      if (/^\d{4}-\d{2}-\d{2}/.test(seg)) return "<date>";
      if (isData(decodeURIComponent(seg))) return "<data>";
      return seg;
    }).join("/");
    const q = [...parsed.searchParams.keys()].map((k) => `${k}=<v>`).join("&");
    return `${parsed.origin}${path}${q ? "?" + q : ""}`;
  };
  const kind = (s: string): string => {
    UUID.lastIndex = 0; if (UUID.test(s)) { UUID.lastIndex = 0; return "<uuid>"; }
    EMAIL.lastIndex = 0; if (EMAIL.test(s)) { EMAIL.lastIndex = 0; return "<email>"; }
    DATE.lastIndex = 0; if (DATE.test(s)) { DATE.lastIndex = 0; return "<date>"; }
    if (/^-?\d+(\.\d+)?$/.test(s)) return "<number-string>";
    if (/^https?:\/\//.test(s)) return url(s);
    return "string";
  };
  const json = (v: unknown, depth = 0): unknown => {
    if (depth > 8) return "…";
    if (v === null || v === undefined) return v;
    if (typeof v === "string") return kind(v);
    if (typeof v === "number") return "number";
    if (typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.length ? [json(v[0], depth + 1), `…${v.length} item${v.length === 1 ? "" : "s"}`] : [];
    if (typeof v === "object") { const out: Record<string, unknown> = {}; let n = 0; for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (++n > 60) { out["…"] = `${Object.keys(v as object).length} keys`; break; } out[k] = json(x, depth + 1); } return out; }
    return String(typeof v);
  };
  const aria = (t: string): string => t.split("\n").map((line) => {
    // an allowlisted label may be part of a name ("Active Visit"): keep such a name whole
    
    const m = line.match(/^(\s*-\s+)([a-z]+)(\s+"(?:[^"\\]|\\.)*")?((?:\s*\[[^\]]*\])*)\s*(:\s*(.*))?$/);
    if (!m) return text(line);
    const [, lead, role, quoted, attrs, colon, rest] = m;
    if (role === "text") return `${lead}text: <text>`;
    const name = quoted ? ` "${text(quoted.trim().slice(1, -1))}"` : "";
    return `${lead}${role}${name}${attrs ?? ""}${colon ? (rest && rest.trim() ? ": <text>" : ":") : ""}`;
  }).join("\n");
  const list = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => (typeof x === "string" ? text(x) : x)) : xs);
  const report = (r: any): any => {
    if (!r || typeof r !== "object") return r;
    const out: any = { ...r };
    out.label = text(String(r.label ?? ""));
    if (r.url) out.url = url(r.url);
    if (r.ui) out.ui = { ...r.ui, added: (r.ui.added ?? []).map((l: string) => aria(l)), removed: (r.ui.removed ?? []).map((l: string) => aria(l)) };
    if (Array.isArray(r.requests)) out.requests = r.requests.map((w: any) => ({ ...w, path: url("http://x" + (w.path?.startsWith("/") ? w.path : "/" + w.path)).replace(/^http:\/\/x/, "") }));
    if (Array.isArray(r.pending)) out.pending = r.pending.map((p: string) => text(p.replace(/(\S+)\s+(\S+)/, (_, m1, p1) => `${m1} ${url("http://x" + p1).replace(/^http:\/\/x/, "")}`)));
    if (Array.isArray(r.writes)) out.writes = r.writes.map((w: string) => w.replace(/^(\S+)\s+(\S+)/, (_, m1, p1) => `${m1} ${url("http://x" + p1).replace(/^http:\/\/x/, "")}`));
    if (r.storage) out.storage = Object.fromEntries(Object.entries(r.storage).map(([k, v]) => [k, (v as string[]).map((line) => line.replace(/^([+-]?[^=:]+)(=|: ).*$/, "$1$2<value>"))]));
    if (Array.isArray(r.console)) out.console = r.console.map((c: any) => ({ ...c, text: text(c.text ?? "") }));
    if (Array.isArray(r.dialogs)) out.dialogs = r.dialogs.map((d: any) => ({ ...d, message: d.message == null ? d.message : text(d.message) }));
    if (Array.isArray(r.pages)) out.pages = r.pages.map((p: string) => url(p));
    if (Array.isArray(r.downloads)) out.downloads = list(r.downloads);
    if (Array.isArray(r.proposed)) out.proposed = r.proposed.map((p: any) => ({ ...p, code: text(p.code) }));
    if (r.note) out.note = text(r.note);
    if ("value" in r) out.value = json(r.value);
    if (r.until && "value" in r.until) out.until = { ...r.until, value: json(r.until.value) };
    if (r.until?.error) out.until = { ...out.until, error: text(r.until.error) };
    if (r.diagnosis) { const d = { ...r.diagnosis }; d.message = text(d.message ?? ""); if (d.over) d.over = text(d.over); if (d.selector) d.selector = text(d.selector); if (d.candidates) d.candidates = list(d.candidates); if (d.dialogs) d.dialogs = list(d.dialogs); delete d.shot; out.diagnosis = d; }
    delete out.shot;
    return out;
  };
  const wireRow = (r: any): any => {
    const hdr = (h: unknown, k: string): string | null => { try { const o = typeof h === "string" ? JSON.parse(h) : h; return o?.[k] ?? null; } catch { return null; } };
    const respCt = hdr(r.resp_headers, "content-type"), reqCt = hdr(r.req_headers, "content-type");
    // a body of any format: JSON as a skeleton, XML/SOAP as an element tree, HL7 as segments, a form as keys, HTML as an outline, CSV as columns
    const body = (b: unknown, ct: string | null) => { if (b == null) return b; if (typeof b !== "string") return json(b); return shapeBody(b, ct, json, url); };
    return { id: r.id, method: r.method, url: url(r.url), status: r.status, mime: r.mime ?? respCt, resource_type: r.resource_type, body_size: r.body_size, body_state: r.body_state, t_start: r.t_start, t_response: r.t_response, t_end: r.t_end, ...(r.req_body != null ? { req_body: body(r.req_body, reqCt) } : {}), ...("response_body" in r ? { response_body: body(r.response_body, r.mime ?? respCt) } : {}) };
  };
  const leaks = (files: Array<{ name: string; text: string }>): string[] => {
    const out: string[] = [];
    for (const f of files) {
      const kinds: Record<string, number> = {};
      for (const [k, re] of Object.entries({ uuid: UUID, email: EMAIL, date: DATE, token: TOKEN })) { const n = (f.text.match(re) ?? []).length; if (n) kinds[k] = n; }
      const phrases = new Set<string>();
      const words = f.text.split(/\s+/);
      // prose is scanned for values that read as records: two words or more, or a long one — not "admin", "true" or a status word
      for (let i = 0; i < words.length && phrases.size < 8; i++) for (let n = 4; n >= 1; n--) { if (i + n > words.length) continue; const p = words.slice(i, i + n).join(" "); const q = strip(p); if ((n >= 2 || q.length >= 8) && isData(p) && !isReference(p)) { phrases.add(q); break; } }
      const parts: string[] = [];
      if (phrases.size) parts.push(`${phrases.size}${phrases.size >= 8 ? "+" : ""} value${phrases.size === 1 ? "" : "s"} seen in the app's bodies — ${[...phrases].slice(0, 4).map((p) => `"${p}"`).join(", ")}`);
      if (Object.keys(kinds).length) parts.push(Object.entries(kinds).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ") + (f.name.endsWith(".ts") ? " (configuration constants, or records?)" : ""));
      if (parts.length) out.push(`${f.name}: ${parts.join("; ")}`);
    }
    return out;
  };
  return { isData, text, url, json, aria, report, wireRow, leaks, size: values.size };
}
