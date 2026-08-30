// Layer-1 reusable move: read a fact straight off the wire the app already fetched (GUIDANCE §2.3).
// Product functions prefer this over scraping the DOM. Plain TS; operates on any session's store.
import type { StoreReader } from "../src/store.ts";

export interface WireOpts { urlLike: string; as?: "json" | "text"; which?: "last" | "first"; optional?: boolean; actionId?: string }

/** Find a captured response body whose URL contains `urlLike` and return it parsed (json) or raw (text).
 *  Throws if none found unless `optional`. `which` picks newest (default) or oldest matching request. */
export function extractFromWire<T = any>(store: StoreReader, opts: WireOpts): T {
  const rows = store.requests({ urlLike: `%${opts.urlLike}%`, actionId: opts.actionId }).filter((r) => r.body_hash);
  const row = opts.which === "first" ? rows[0] : rows[rows.length - 1];
  if (!row) {
    if (opts.optional) return undefined as unknown as T;
    throw new Error(`extractFromWire: no captured body matching ${JSON.stringify(opts.urlLike)}`);
  }
  return (opts.as === "text" ? store.body(row.body_hash!) : store.json(row.body_hash!)) as T;
}

/** True if the app has already fetched something matching `urlLike` (with a captured body). */
export function wireHas(store: StoreReader, urlLike: string): boolean {
  return store.requests({ urlLike: `%${urlLike}%` }).some((r) => r.body_hash);
}
