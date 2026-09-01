// The report as text — what the CLI prints and what a script logs.
import type { Report, Diagnosis } from "./session.ts";

export function formatReport(r: Report): string {
  const L: string[] = [];
  const head = `${r.action} ${r.kind}${r.target ? " " + r.target : ""}${r.matches && r.matches > 1 ? ` (${r.matches} matches, used first)` : ""}`;
  const tm = r.timing;
  const parts = [`act ${tm.actMs}`, tm.untilMs ? `until ${tm.untilMs}` : `window ${tm.windowMs}`, `report ${tm.reportMs}`];
  L.push(`${head}  ${r.ok ? "ok" : "FAILED"}  ${tm.totalMs}ms (${parts.join(" · ")})  ${r.url}${r.openPages > 1 ? `  (+${r.openPages - 1} other page${r.openPages > 2 ? "s" : ""} open)` : ""}`);
  if (r.diagnosis) L.push("  diagnosis: " + fmtDiag(r.diagnosis));
  if (r.until) L.push(`  until: ${r.until.ok ? "✓" : "✗"} ${r.until.which ?? ""} ${r.until.elapsedMs}ms${r.until.alreadyTrue ? "  ⚠ already true before the action — proves nothing; pick a predicate that is false beforehand" : ""}${r.until.ok ? "" : " — " + (r.until.error ?? "")}${r.until.diagnosis ? "\n    " + fmtDiag(r.until.diagnosis) : ""}`);
  if (r.requests.length || r.static?.count) {
    const lines = r.requests.map((w) => `${w.earlier ? "(started earlier) " : ""}${w.method} ${w.path.length > 70 ? w.path.slice(0, 67) + "…" : w.path} ${w.status ?? (w.state === "error" ? "ERR" : "…")}${w.ms != null ? ` ${w.ms}ms` : ""}${w.mime ? " " + w.mime : ""}${w.body ? " " + w.body : ""}${w.size != null ? ` ${fmtBytes(w.size)}` : ""}${w.state && w.state !== "ok" ? ` [${w.state === "missing" ? "body missing" : w.state === "pending" && w.status != null ? "body pending" : w.state}]` : ""}${w.until ? "  ← until" : ""}`);
    const st = r.static?.count ? ` + ${r.static.count} static (${Object.entries(r.static.types).map(([k, v]) => `${v} ${k}`).join(", ")}; wire: "all" to list)` : "";
    L.push(`  wire (${r.requests.length}${st}):`); for (const l of lines.slice(0, 25)) L.push("    " + l);
    if (lines.length > 25) L.push(`    … ${lines.length - 25} more (sql: SELECT * FROM requests WHERE action_id='${r.action}')`);
  }
  if (r.ui.added.length || r.ui.removed.length) {
    L.push("  ui:");
    for (const l of r.ui.added.slice(0, 25)) L.push("    + " + l.slice(0, 120));
    for (const l of r.ui.removed.slice(0, 10)) L.push("    - " + l.slice(0, 120));
    const hidden = Math.max(0, r.ui.added.length - 25) + Math.max(0, r.ui.removed.length - 10) + (r.ui.more ?? 0);
    if (hidden) L.push(`    … ${hidden} more (${r.ui.added.length + (r.ui.more ?? 0)} added, ${r.ui.removed.length} removed; report.ui has them all)`);
  }
  for (const c of r.console.slice(0, 5)) L.push(`  console ${c.level}: ${c.text.slice(0, 160)}`);
  for (const d of r.dialogs) L.push(`  dialog ${d.type} "${(d.message ?? "").slice(0, 100)}" → ${d.handled}`);
  for (const p of r.pages) L.push(`  new page: ${p}`);
  if (r.shot) L.push(`  shot: ${r.shot.slice(0, 16)}`);
  return L.join("\n");
}

export function fmtDiag(d: Diagnosis): string {
  const bits = [`${d.reason} — ${d.message}`];
  if (d.over) bits.push(`over: ${d.over}`);
  if (d.dialogs?.length) bits.push(`open dialogs: ${d.dialogs.join("; ")}`);
  if (d.candidates?.length) bits.push(`visible controls (selectors that paste): ${d.candidates.slice(0, 12).join(", ")}${d.candidates.length > 12 ? ", …" : ""}`);
  if (d.shot) bits.push(`shot ${d.shot.slice(0, 16)}`);
  return bits.join("\n    ");
}

function fmtBytes(n: number): string { return n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1024 / 1024).toFixed(1)}M`; }
