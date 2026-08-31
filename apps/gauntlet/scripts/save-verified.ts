// save-verified.ts — run the Save flow and verify what the WIRE says, not the optimistic screen.
// Write footprint: WRITE (POST /api/save). Do not run under a read-only stance.
// Observed (act:14): screen flips to "Saved ✓" at ~34ms while the server answered 202 {"pending":true};
// real completion is a follow-up GET /api/save/status (~+520ms, outside the settled window,
// attribution "none") plus a transient "Saved" toast (sentinel seq:5). Optimistic UI — GUIDANCE §8.
import { connect } from "../../src/client.ts";

const s = await connect();
const die = (msg: string, extra?: unknown) => { console.error("FAIL:", msg, extra ? JSON.stringify(extra).slice(0, 800) : ""); s.close(); process.exit(1); };
if (!(await s.evaluate(() => !!document.getElementById("save")))) die("precondition: #save not on screen");

// `until` on the follow-up status request keeps the causality window open past the 202, so the async
// completion lands ATTRIBUTED in this report instead of `trailing` (DECISIONS #35).
const r: any = await s.click("#save", { budgetMs: 4000, until: { urlLike: "/api/save/status", landed: true, budgetMs: 4000 }, evaluateAfter: () => document.getElementById("save-state")?.textContent });
if (r.verdict === "diagnosis") die("save button not actionable", r);
const post = (r.wire?.attributed ?? []).find((x: any) => x.family?.includes("/api/save") && !x.family?.includes("/api/save/status"));
if (!post) die("no attributed POST /api/save — click swallowed?", { verdict: r.verdict, screen: r.evaluateAfter });
const wireBody = post.body ? s.store.json(post.body) : null;
const screenAtSettle = r.evaluateAfter;
const optimistic = /saved/i.test(String(screenAtSettle)) && (wireBody?.pending === true || /202/.test(post.line));

// Completion evidence: wait (evidence-based, diagnostic on expiry) for the async confirmation toast,
// then corroborate on the wire: a GET /api/save/status after our POST.
const w: any = await s.watch({ fn: () => { const t = document.getElementById("toast"); return !!t && (t.textContent ?? "") !== "" ? t!.textContent : false; } }, { budgetMs: 4000 });
const t0 = s.store.action(r.action)?.t_start ?? 0;
const status = s.store.sql<any>("SELECT status, body_hash FROM requests WHERE path LIKE '/api/save/status%' AND t_start>? ORDER BY t_start DESC LIMIT 1", t0)[0];
console.log(JSON.stringify({
  ok: !!status && status.status === 200, act: r.action, verdict: r.verdict,
  screenAtSettle, wire: { line: post.line, body: wireBody },
  optimisticUi: optimistic ? "YES — screen claimed success before server confirmed (202 pending)" : "no",
  completion: status ? { savStatusHttp: status.status, body: status.body_hash ? s.store.json(status.body_hash) : null } : "NOT OBSERVED within 4s",
  toast: w.ok || w.matched ? (w.preview ?? "seen") : "not seen in 4s",
}, null, 1));
s.close();
