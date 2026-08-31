// The worked examples in docs/using-disco.md ("The two questions") are a runnable demo; executing it here means
// the doc's report excerpts cannot rot without a test noticing. The demo starts its own gauntlet + browser.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("demos", () => {
  test("demos/03-two-questions.ts runs end to end and every example lands where the doc says", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "demos", "03-two-questions.ts")], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.log(out.slice(-3000), err.slice(-2000));
    expect(code).toBe(0);
    expect(out).toContain("demo 3: OK");
    for (const marker of ["Settled ≠ ready", "Both signals, one report", "The wire is the truth", "occluded by <div role=\"dialog\"", "id=\"record-modal\"", "read the diagnosis", '"overheadMs"']) expect(out).toContain(marker);
  }, 120000);
});
