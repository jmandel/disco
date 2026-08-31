// Live check for the gauntlet pack against a RUNNING gauntlet (`bun gauntlet`, :4800) — the same shape as
// the other packs' checks, so `bun scripts/run-check.ts gauntlet` works. The offline equivalent (own
// server, own browser) runs in `bun test` as test/gauntlet/lib.test.ts.
import { connect, type Session } from "../../src/client.ts";
import * as g from "./lib.ts";

export const target = { url: "http://localhost:4800/", scope: "localhost:4800" };

export async function check(s: Session): Promise<boolean> {
  let failed = false; let last = Date.now();
  const ok = (label: string, cond: boolean, detail?: unknown) => { const now = Date.now(); const ms = now - last; last = now; // elapsed since the previous line = this step
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}  (${ms}ms)${detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 200) : ""}`); if (!cond) failed = true; };
  try {
    const rec = await g.openRecord(s, 2);
    ok("openRecord(2) returns the record off the wire", rec.id === 2, rec);
    const names = await g.extractRowNames(s);
    ok("extractRowNames returns the full 10k", names.length === 10000, { count: names.length, last: names.at(-1) });
    const hits = await g.search(s, "ada");
    ok("search returns the debounced hits", hits.length > 0, hits);
  } catch (e) { console.log("FAIL  threw:", (e as Error).message); failed = true; }
  console.log(failed ? "\nCHECK FAILED" : "\nCHECK OK");
  return !failed;
}

if (import.meta.main) {
  const s = await connect(process.env.DISCO_APP ?? "gauntlet");
  const passed = await check(s).finally(() => s.close());
  process.exit(passed ? 0 : 1);
}
