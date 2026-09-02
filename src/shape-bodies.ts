// Bodies that are not JSON still have a shape and still carry data. Each wire format gets its own skeleton (structure only)
// and its own harvest (which strings are values, which are strong data, which are vocabulary), so shaping and the leak scan
// work the same whether the app speaks JSON, FHIR-XML, CDA, HL7 v2, form posts, HTML fragments or CSV.

export type BodyKind = "json" | "xml" | "html" | "hl7" | "form" | "multipart" | "csv" | "text" | "binary";
export interface Harvest { values: string[]; strong: string[]; vocab: string[] }

// element / key names whose content is a record's own data (FHIR-XML puts every primitive in a value= attribute, so the ELEMENT name is the key)
const NAME_KEYS = /^(name|display|given|family|prefix|suffix|text|title|identifier|valueString|valueText|comment|description|note|notes|address\w*|line|city|country|phone|telecom|email|username|subject|patientName|patientId|dob|birthdate|ssn|mrn|password|passwd|secret|token|apikey|api_key|authorization|credential\w*|sessionid|cookie)$/i;
const TEXTUAL = /json|xml|html|text\/|x-www-form-urlencoded|multipart|csv|hl7|javascript/i;

export function sniff(mime: string | null | undefined, text: string | null | undefined): BodyKind {
  const m = (mime ?? "").toLowerCase(); const t = (text ?? "").trimStart().slice(0, 200);
  if (/json/.test(m) || /^[\[{]/.test(t)) return "json";
  if (/x-www-form-urlencoded/.test(m)) return "form";
  if (/multipart/.test(m)) return "multipart";
  if (/hl7/.test(m) || /^MSH\|/.test(t)) return "hl7";
  if (/csv|tab-separated/.test(m)) return "csv";
  if (/html/.test(m) || /^<!doctype html|^<html|^<(div|table|tr|tbody|ul|form|section|span|p)\b/i.test(t)) return "html";
  if (/xml/.test(m) || /^<\?xml|^<[a-zA-Z]/.test(t)) return "xml";
  if (!m || TEXTUAL.test(m)) return "text";
  return "binary";
}

// --- a tolerant tokenizer for XML and HTML (shapes need tag and attribute names, not conformance) ----------------------
export interface Node { tag: string; attrs: Record<string, string>; children: Node[]; text: string[] }
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
export function parseMarkup(src: string, maxNodes = 6000): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [], text: [] };
  const stack: Node[] = [root]; let count = 0;
  const top = () => stack[stack.length - 1];
  const clean = src.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  for (const m of clean.matchAll(re)) {
    if (count++ > maxNodes) break;
    const [, cdata, close, open, attrStr, selfClose, text] = m;
    if (cdata !== undefined) { top().text.push(cdata.trim()); continue; }
    if (close) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag.toLowerCase() === close.toLowerCase()) { stack.length = i; break; } continue; }
    if (open) {
      const attrs: Record<string, string> = {};
      for (const a of (attrStr ?? "").matchAll(/([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      const node: Node = { tag: open, attrs, children: [], text: [] };
      top().children.push(node);
      if (!selfClose && !VOID.has(open.toLowerCase())) stack.push(node);
      continue;
    }
    if (text !== undefined) { const t = decode(text).replace(/\s+/g, " ").trim(); if (t) top().text.push(t); }
  }
  return root;
}
function decode(s: string): string { return s.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " } as Record<string, string>)[e] ?? _); }

// --- skeletons --------------------------------------------------------------------------------------------------------
type Kind = (s: string) => unknown;   // the shaper's string → kind marker
export function xmlSkeleton(node: Node, kind: Kind, depth = 0): unknown {
  if (depth > 10) return "…";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.attrs)) out["@" + k] = /^xmlns/.test(k) ? "string" : kind(v);
  const groups = new Map<string, Node[]>();
  for (const c of node.children) { const g = groups.get(c.tag); if (g) g.push(c); else groups.set(c.tag, [c]); }
  let n = 0;
  for (const [tag, list] of groups) { if (++n > 60) { out["…"] = `${groups.size} child kinds`; break; } out[tag] = list.length === 1 ? xmlSkeleton(list[0], kind, depth + 1) : [xmlSkeleton(list[0], kind, depth + 1), `…${list.length} items`]; }
  if (node.text.length) out["#text"] = kind(node.text.join(" "));
  return out;
}
const HTML_ATTRS = new Set(["id", "class", "role", "name", "type", "action", "method", "for", "href", "aria-label", "placeholder", "value"]);
export function htmlOutline(node: Node, url: (u: string) => string, depth = 0): unknown {
  if (depth > 8) return "…";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    if (!HTML_ATTRS.has(k) && !k.startsWith("data-")) continue;
    out["@" + k] = k === "href" || k === "action" ? (/^https?:/.test(v) ? url(v) : url("http://x" + (v.startsWith("/") ? v : "/" + v)).replace(/^http:\/\/x/, "")) : k === "class" ? v.split(/\s+/).slice(0, 2).join(" ") : k === "value" || k === "placeholder" ? "<text>" : v;
  }
  const groups = new Map<string, Node[]>();
  for (const c of node.children) { if (/^(svg|path|g|use|noscript)$/i.test(c.tag)) continue; const g = groups.get(c.tag); if (g) g.push(c); else groups.set(c.tag, [c]); }
  let n = 0;
  for (const [tag, list] of groups) { if (++n > 30) { out["…"] = `${groups.size} child kinds`; break; } out[tag] = list.length === 1 ? htmlOutline(list[0], url, depth + 1) : [htmlOutline(list[0], url, depth + 1), `…${list.length} items`]; }
  if (node.text.length) out["#text"] = "<text>";
  return out;
}
export function hl7Skeleton(text: string): unknown {
  const segs = text.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
  return { segments: segs.slice(0, 200).map((s) => { const f = s.split("|"); return `${f[0]}|${f.length - 1} fields`; }), ...(segs.length > 200 ? { "…": `${segs.length} segments` } : {}) };
}
export function formSkeleton(text: string): unknown { const p = new URLSearchParams(text); const out: Record<string, string> = {}; for (const k of p.keys()) out[k] = "<v>"; return out; }
export function multipartSkeleton(text: string, mime: string): unknown {
  const b = mime.match(/boundary="?([^";]+)"?/)?.[1]; if (!b) return { parts: "<multipart>" };
  return { parts: text.split("--" + b).slice(1).filter((p) => p.trim() && p.trim() !== "--").map((p) => { const name = p.match(/name="([^"]*)"/)?.[1] ?? "?"; const filename = p.match(/filename="([^"]*)"/)?.[1]; const ct = p.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]; const body = p.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/\r?\n$/, ""); return { name, ...(filename ? { filename: "<name>" } : {}), ...(ct ? { contentType: ct.trim() } : {}), size: body.length }; }) };
}
export function csvSkeleton(text: string): unknown { const lines = text.split(/\r\n|\r|\n/).filter(Boolean); const sep = (lines[0] ?? "").includes("\t") ? "\t" : ","; return { columns: (lines[0] ?? "").split(sep).map((c) => c.trim().replace(/^"|"$/g, "")), rows: Math.max(0, lines.length - 1) }; }

