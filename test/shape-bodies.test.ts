// Non-JSON bodies: each format gets a skeleton without values and a harvest that knows what is data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sniff, shapeBody, harvestBody } from "../src/shape-bodies.ts";
import { makeShaper } from "../src/shape.ts";

const sh = makeShaper(new Set());
const shape = (text: string, mime: string) => shapeBody(text, mime, sh.json, sh.url);

const FHIR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Patient xmlns="http://hl7.org/fhir"><id value="0f3c2a1b-1234-4c56-8d9e-a0b1c2d3e4f5"/>
  <identifier><system value="http://openmrs.org/cr"/><value value="100002U"/></identifier>
  <name><text value="Barbara Miller"/><family value="Miller"/><given value="Barbara"/></name>
  <gender value="female"/><birthDate value="1937-06-01"/>
  <address><line value="12 Elm Street"/><city value="Nairobi"/></address>
  <telecom><value value="b.miller@example.org"/></telecom></Patient>`;

test("sniff: mime first, then the first bytes", () => {
  assert.equal(sniff("application/fhir+xml", FHIR_XML), "xml");
  assert.equal(sniff("text/plain", "MSH|^~\\&|A|B|"), "hl7");
  assert.equal(sniff("text/plain", '{"a":1}'), "json");
  assert.equal(sniff("text/html; charset=utf-8", "<table>"), "html");
  assert.equal(sniff("application/x-www-form-urlencoded", "a=1"), "form");
  assert.equal(sniff("image/jpeg", ""), "binary");
});

test("XML: element and attribute names survive, values become kinds, repeats collapse", () => {
  const s = shape(FHIR_XML, "application/fhir+xml") as any;
  assert.deepEqual(Object.keys(s.Patient).sort(), ["@xmlns", "address", "birthDate", "gender", "id", "identifier", "name", "telecom"]);
  assert.equal(s.Patient.id["@value"], "<uuid>");
  assert.equal(s.Patient.birthDate["@value"], "<date>");
  assert.equal(s.Patient.name.text["@value"], "string");
  assert.equal(JSON.stringify(s).includes("Miller"), false);
  const h = harvestBody(FHIR_XML, "application/fhir+xml");
  assert.ok(h.strong.includes("Barbara Miller") && h.strong.includes("Miller") && h.strong.includes("12 Elm Street") && h.strong.includes("Nairobi"), JSON.stringify(h.strong));
  assert.ok(h.vocab.includes("patient") && h.vocab.includes("birthdate"));
  assert.ok(!h.strong.includes("female"), "gender is a value, not strong");
});

test("HL7 v2: segments and field counts; every field is strong data", () => {
  const msg = "MSH|^~\\&|EPIC|HOSP|LAB|LAB|202609020930||ADT^A01|MSG0001|P|2.3\rPID|1||100002U^^^CR||Miller^Barbara^J||19370601|F|||12 Elm Street^^Nairobi\rPV1|1|I|WARD^01^02";
  assert.deepEqual(shape(msg, "x-application/hl7-v2+er7"), { segments: ["MSH|11 fields", "PID|11 fields", "PV1|3 fields"] });
  const h = harvestBody(msg, "text/plain");
  assert.ok(h.strong.includes("Miller") && h.strong.includes("Barbara") && h.strong.includes("Nairobi") && h.strong.includes("100002U"), JSON.stringify(h.strong));
  assert.ok(h.vocab.includes("pid"));
});

test("form-encoded and multipart: keys stay, values vanish and are strong", () => {
  assert.deepEqual(shape("username=admin&password=pw-for-the-test&remember=on", "application/x-www-form-urlencoded"), { username: "<v>", password: "<v>", remember: "<v>" });
  const h = harvestBody("username=admin&password=pw-for-the-test", "application/x-www-form-urlencoded");
  assert.ok(h.strong.includes("pw-for-the-test") && h.strong.includes("admin"));
  const mp = "--XYZ\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhello there\r\n--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"scan.pdf\"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 binary\r\n--XYZ--";
  assert.deepEqual(shape(mp, 'multipart/form-data; boundary=XYZ'), { parts: [{ name: "note", size: 11 }, { name: "file", filename: "<name>", contentType: "application/pdf", size: 15 }] });
});

test("HTML fragment: an outline with ids, roles and blanked text; cells are data, headers are vocabulary", () => {
  const html = '<table id="people"><thead><tr><th>Name</th><th>Ward</th></tr></thead><tbody><tr><td><a href="/patient/42">Barbara Miller</a></td><td>Ward 3</td></tr><tr><td>Alan Turing</td><td>Ward 1</td></tr></tbody></table><button class="btn primary">Add patient</button>';
  const s = shape(html, "text/html") as any;
  assert.equal(s.table["@id"], "people");
  assert.equal(s.table.tbody.tr[1], "…2 items");
  assert.equal(s.table.tbody.tr[0].td[0].a["@href"], "/patient/<id>");
  assert.equal(JSON.stringify(s).includes("Barbara"), false);
  const h = harvestBody(html, "text/html");
  assert.ok(h.strong.includes("Barbara Miller") && h.strong.includes("Alan Turing") && h.strong.includes("Ward 3"), JSON.stringify(h.strong));
  assert.ok(h.vocab.includes("name") && h.vocab.includes("ward") && h.vocab.includes("add") && h.vocab.includes("patient"));
  assert.ok(!h.values.includes("Add patient"), "a button label is not a value");
});

test("SOAP: the envelope is XML like any other — body operation names survive, patient data does not", () => {
  const soap = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Header><wsse:Security xmlns:wsse="x"><wsse:UsernameToken><wsse:Username>svc-user</wsse:Username><wsse:Password>s3cr3t-pass-word</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header><soap:Body><ns:GetPatientResponse xmlns:ns="urn:ehr"><ns:Patient><ns:MRN>100002U</ns:MRN><ns:Name>Barbara Miller</ns:Name><ns:BirthDate>1937-06-01</ns:BirthDate></ns:Patient></ns:GetPatientResponse></soap:Body></soap:Envelope>`;
  const s = shape(soap, "application/soap+xml; charset=utf-8") as any;
  assert.deepEqual(Object.keys(s["soap:Envelope"]).sort(), ["@xmlns:soap", "soap:Body", "soap:Header"]);
  assert.equal(s["soap:Envelope"]["soap:Body"]["ns:GetPatientResponse"]["ns:Patient"]["ns:BirthDate"]["#text"], "<date>");
  assert.equal(s["soap:Envelope"]["soap:Header"]["wsse:Security"]["wsse:UsernameToken"]["wsse:Password"]["#text"], "string");
  assert.equal(JSON.stringify(s).includes("Miller") || JSON.stringify(s).includes("s3cr3t"), false);
  const h = harvestBody(soap, "text/xml");
  assert.ok(h.strong.includes("Barbara Miller") && h.strong.includes("100002U") && h.strong.includes("svc-user") && h.strong.includes("s3cr3t-pass-word"), JSON.stringify(h.strong));
  assert.ok(h.vocab.includes("getpatientresponse") && h.vocab.includes("envelope"));
  const fault = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Patient 100002U not found</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
  const f = shape(fault, "text/xml") as any;
  assert.equal(f["soap:Envelope"]["soap:Body"]["soap:Fault"].faultstring["#text"], "string");
});
test("CSV: columns and a row count; cells are strong data", () => {
  const csv = "id,name,dob\n1,Barbara Miller,1937-06-01\n2,Alan Turing,1912-06-23\n";
  assert.deepEqual(shape(csv, "text/csv"), { columns: ["id", "name", "dob"], rows: 2 });
  const h = harvestBody(csv, "text/csv");
  assert.ok(h.strong.includes("Barbara Miller") && h.vocab.includes("dob"));
});

test("other text and binary: length only", () => {
  assert.equal(shape("just some words", "text/plain"), "<text: 15 chars>");
  assert.equal(shape("", "application/pdf"), "<binary: 0 chars>");
});
