// Ambient DOM roots (GUIDANCE §4.2 escape hatch): subtrees that mutate perpetually while the page is
import { defaults } from "../defaults.ts";
// idle (tickers, clocks, churning widgets) are fingerprinted and classified out of DOM quiescence —
// the DOM analog of the ambient network classifier. Reversible: batches are still recorded; only the
// settlement feed marks them ambient. See DECISIONS #21.
export class AmbientDom {
  private roots = new Map<string, { times: number[]; ambient: boolean }>(); // key: frameId + "|" + rootSel

  /** Learn from an idle batch; decide for any batch. Returns true when the batch is entirely ambient. */
  observe(frameId: string | null, rootSels: string[], t: number, idle: boolean, churn: { added: number; removed: number; attrs: number; text: number }): boolean {
    let allAmbient = rootSels.length > 0;
    for (const sel of rootSels) {
      const key = `${frameId ?? "?"}|${sel}`;
      let r = this.roots.get(key);
      if (!r) { r = { times: [], ambient: false }; this.roots.set(key, r); }
      if (idle) {
        r.times.push(t);
        if (r.times.length > 24) r.times.shift();
        if (!r.ambient && r.times.length >= defaults.ambientDom.minSamples) {
          const span = r.times[r.times.length - 1] - r.times[0];
          const gaps: number[] = [];
          for (let i = 1; i < r.times.length; i++) gaps.push(r.times[i] - r.times[i - 1]);
          gaps.sort((a, b) => a - b);
          const median = gaps[Math.floor(gaps.length / 2)];
          if (span >= defaults.ambientDom.spanMs && median <= defaults.ambientDom.medianMs) r.ambient = true; // recurs at sub-medianMs cadence over spanMs of idle
        }
      }
      if (!r.ambient) allAmbient = false;
    }
    // a large batch is real work even if it touches ambient roots
    if (churn.added + churn.removed > defaults.ambientDom.bigBatch) allAmbient = false;
    return allAmbient;
  }
  ambientKeys(): string[] { return [...this.roots.entries()].filter(([, r]) => r.ambient).map(([k]) => k); }
}
