// open-record.ts <n> — open record N on the gauntlet main screen, defensively (GUIDANCE §9).
// Write footprint: READ-ONLY (GET /api/record/<n>; clicking #modal-ack mutates only client-side UI state).
// Interstitial: an "Allergy Review Required" modal (#record-modal) appears ~400-450ms AFTER the record
// fetch settles (observed n=5/5 successful opens, acts 4,7,8,12 + test; ledger.md "record-open-modal").
// It is aria-modal and swallows/occludes later clicks (act:5 silently no-wire, act:10 diagnosis:occluded),
// so this script (a) clears any stale modal first, (b) retries once if occluded, (c) waits out the
// delayed modal and acknowledges it if it appears — treating it as OPTIONAL both directions.
import { connect } from "../../src/client.ts";

const n = process.argv[2];
if (!n || !/^\d+$/.test(n)) { console.error("usage: bun open-record.ts <n>"); process.exit(2); }
const s = await connect();
const die = (msg: string, extra?: unknown) => { console.error("FAIL:", msg, extra ? JSON.stringify(extra).slice(0, 800) : ""); s.close(); process.exit(1); };

// Precondition: main screen (record buttons present), regardless of scroll/modal state.
const pre = await s.evaluate(() => ({
  url: location.href,
  hasButtons: !!document.getElementById("record-buttons"),
  modalUp: (() => { const m = document.getElementById("record-modal"); return !!m && getComputedStyle(m).display !== "none"; })(),
}));
if (!pre.hasButtons) die("precondition: not on main screen (#record-buttons missing)", pre);
if (pre.modalUp) {
  const r = await s.click("#modal-ack", { budgetMs: 2000 });
  if (r.verdict === "diagnosis") die("could not clear stale record modal", r);
  console.log(`cleared stale interstitial (${r.action})`);
}

// Transition: click record button; on occlusion (modal raced us), ack and retry once.
let r: any = await s.click(`#record-${n}`, { budgetMs: 4000, evaluateAfter: () => document.getElementById("record")?.textContent });
if (r.verdict === "diagnosis" && JSON.stringify(r).includes("record-modal")) {
  console.log(`occluded by interstitial; acknowledging and retrying (${r.action})`);
  await s.click("#modal-ack", { budgetMs: 2000 });
  r = await s.click(`#record-${n}`, { budgetMs: 4000, evaluateAfter: () => document.getElementById("record")?.textContent });
}
if (r.verdict === "diagnosis") die("record button not actionable", r.report ?? r);

// Postcondition via the WIRE, not the DOM: the attributed GET /api/record/<n> body is the fact source.
const req = (r.wire?.attributed ?? []).find((x: any) => x.family?.includes("/api/record/"));
if (!req?.body) die(`no attributed GET /api/record/${n} — click likely swallowed (overlay?)`, { verdict: r.verdict, wire: r.wire, screen: r.evaluateAfter });
const record = s.store.json(req.body);
if (String(record.id) !== n) die(`wire returned record ${record.id}, wanted ${n}`, record);

// The delayed interstitial: give it modalDelayMs(400)+slack to appear; acknowledge if it does.
const w: any = await s.watch({ fn: () => { const m = document.getElementById("record-modal"); return !!m && getComputedStyle(m).display !== "none"; } }, { budgetMs: 1500 });
let modal = "absent";
if (w.ok || w.matched) {
  const ack = await s.click("#modal-ack", { budgetMs: 2000 });
  if (ack.verdict === "diagnosis") die("modal appeared but could not acknowledge", ack);
  modal = `acknowledged (${ack.action})`;
}
console.log(JSON.stringify({ ok: true, act: r.action, verdict: r.verdict, record, interstitial: modal }, null, 1));
s.close();
