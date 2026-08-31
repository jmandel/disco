// Slice 2 CLI commands: act / settle / watch. Human-readable digest by default; --json for the full report.
import type { RpcClient } from "../src/rpc.ts";
import { KIND_NAMES } from "../src/kinds.ts";
import { defaults } from "../defaults.ts";

interface Ctx { client: (dir?: string) => Promise<RpcClient>; sessionDir: (s?: string) => string; out: (o: unknown) => void; die: (m: string) => never }

const KINDS = new Set<string>(KIND_NAMES);

export async function run(cmd: string, pos: string[], flags: Record<string, string | boolean>, ctx: Ctx): Promise<void> {
  const f = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const num = (k: string) => (f(k) !== undefined ? Number(f(k)) : undefined);
  const call = async (method: string, params: any, timeout = 90000) => {
    const c = await ctx.client();
    try { return await c.call(method, params, timeout); } finally { c.close(); }
  };
  /** --target <id-prefix | url-part>: pick a scoped page target (multi-tab sessions) without knowing the full id. */
  const targetId = async (): Promise<string | undefined> => {
    if (f("target-id")) return f("target-id");
    const spec = f("target"); if (!spec) return undefined;
    const ts: any[] = await call("targets", {});
    const t = ts.find((x) => x.targetId.startsWith(spec) || String(x.url).includes(spec));
    if (!t) ctx.die(`--target ${spec}: no scoped target matches (disco targets lists them)`);
    return t.targetId;
  };

  if (cmd === "act") {
    const kind = pos[0];
    if (!kind || !KINDS.has(kind)) ctx.die(`act <${[...KINDS].join("|")}> [target] [--text t] [--key k] [--url u] [--to sel|--to-dx N --to-dy N] [--value v] [--frame f] [--target id-prefix|url-part] [--budget ms] [--eval "fn"] [--until sel [--until-visible] | --until-fn "fn" | --until-url part [--until-landed]] [--until-budget ms] [--until-tail ms] [--json]`);
    const p: any = {
      kind, target: pos[1], text: f("text"), key: f("key") ?? (kind === "press" ? pos[1] : undefined), url: f("url") ?? (kind === "navigate" ? pos[1] : undefined), value: f("value"),
      to: f("to"), frame: f("frame"), targetId: await targetId(), budgetMs: num("budget"), quietMs: num("quiet"), noEffectMs: num("no-effect"), maxBudgetMs: num("max-budget"),
      evaluateAfter: f("eval"), world: f("world"), deltaY: num("delta-y"),
    };
    if (kind === "press") p.target = undefined;
    if (kind === "navigate") p.target = undefined;
    if (f("to-dx") || f("to-dy")) p.toOffset = { dx: num("to-dx") ?? 0, dy: num("to-dy") ?? 0 };
    if (f("until") || f("until-fn") || f("until-url")) p.until = { selector: f("until"), visible: !!flags["until-visible"], fn: f("until-fn"), urlLike: f("until-url"), landed: !!flags["until-landed"], budgetMs: num("until-budget"), tailMs: num("until-tail") };
    const report = await call("act", p, (p.maxBudgetMs ?? defaults.maxBudgetMs) + (p.until ? (p.until.budgetMs ?? defaults.untilBudgetMs) + (p.until.tailMs ?? defaults.untilTailMs) : 0) + 60000);
    printReport(report, flags, ctx);
    return;
  }
  if (cmd === "settle") {
    const report = await call("settle", { action: f("action"), budgetMs: num("budget"), frame: f("frame"), targetId: await targetId() });
    printReport(report, flags, ctx);
    return;
  }
  if (cmd === "watch") {
    const p: any = { selector: pos[0], visible: !!flags.visible, urlLike: f("url-like"), landed: !!flags.landed, fn: f("fn"), fnArg: f("fn-arg") !== undefined ? JSON.parse(f("fn-arg")!) : undefined, budgetMs: num("budget"), frame: f("frame"), targetId: await targetId() };
    if (!p.selector && !p.urlLike && !p.fn) ctx.die('watch <selector> | --url-like part | --fn "()=>…" [--budget ms]');
    const r = await call("watch", p);
    if (flags.json) return ctx.out(r);
    if (r.matched) console.log(`✓ matched in ${r.elapsedMs}ms${r.preview ? "  " + r.preview : ""}${r.request ? "  req " + r.request : ""}`);
    else {
      console.log(`✗ no match in ${r.elapsedMs}ms — diagnosis:`);
      printDiagnosis(r.diagnosis);
    }
    return;
  }
  ctx.die(`unknown command "${cmd}" (see disco help)`);
}

