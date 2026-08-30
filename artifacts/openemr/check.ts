// Live drift check for the OpenEMR function library (PLATFORM.md plan #4). Plain runnable script — NOT a
// *.test.ts, so `bun test` never reaches the internet. Run against a session attached to demo.openemr.io:
//
//   bun cli/disco.ts session new openemr --attach <port> --scope demo.openemr.io --no-idle
//   DISCO_SESSION=openemr bun artifacts/openemr/check.ts
//
// Exits non-zero on any failure, printing what broke — so it can drive a scheduled regression loop.
import { connect } from "../../src/client.ts";
import * as emr from "./lib.ts";

const s = await connect(process.env.DISCO_SESSION ?? "openemr2");
let failed = false;
const ok = (label: string, cond: boolean, detail?: unknown) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); if (!cond) failed = true; };
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
} catch (e) {
  console.log("FAIL  threw:", (e as Error).message);
  failed = true;
} finally {
  s.close();
}
console.log(failed ? "\nCHECK FAILED" : "\nCHECK OK");
process.exit(failed ? 1 : 0);
