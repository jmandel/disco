// Shaping: what leaves the environment is structure, never values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShaper } from "../src/shape.ts";

const sh = makeShaper(new Set(["barbara miller", "alan turing", "penicillin", "outpatient clinic"]));
const shv = makeShaper({ values: new Set(["barbara miller", "outpatient clinic", "patient", "female"]), vocab: new Set(["outpatient", "clinic", "patient", "female", "search"]) });

test("a value under a name-like key is data even when a bundle contains the word", () => {
  const sh2 = makeShaper({ values: new Set(["nini", "female"]), vocab: new Set(["nini", "female"]), strong: new Set(["nini"]) });
  assert.equal(sh2.isData("nini"), true); assert.equal(sh2.isData("Female"), false);
  assert.equal(sh2.aria('- link "nini":\n- radio "Female"'), '- link "<data>":\n- radio "Female"');
});
test("vocabulary: a value made of the app's own words is a label, not data", () => {
  assert.equal(shv.isData("Outpatient Clinic"), false);
  assert.equal(shv.isData("patient"), false);
  assert.equal(shv.isData("Barbara Miller"), true);
  assert.equal(shv.text('radio "Female" · heading "Barbara Miller" · Outpatient Clinic'), 'radio "Female" · heading "<data>" · Outpatient Clinic');
});

test("json: skeletons keep keys, types and lengths, never values", () => {
  const s = sh.json({ uuid: "0f3c2a1b-1234-4c56-8d9e-a0b1c2d3e4f5", name: { given: ["Barbara"], family: "Miller" }, age: 88, active: true, dob: "1937-06-01", email: "b@example.org", tags: [], results: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.deepEqual(s, { uuid: "<uuid>", name: { given: ["string", "…1 item"], family: "string" }, age: "number", active: true, dob: "<date>", email: "<email>", tags: [], results: [{ id: "number" }, "…3 items"] });
});

test("url: identifiers become templates, query values vanish, keys stay", () => {
  assert.equal(sh.url("https://ehr.example.org/ws/rest/v1/patient/0f3c2a1b-1234-4c56-8d9e-a0b1c2d3e4f5/allergy?v=full&q=Miller"), "https://ehr.example.org/ws/rest/v1/patient/<uuid>/allergy?v=<v>&q=<v>");
  assert.equal(sh.url("https://x.org/api/record/12345/2026-09-01/x"), "https://x.org/api/record/<id>/<date>/x");
  assert.equal(sh.url("https://x.org/api/chart/a"), "https://x.org/api/chart/a");
});

test("text: values seen in bodies and identifier patterns are replaced; chrome survives", () => {
  assert.equal(sh.text('Search results for Barbara Miller (MRN 100002U), DOB 06/01/1937, at Outpatient Clinic'), "Search results for <data> (MRN 100002U), DOB <date>, at <data>");
  assert.equal(sh.text("Load Chart · status: idle · 3 responses"), "Load Chart · status: idle · 3 responses");
  assert.equal(sh.text("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and id 1234567890"), "token <token> and id <number>");
});

test("aria: control names stay unless they are data; text lines are blanked", () => {
  const out = sh.aria(['- heading "Barbara Miller" [level=1]', '- button "Save"', '- listitem: "name: Alan Turing"', '- text: "DOB 1937-06-01"', '- link "Patient lists":', '  - textbox "Search": admin'].join("\n"));
  assert.equal(out, ['- heading "<data>" [level=1]', '- button "Save"', '- listitem: <text>', '- text: <text>', '- link "Patient lists":', '  - textbox "Search": <text>'].join("\n"));
});

test("report: urls templated, storage values blanked, value skeletonised, shot dropped", () => {
  const r = sh.report({ action: "act:3", label: "open Barbara Miller", url: "https://x.org/patient/0f3c2a1b-1234-4c56-8d9e-a0b1c2d3e4f5/chart", value: { name: "Alan Turing", n: 2 }, storage: { cookies: ["+JSESSIONID=abc123def456", "sid: a → b"], local: [], session: [] }, ui: { added: ['- heading "Barbara Miller"'], removed: [] }, requests: [{ method: "GET", path: "/ws/rest/v1/patient?q=Miller", status: 200 }], proposed: [{ kind: "appeared", code: 'page.getByRole("heading", { name: "Barbara Miller" })' }], diagnosis: { reason: "occluded", message: "covered by div", shot: "/tmp/x.jpg" }, timing: { runMs: 12 } });
  assert.equal(r.label, "open <data>");
  assert.equal(r.url, "https://x.org/patient/<uuid>/chart");
  assert.deepEqual(r.value, { name: "string", n: "number" });
  assert.deepEqual(r.storage.cookies, ["+JSESSIONID=<value>", "sid: <value>"]);
  assert.equal(r.ui.added[0], '- heading "<data>"');
  assert.equal(r.requests[0].path, "/ws/rest/v1/patient?q=<v>");
  assert.match(r.proposed[0].code, /name: "<data>"/);
  assert.equal(r.diagnosis.shot, undefined);
  assert.equal(r.timing.runMs, 12);
});

test("wireRow: no headers, bodies as skeletons", () => {
  const w = sh.wireRow({ id: "r1-4", method: "POST", url: "https://x.org/api/save?id=7", status: 202, req_headers: '{"cookie":"sid=secret"}', resp_headers: '{"content-type":"application/json","set-cookie":"sid=secret2"}', req_body: '{"name":"Alan Turing","dose":5}', response_body: { id: 9, pending: true } });
  assert.deepEqual(Object.keys(w).sort(), ["body_size", "body_state", "id", "method", "mime", "req_body", "resource_type", "response_body", "status", "t_end", "t_response", "t_start", "url"]);
  assert.equal(w.url, "https://x.org/api/save?id=<v>");
  assert.deepEqual(w.req_body, { name: "string", dose: "number" });
  assert.deepEqual(w.response_body, { id: "number", pending: true });
  assert.equal(JSON.stringify(w).includes("secret"), false);
});

test("leaks: prose that carries body values or identifiers is named", () => {
  const out = sh.leaks([{ name: "README.md", text: "The first hit is Barbara Miller (uuid 0f3c2a1b-1234-4c56-8d9e-a0b1c2d3e4f5), allergic to penicillin." }, { name: "sdk.ts", text: 'export const CARE = "6f0c9a92-6f24-11e3-af88-005056821db0";' }, { name: "clean.md", text: "Click Save and wait for the table." }]);
  assert.equal(out.length, 2);
  assert.match(out[0], /README\.md: 2 values seen in the app's bodies — "Barbara Miller", "penicillin"; 1 uuid/);   // "penicillin" is 10 chars
  assert.match(out[1], /sdk\.ts: 1 uuid \(configuration constants, or records\?\)/);
});