export function shapeBody(text: string, mime: string | null | undefined, json: Kind, url: (u: string) => string): unknown {
  const kind = sniff(mime, text);
  try {
    switch (kind) {
      case "json": return json(JSON.parse(text));
      case "xml": return xmlSkeleton(parseMarkup(text), json);
      case "html": return htmlOutline(parseMarkup(text), url);
      case "hl7": return hl7Skeleton(text);
      case "form": return formSkeleton(text);
      case "multipart": return multipartSkeleton(text, mime ?? "");
      case "csv": return csvSkeleton(text);
      default: return `<${kind}: ${text.length} chars>`;
    }
  } catch { return `<${kind}: ${text.length} chars>`; }
}

// --- harvest: what in a body is data, strong data, vocabulary -----------------------------------------------------------
const ok = (t: string) => t.length >= 4 && t.length <= 80 && !/^[\d\s.,:/-]+$/.test(t);
const DATA_CTX = /^(td|li|dd|option|address|blockquote|cite|q|time|mark|output)$/i;
const LABEL_CTX = /^(th|label|button|h[1-6]|legend|summary|title|caption|nav|header|footer|menu|figcaption|abbr|kbd)$/i;
export function harvestBody(text: string, mime: string | null | undefined): Harvest {
  const h: Harvest = { values: [], strong: [], vocab: [] };
  const kind = sniff(mime, text);
  try {
    if (kind === "xml") walkXml(parseMarkup(text), h, "");
    else if (kind === "html") walkHtml(parseMarkup(text), h, "body");
    else if (kind === "hl7") for (const seg of text.split(/\r\n|\r|\n/)) { const f = seg.split("|"); if (f[0]) h.vocab.push(f[0].toLowerCase()); for (const field of f.slice(1)) for (const part of field.split(/[\^~&]/)) if (ok(part.trim())) { h.values.push(part.trim()); h.strong.push(part.trim()); } }
    else if (kind === "form") for (const [k, v] of new URLSearchParams(text)) { h.vocab.push(k.toLowerCase()); if (ok(v.trim())) { h.values.push(v.trim()); h.strong.push(v.trim()); } }
    else if (kind === "csv") { const lines = text.split(/\r\n|\r|\n/).filter(Boolean); const sep = (lines[0] ?? "").includes("\t") ? "\t" : ","; for (const c of (lines[0] ?? "").split(sep)) h.vocab.push(c.trim().replace(/^"|"$/g, "").toLowerCase()); for (const l of lines.slice(1, 500)) for (const c of l.split(sep)) { const v = c.trim().replace(/^"|"$/g, ""); if (ok(v)) { h.values.push(v); h.strong.push(v); } } }
  } catch {}
  return h;
}
function walkXml(n: Node, h: Harvest, parent: string, depth = 0): void {
  if (depth > 12) return;
  h.vocab.push(n.tag.toLowerCase().replace(/^.*:/, ""));
  const strongHere = NAME_KEYS.test(n.tag.replace(/^.*:/, "")) || NAME_KEYS.test(parent.replace(/^.*:/, ""));
  for (const [k, v] of Object.entries(n.attrs)) { h.vocab.push(k.toLowerCase()); if (/^xmlns/.test(k)) continue; const t = v.trim(); if (ok(t)) { h.values.push(t); if (strongHere || (k !== "value" && NAME_KEYS.test(k))) h.strong.push(t); } }
  for (const t of n.text) if (ok(t)) { h.values.push(t); if (strongHere) h.strong.push(t); }
  for (const c of n.children) walkXml(c, h, n.tag, depth + 1);
}
function walkHtml(n: Node, h: Harvest, ctx: string, depth = 0): void {
  if (depth > 14) return;
  const tag = n.tag.toLowerCase();
  const here = DATA_CTX.test(tag) ? "data" : LABEL_CTX.test(tag) ? "label" : ctx;
  for (const t of n.text) { if (here === "data") { if (ok(t)) { h.values.push(t); h.strong.push(t); } } else for (const w of t.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) h.vocab.push(w); }
  for (const k of ["placeholder", "aria-label", "title", "alt"]) if (n.attrs[k]) for (const w of n.attrs[k].toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) h.vocab.push(w);
  if (n.attrs.value && ok(n.attrs.value.trim()) && /^(input|option)$/.test(tag)) { h.values.push(n.attrs.value.trim()); if (tag === "input") h.strong.push(n.attrs.value.trim()); }
  for (const c of n.children) walkHtml(c, h, here === "data" && /^(a|span|b|strong|em)$/i.test(c.tag) ? "data" : here, depth + 1);
}
