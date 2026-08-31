// Live drift check for the OpenEMR function library (PLATFORM.md plan #4). Exports check(s) so a runner
// can drive it against a fresh session; also runs standalone against DISCO_SESSION. NOT a *.test.ts, so
// `bun test` never reaches the internet. One-command form:  bun scripts/run-check.ts openemr
import { connect, type Session } from "../../src/client.ts";
import * as emr from "./lib.ts";

export async function check(s: Session): Promise<boolean> {
  let failed = false;
  const ok = (label: string, cond: boolean, detail?: unknown) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
    if (!cond) failed = true;
  };
  try {
    await emr.login(s, { user: "physician", pass: "physician" });
    ok("login reaches main shell", true);

    const list = await emr.listPatients(s);
    ok("finder lists patients off the wire", list.length > 0, { count: list.length });

    const phil = await emr.findPatient(s, "Belford");
    ok("findPatient(Belford)", phil.name.toLowerCase().includes("belford"), phil);

    await emr.openPatient(s, phil.pid);
    ok("openPatient reaches chart anchor", true, { pid: phil.pid });

    const sum = await emr.extractSummary(s);
    ok("extractSummary returns problems", sum.problems.length > 0, sum);
    ok("Belford problems include HTN", sum.problems.some((p) => /HTN/i.test(p)), sum.problems);

    // search path (patient past page 1) + interstitial-absent branch
    const stone = await emr.findPatient(s, "Stone, Alex");
    ok("findPatient via finder search (page 2+)", stone.name.toLowerCase().includes("stone"), stone);
  } catch (e) {
    console.log("FAIL  threw:", (e as Error).message);
    failed = true;
  }
  console.log(failed ? "\nCHECK FAILED" : "\nCHECK OK");
  return !failed;
}

if (import.meta.main) {
  const s = await connect(process.env.DISCO_SESSION ?? "openemr2");
  const passed = await check(s).finally(() => s.close());
  process.exit(passed ? 0 : 1);
}
