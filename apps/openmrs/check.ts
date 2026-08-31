// Live drift check for the OpenMRS O3 pack — `bun scripts/run-check.ts openmrs` (fresh headless browser + scoped
// session, opens `target.url`, runs check(s)). Or against the current app session: `bun apps/openmrs/check.ts`.
// Hits the shared public demo (dev3.openmrs.org): slow and data-churny, so names are picked off the wire when possible.
// Write footprint: none beyond what the app does on its own (POST /user/<uuid> patientsVisited on chart open) and,
// only if the location picker appears, POST /ws/rest/v1/session {sessionLocation}.
import { connect, type Session } from "../../src/client.ts";
import * as o from "./lib.ts";

export const target = { url: `${o.SPA}/login`, scope: "dev3.openmrs.org" };

export async function check(s: Session): Promise<boolean> {
  let failed = false; let last = Date.now();
  const ok = (label: string, cond: boolean, detail?: unknown) => { const now = Date.now(); const ms = now - last; last = now;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}  (${ms}ms)${detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 220) : ""}`); if (!cond) failed = true; };
  const acts = () => s.store.sql<{ n: number }>("SELECT COUNT(*) n FROM actions")[0]?.n ?? 0;
  try {
    const info = await o.login(s);
    ok("login reaches the shell; session says authenticated", info.authenticated === true && !!info.user && !!info.sessionLocation, { user: info.user?.display, location: info.sessionLocation?.display });

    const before = acts();
    const again = await o.login(s);
    ok("login is idempotent (no actions when already in)", again.authenticated && acts() === before, { actions: acts() - before });

    const name = pickKnownName(s) ?? "Susan";
    const hit = await o.findPatient(s, name);
    ok(`findPatient(${JSON.stringify(name)}) returns a uuid off the wire`, /^[0-9a-f-]{36}$/.test(hit.uuid) && hit.total >= 1, { uuid: hit.uuid, name: hit.name, identifier: hit.identifier, total: hit.total });

    const chart = await o.openPatient(s, hit.uuid);
    ok("openPatient(uuid) reaches the chart anchor for that patient", chart.url.includes(`/patient/${hit.uuid}/chart`) && !!chart.name, { name: chart.name, identifiers: chart.identifiers });

    const sum = await o.extractSummary(s);
    ok("extractSummary reads conditions/allergies/vitals off FHIR bodies", !!sum.sources.conditions && !!sum.sources.allergies && !!sum.sources.vitals && sum.uuid === hit.uuid,
      { conditions: sum.conditions.length, allergies: sum.allergies.length, vitalsDate: sum.vitals.date, vitals: Object.keys(sum.vitals.values).length });

    const byName = await o.openPatient(s, hit.name);
    ok("openPatient(name) — search route + result card click — lands on the same chart", byName.uuid === hit.uuid && byName.url.includes(`/patient/${hit.uuid}/chart`), { url: byName.url });
  } catch (e) { console.log("FAIL  threw:", (e as Error).message.slice(0, 600)); failed = true; }
  console.log(failed ? "\nCHECK FAILED" : "\nCHECK OK");
  return !failed;
}

/** A patient name the demo currently has — from the service-queue list the home page fetched (wire), if any. */
function pickKnownName(s: Session): string | undefined {
  const q = o.lastBody<{ results?: Array<{ patient?: { display?: string; person?: { display?: string } } }> }>(s, "/ws/rest/v1/queue-entry?");
  for (const e of q?.results ?? []) {
    const n = e.patient?.person?.display ?? e.patient?.display?.replace(/^\S+\s+-\s+/, "");
    if (n && /^[A-Za-z][A-Za-z .'-]+$/.test(n)) return n;
  }
  return undefined;
}

if (import.meta.main) {
  const s = await connect(process.env.DISCO_APP ?? "openmrs");
  const passed = await check(s).finally(() => s.close());
  process.exit(passed ? 0 : 1);
}
