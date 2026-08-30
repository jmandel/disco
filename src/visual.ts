// Visual signal (GUIDANCE §3.4/§4.2): every screencast frame is hashed; changed-hash frames are decoded
// (rate-capped) into a coarse tile signature; tiles that differ beyond a threshold — outside a learned
// ignore mask of perpetually-animating tiles (spinners, clocks) — mean "pixels changed".
import { decode } from "jpeg-js";
import { defaults } from "../defaults.ts";

export interface TileSig { w: number; h: number; cols: number; rows: number; tile: number; data: Uint8Array /* cols*rows*3 mean RGB */ }
export interface Box { x: number; y: number; w: number; h: number }

export function tileSignature(jpeg: Uint8Array, tile = defaults.visualTilePx): TileSig {
  const img = decode(jpeg, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true, maxMemoryUsageInMB: 512 });
  const { width: w, height: h, data } = img;
  const cols = Math.ceil(w / tile), rows = Math.ceil(h / tile);
  const out = new Uint8Array(cols * rows * 3);
  const step = 4; // sample every 4th pixel in each axis: 1/16 of pixels, plenty for mean color
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const x0 = tx * tile, y0 = ty * tile, x1 = Math.min(w, x0 + tile), y1 = Math.min(h, y0 + tile);
      for (let y = y0; y < y1; y += step) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x += step, i += 4 * step) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
      }
      const o = (ty * cols + tx) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { w, h, cols, rows, tile, data: out };
}

/** Indices of tiles whose mean color moved by more than `delta` (max channel), ignoring masked tiles. */
export function diffTiles(a: TileSig, b: TileSig, delta = defaults.visualTileDelta, ignore?: Uint8Array | null): { changed: number[]; all: number[] } {
  const changed: number[] = [], all: number[] = [];
  if (a.cols !== b.cols || a.rows !== b.rows) { for (let i = 0; i < b.cols * b.rows; i++) all.push(i); return { changed: ignore ? all.filter((i) => !ignore[i]) : all, all }; }
  const n = a.cols * a.rows;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
    if (d > delta) { all.push(i); if (!ignore || !ignore[i]) changed.push(i); }
  }
  return { changed, all };
}

/** Bounding box (pixels) of a set of tile indices; plus up to a few clustered boxes for the report. */
export function tileBoxes(sig: TileSig, idx: number[], maxBoxes = 4): Box[] {
  if (!idx.length) return [];
  // simple clustering: group by row bands, then merge overlapping horizontally
  const boxes: Box[] = [];
  const sorted = [...idx].sort((a, b) => a - b);
  for (const i of sorted) {
    const x = (i % sig.cols) * sig.tile, y = Math.floor(i / sig.cols) * sig.tile;
    const near = boxes.find((b) => x >= b.x - sig.tile && x <= b.x + b.w + sig.tile && y >= b.y - sig.tile && y <= b.y + b.h + sig.tile);
    if (near) { const nx = Math.min(near.x, x), ny = Math.min(near.y, y); near.w = Math.max(near.x + near.w, x + sig.tile) - nx; near.h = Math.max(near.y + near.h, y + sig.tile) - ny; near.x = nx; near.y = ny; }
    else boxes.push({ x, y, w: sig.tile, h: sig.tile });
  }
  while (boxes.length > maxBoxes) { // merge the two closest
    let bi = 0, bj = 1, best = Infinity;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const d = Math.hypot(boxes[i].x - boxes[j].x, boxes[i].y - boxes[j].y); if (d < best) { best = d; bi = i; bj = j; } }
    const a = boxes[bi], b = boxes[bj];
    const nx = Math.min(a.x, b.x), ny = Math.min(a.y, b.y);
    a.w = Math.max(a.x + a.w, b.x + b.w) - nx; a.h = Math.max(a.y + a.h, b.y + b.h) - ny; a.x = nx; a.y = ny;
    boxes.splice(bj, 1);
  }
  return boxes.map((b) => ({ x: b.x, y: b.y, w: Math.min(b.w, sig.w - b.x), h: Math.min(b.h, sig.h - b.y) }));
}

/** Learns perpetually-changing tiles from frames observed while no action is in flight. */
export class IgnoreMask {
  private hist: Uint8Array[] = []; // ring of per-tile changed flags (idle frames only)
  private maskArr: Uint8Array | null = null;
  private n = 0;
  constructor(private window = 32, private threshold = defaults.visualIgnoreLearnFrames) {}
  /** Feed the tiles that changed in an idle frame. */
  observe(all: number[], tileCount: number) {
    if (this.n !== tileCount) { this.hist = []; this.n = tileCount; this.maskArr = null; }
    const f = new Uint8Array(tileCount);
    for (const i of all) f[i] = 1;
    this.hist.push(f);
    if (this.hist.length > this.window) this.hist.shift();
    if (this.hist.length >= Math.min(this.window, this.threshold + 4)) {
      const counts = new Uint16Array(tileCount);
      for (const h of this.hist) for (let i = 0; i < tileCount; i++) counts[i] += h[i];
      const m = new Uint8Array(tileCount);
      let any = false;
      for (let i = 0; i < tileCount; i++) if (counts[i] >= this.threshold) { m[i] = 1; any = true; }
      // masks only grow within a session unless the region stops moving for a long time; keep it simple: replace
      this.maskArr = any ? m : null;
    }
  }
  mask(): Uint8Array | null { return this.maskArr; }
  count(): number { return this.maskArr ? this.maskArr.reduce((a, b) => a + b, 0) : 0; }
  regions(sig: TileSig): Box[] { if (!this.maskArr) return []; const idx: number[] = []; for (let i = 0; i < this.maskArr.length; i++) if (this.maskArr[i]) idx.push(i); return tileBoxes(sig, idx); }
}