export function printReport(r: any, flags: Record<string, string | boolean>, ctx: Ctx) {
  if (flags.json) return ctx.out(r);
  const s = r.settle;
  console.log(`${r.action}  ${r.kind}${r.target?.selector ? " " + r.target.selector : ""}  →  ${r.verdict}${s ? `  (settled ${s.ms}ms, reported ${s.reportedMs}ms${s.counts ? `; ${s.counts.requests} req, ${s.counts.mutations} mut, ${s.counts.visuals} px` : ""})` : ""}`);
  if (r.timing) console.log(`  timing: page ${r.timing.waitMs}ms (settled ${r.timing.settleMs}, reported ${r.timing.reportedMs}${r.timing.untilMs !== undefined ? `, until ${r.timing.untilMs}` : ""}) + overhead ${r.timing.overheadMs}ms (resolve ${r.timing.resolveMs}, pre ${r.timing.preMs}, post ${r.timing.postMs}, build ${r.timing.buildMs})${r.timing.absorbMs ? ` + scroll-absorb ${r.timing.absorbMs}ms` : ""} = ${r.timing.totalMs}ms`);
  if (r.target?.detachedRetried) console.log(`  note: element detached mid-dispatch; re-resolved once (re-render race)`);
  if (r.until) {
    if (r.until.matched) console.log(`  ✓ until: matched in ${r.until.elapsedMs}ms${r.until.preview ? "  " + r.until.preview : ""}${r.until.request ? "  req " + r.until.request : ""}`);
    else { console.log(`  ✗ until: NOT matched in ${r.until.elapsedMs}ms — diagnosis:`); printDiagnosis(r.until.diagnosis); }
  }
  if (r.diagnosis) { printDiagnosis(r.diagnosis); if (r.env?.url) console.log(`    in: ${r.env.url}   (multi-tab? \`disco targets\`, then --target <id-prefix|url-part> or \`disco focus\`)`); }
  if (r.ui && (r.ui.added.length || r.ui.removed.length)) {
    for (const l of r.ui.added.slice(0, 10)) console.log(`  + ${l}`);
    if (r.ui.addedMore) console.log(`  + …${r.ui.addedMore} more`);
    for (const l of r.ui.removed.slice(0, 6)) console.log(`  - ${l}`);
    if (r.ui.removedMore) console.log(`  - …${r.ui.removedMore} more`);
  }
  if (r.wire?.attributed?.length) {
    for (const w of r.wire.attributed) console.log(`  ⇄ ${w.line}${w.body ? "  body:" + w.body.slice(0, 12) : ""}`);
    if (r.wire.more) console.log(`  ⇄ +${r.wire.more} more (cursor ev:${r.cursor.from}-${r.cursor.to})`);
  }
  if (r.wire?.ambientInWindow) console.log(`  ~ ${r.wire.ambientInWindow} ambient request(s) during window`);
  if (r.wire?.otherActivity?.length) console.log(`  ? other activity: ${r.wire.otherActivity.join("; ")}`);
  if (r.wire?.ws) console.log(`  ⇄ ${r.wire.ws} WS frame(s) in window`);
  if (r.wire?.sse) console.log(`  ⇄ ${r.wire.sse} SSE message(s) in window`);
  if (r.console?.length) for (const c of r.console) console.log(`  ⚠ ${c}`);
  for (const sn of r.env?.sentinels ?? []) console.log(`  ⚑ sentinel ${sn.name}${sn.title ? `: "${sn.title}"` : ""}${sn.shot ? "  shot:" + sn.shot.slice(0, 12) : ""}`);
  if (r.env?.dialogs?.length) console.log(`  ⚑ dialogs: ${r.env.dialogs.join("; ")}`);
  if (r.env?.urlChanged) console.log(`  → url: ${r.env.urlChanged}`);
  if (r.env?.newTargets?.length) console.log(`  → new target(s): ${r.env.newTargets.join("; ")}`);
  if (r.env?.writeFlag) console.log(`  ✎ writes: ${r.env.writeFlag.join("; ")}`);
  if (r.env?.classifierImmature) console.log(`  (ambient classifier immature: ${Math.round((r.env.classifierIdleMs ?? 0) / 1000)}s of ${Math.round(defaults.classifierWarmupMs / 1000)}s idle observed — \`disco idle ${Math.max(1000, defaults.classifierWarmupMs - (r.env.classifierIdleMs ?? 0))}\` with the page open finishes it)`);
  if (r.env?.castBlind) console.log(`  (tab not visible: screencast blind)`);
  if (r.evaluateAfter !== undefined) console.log(`  eval: ${JSON.stringify(r.evaluateAfter)?.slice(0, 300)}`);
  if (s?.pending) console.log(`  still moving: ${[...s.pending.channels, ...s.pending.requests.map((x: string) => "req " + x)].join(", ") || "(nothing identified)"}`);
  console.log(`  cursor ev:${r.cursor.from}-${r.cursor.to}  shots pre:${r.shots?.pre?.slice(0, 10) ?? "-"} post:${r.shots?.post?.slice(0, 10) ?? "-"}`);
}

function printDiagnosis(dg: any) {
  if (!dg) return;
  console.log(`  ✗ ${dg.reason}${dg.error ? ": " + dg.error : ""}${dg.occludedBy ? " — occluded by " + dg.occludedBy : ""}`);
  if (dg.candidates?.length) console.log(`    near matches: ${dg.candidates.slice(0, 6).join(" | ")}`);
  if (dg.census?.dialogs?.length) console.log(`    open dialogs: ${dg.census.dialogs.map((x: any) => x.title || x.sel).join("; ")}`);
  if (dg.pendingRequests?.length) console.log(`    pending: ${dg.pendingRequests.join("; ")}`);
  if (dg.domActive) console.log(`    dom mutated within the last second`);
  if (dg.shot) console.log(`    shot: ${dg.shot.slice(0, 12)}`);
}
