// Reports and looks as text — what the CLI prints and what `String(report)` returns.
import type { Report, Diagnosis } from "./session.ts";
import type { Look } from "./look.ts";

export function formatReport(r: Report): string {
  const L: string[] = [];
  const tm = r.timing;
  const secs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
  L.push(`${r.action} "${r.label}"  ${r.ok ? "ok" : "FAILED"}  ${secs(tm.totalMs)} (run ${tm.runMs} · observe ${tm.observeMs} · report ${tm.reportMs})  returned: ${r.returned}${r.returned === "max" && !r.until ? ` (still changing${r.pending.length ? `; ${r.pending.length} in flight` : ""})` : ""}  ${r.url}${r.openPages > 1 ? `  (+${r.openPages - 1} other page${r.openPages > 2 ? "s" : ""} open)` : ""}`);
  if (r.diagnosis) L.push("  diagnosis: " + fmtDiag(r.diagnosis));
  if (r.until) L.push(`  until: ${r.until.ok ? "✓" : "✗"} ${r.until.elapsedMs}ms${r.until.alreadyTrue ? "  ⚠ already true before the action — it proves nothing; wait for something that is false beforehand" : ""}${r.until.ok ? "" : " — " + (r.until.error ?? "")}`);
  if (r.note) L.push("  note: " + r.note);
  if (r.requests.length || r.static?.count) {
    const lines = r.requests.map((w) => `${w.earlier ? "(started earlier) " : ""}${w.method} ${w.path.length > 80 ? w.path.slice(0, 77) + "…" : w.path} ${w.status ?? (w.state === "error" ? "ERR" : "…")}${w.ms != null ? ` ${w.ms}ms` : ""}${w.mime ? " " + w.mime : ""}${w.body ? " " + w.body : ""}${w.size != null ? ` ${fmtBytes(w.size)}` : ""}${w.state && w.state !== "ok" ? ` [${w.state === "missing" ? "body not read by the page" : w.state === "pending" && w.status != null ? "body pending" : w.state}]` : ""}`);
    const st = r.static?.count ? ` + ${r.static.count} static (${Object.entries(r.static.types).map(([k, v]) => `${v} ${k}`).join(", ")})` : "";
    L.push(`  wire (${r.requests.length}${st}):`); for (const l of lines.slice(0, 25)) L.push("    " + l);
    if (lines.length > 25) L.push(`    … ${lines.length - 25} more (sql: SELECT * FROM requests WHERE action_id='${r.action}')`);
  }
  if (r.pending.length) L.push("  pending: " + r.pending.join(" · "));
  if (r.ui.added.length || r.ui.removed.length) {
    L.push("  ui:");
    for (const l of r.ui.added.slice(0, 25)) L.push("    + " + l.slice(0, 120));
    for (const l of r.ui.removed.slice(0, 10)) L.push("    - " + l.slice(0, 120));
    const hidden = Math.max(0, r.ui.added.length - 25) + Math.max(0, r.ui.removed.length - 10) + (r.ui.more ?? 0);
    if (hidden) L.push(`    … ${hidden} more (report.ui has them all)`);
  }
  if (r.writes?.length) L.push("  writes: " + r.writes.join(" · "));
  const st = [...r.storage.cookies.map((x) => "cookie " + x), ...r.storage.local.map((x) => "local " + x), ...r.storage.session.map((x) => "session " + x)];
  if (st.length) L.push("  storage: " + st.join(" · ").slice(0, 400));
  for (const c of r.console.slice(0, 5)) L.push(`  console ${c.level}: ${c.text.slice(0, 160)}`);
  for (const d of r.dialogs) L.push(`  dialog ${d.type} "${(d.message ?? "").slice(0, 100)}" → ${d.handled}`);
  for (const p of r.pages) L.push(`  new page: ${p}`);
  if ("value" in r && r.value !== undefined) L.push("  value: " + (typeof r.value === "string" ? r.value : JSON.stringify(r.value))?.slice(0, 400));
  if (r.proposed.length) {
    L.push("  proposed until (each was false before the action):");
    for (const p of r.proposed) L.push(`    ${p.atMs != null ? `+${p.atMs}ms`.padEnd(8) : "end     "} ${p.code}`);
  }
  return L.join("\n");
}

export function fmtDiag(d: Diagnosis): string {
  const bits = [`${d.reason} — ${d.message}`];
  if (d.selector) bits.push(`selector: ${d.selector}`);
  if (d.over) bits.push(`under the pointer: ${d.over}`);
  if (d.dialogs?.length) bits.push(`open dialogs: ${d.dialogs.join("; ")}`);
  if (d.candidates?.length) bits.push(`visible controls (selectors that paste): ${d.candidates.slice(0, 12).join(", ")}${d.candidates.length > 12 ? ", …" : ""}`);
  if (d.shot) bits.push(`shot: ${d.shot}`);
  return bits.join("\n    ");
}

export function formatLook(l: Look): string {
  const L: string[] = [];
  const box = (b: { x: number; y: number; w: number; h: number } | null) => (b ? `(${b.x},${b.y} ${b.w}×${b.h})` : "(no box)");
  if (l.selector !== undefined) {
    L.push(`look ${l.selector}  ${l.error ? "ERROR" : `${l.count} match${l.count === 1 ? "" : "es"}`}  ${l.url}${l.shot ? `\n  shot: ${l.shot}` : ""}`);
    if (l.error) L.push("  " + l.error);
    for (const m of l.matches ?? []) {
      L.push(`  ${String(m.n).padStart(2)}  ${m.tag}${m.role !== m.tag ? ` ${m.role}` : ""}${m.name ? ` "${m.name}"` : ""}  ${m.visible ? "visible" : "hidden"} ${m.enabled ? "enabled" : "disabled"}${m.inViewport ? "" : " off-viewport"}  ${box(m.box)}  → ${m.selector}`);
      if (m.why) L.push(`      ${m.why}`);
      else if (m.text && m.text !== m.name) L.push(`      text: ${m.text.slice(0, 80)}`);
    }
    if ((l.count ?? 0) > (l.matches?.length ?? 0)) L.push(`  … ${l.count! - l.matches!.length} more`);
  } else {
    L.push(`look ${l.url}  (${l.controls?.length ?? 0} controls${l.shot ? `, numbered in the shot` : ""})${l.shot ? `\n  shot: ${l.shot}` : ""}`);
    if (l.aria) L.push(l.aria.split("\n").map((x) => "  " + x).join("\n"));
    if (l.controls?.length) {
      L.push("  controls:");
      for (const c of l.controls) L.push(`  ${String(c.n).padStart(3)}  ${c.selector.padEnd(48).slice(0, 48)}  ${c.role} "${c.name}"${c.disabled ? " (disabled)" : ""}  ${box(c.box)}`);
    }
  }
  if (l.dialogs.length) L.push("  open dialogs: " + l.dialogs.join("; "));
  if (l.note) L.push("  note: " + l.note);
  return L.join("\n");
}

function fmtBytes(n: number): string { return n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1024 / 1024).toFixed(1)}M`; }
