// Sentinels (GUIDANCE §5.3): standing watchers that fire action-or-no-action. The in-page observer
// supplies dialog/toast/expiry candidates; network/console supply errors; target attach supplies new_target.
// A firing = a screenshot at the moment + a `sentinels` row + a stream event; the next report lists it.
import { defaults } from "../defaults.ts";
import type { Daemon, TargetState } from "./daemon.ts";

export type SentinelName = "dialog" | "toast" | "session_expiry" | "error" | "new_target";

const recent = new Map<string, number>(); // dedupe key → last fired (session clock)
export async function fireSentinel(d: Daemon, t: TargetState | null, name: SentinelName, detail: Record<string, unknown>, opts: { frameId?: string | null; t?: number; shot?: boolean } = {}): Promise<number> {
  const at = opts.t ?? d.now();
  // Identical firings within a short window collapse to one (a telemetry endpoint 401-ing six times on a page
  // load produced six sentinels with the same shot — P4-A friction #7).
  // Only `error` sentinels dedupe: dialogs/toasts are already announced once per element by the in-page census,
  // and two identical toasts 3s apart ARE two events ("Saved" twice).
  if (name === "error") {
    const key = `${detail.url ?? detail.message ?? ""}|${detail.status ?? detail.error ?? detail.level ?? ""}`;
    const last = recent.get(key);
    if (last !== undefined && at - last < defaults.sentinelDedupeMs) return -1;
    recent.set(key, at);
  }
  const actionId = t ? d.windowFor(t.targetId, at)?.actionId ?? null : null;
  let shot: string | null = null;
  if (opts.shot !== false && t) {
    try { shot = (await d.captureShot(t, `sentinel:${name}`)).hash; } catch (e) { d.log(`sentinel shot failed: ${(e as Error).message}`); }
  }
  const seq = d.store.insert("sentinels", { t: at, target_id: t?.targetId ?? null, frame_id: opts.frameId ?? null, name, detail: JSON.stringify(detail), shot, action_id: actionId });
  d.publish({ kind: "sentinel", t: at, targetId: t?.targetId, frameId: opts.frameId ?? undefined, actionId, ref: seq, summary: { name, ...digest(detail), shot } });
  return seq;
}

function digest(detail: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of ["title", "text", "role", "sel", "status", "url", "message", "level", "type"]) if (detail[k] !== undefined) out[k] = typeof detail[k] === "string" ? String(detail[k]).slice(0, 160) : detail[k];
  return out;
}
