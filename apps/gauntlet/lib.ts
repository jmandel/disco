// Function library for the gauntlet (product instance #1). Plain, importable, composable TS functions
// with specific jobs: reach a known anchor, or perform one step — each robust and wire-first where it can
// be. This is the reference for what a per-product library looks like (PLATFORM.md, palette #4): every
// transition names its postcondition (`until`) and reads its facts off the wire.
//
//   import { connect } from "../../src/client.ts";
//   import * as g from "./lib.ts";
//   const s = await connect("gauntlet");
//   const rec = await g.openRecord(s, 2);          // handles the allergy modal whether or not it appears
//   const names = await g.extractRowNames(s);       // 10k names off the wire, not the DOM
//
import type { Session } from "../../src/client.ts";
import { extractFromWire, wireHas } from "../../lib/wire.ts";
import { assertVisible, actIfPresent, reached } from "../../lib/nav.ts";

/** Anchor: the main gauntlet page is loaded and interactive. */
export async function assertHome(s: Session): Promise<void> {
  await assertVisible(s, "#load-chart", "gauntlet: not at the home anchor (#load-chart missing)");
}

export interface Record { id: number; name: string; dob?: string; [k: string]: unknown }

/** Open record N and return it FROM THE WIRE. Defensive: the postcondition is the record's own fetch landing
 *  (not the panel repainting), the conditional allergy modal is dismissed if it appears (it may not — depends
 *  on record state; it arrives a beat AFTER settlement), and position is never assumed. Anchor in → anchor out. */
export async function openRecord(s: Session, n: number): Promise<Record> {
  await assertHome(s);
  const r = reached(await s.click(`.record[data-id="${n}"]`, { until: { urlLike: `/api/record/${n}`, landed: true } }), `openRecord(${n})`);
  await actIfPresent(s, "#modal-ack");                       // optional interstitial, both ways
  return extractFromWire<Record>(s.store, { urlLike: `/api/record/${n}`, actionId: r.action });
}

/** The full row list, off the wire (the DOM only ever holds ~25 virtualized rows). Loads it if needed. */
export async function extractRowNames(s: Session): Promise<string[]> {
  if (!wireHas(s.store, "/api/rows")) {
    await assertHome(s);
    reached(await s.click("#load-rows", { until: { urlLike: "/api/rows", landed: true } }), "extractRowNames: load rows");
  }
  const rows = extractFromWire<Array<{ name: string }>>(s.store, { urlLike: "/api/rows" });
  return rows.map((row) => row.name);
}

/** Type into the debounced search and return the rendered hits once the trailing XHR has landed. */
export async function search(s: Session, q: string): Promise<string[]> {
  await assertHome(s);
  reached(await s.fill("#search", q, { until: { urlLike: "/api/search", landed: true } }), `search(${q})`);
  return s.evaluate<string[]>(() => [...document.querySelectorAll("#search-results li")].map((li) => (li.textContent ?? "").trim()));
}
