import { describe, expect, test } from "bun:test";
import { Attributor, familyOf, type WindowInfo } from "../../src/attribute.ts";

function makeAttributor(win: { current: WindowInfo | null } = { current: null }, t = { now: 0 }) {
  const fams: string[] = [];
  const a = new Attributor({ now: () => t.now, windowFor: () => win.current, onFamily: (f) => fams.push(f.family), startT: 0 });
  return { a, win, t, fams };
}
const req = (id: string, url: string, tStart: number, extra: Record<string, unknown> = {}) => ({ id, method: "GET", url, tStart, targetId: "T1", ...extra }) as any;

describe("familyOf", () => {
  test("collapses ids, uuids, hex and tokens", () => {
    expect(familyOf("get", "http://h/api/patient/12345/summary").family).toBe("GET h/api/patient/*/summary");
    expect(familyOf("GET", "http://h/r/550e8400-e29b-41d4-a716-446655440000?x=1").family).toBe("GET h/r/*");
    expect(familyOf("GET", "http://h/blob/deadbeefdeadbeef01").family).toBe("GET h/blob/*");
    expect(familyOf("POST", "http://h/api/save").family).toBe("POST h/api/save");
  });
});

describe("ambient classification", () => {
  test("regular heartbeat becomes ambient after 3 occurrences outside windows", () => {
    const { a } = makeAttributor();
    for (const [i, t] of [0, 5000, 10000, 15000].entries()) a.observeRequest(req("h" + i, "http://h/api/heartbeat", t));
    expect(a.isAmbient("GET h/api/heartbeat")).toBe(true);
  });
  test("irregular one-off traffic is not ambient", () => {
    const { a } = makeAttributor();
    for (const [i, t] of [0, 700, 4200, 4900].entries()) a.observeRequest(req("x" + i, "http://h/api/x", t));
    expect(a.isAmbient("GET h/api/x")).toBe(false);
  });
  test("chained long-poll becomes ambient even with irregular cadence", () => {
    const { a } = makeAttributor();
    // starts follow previous ends within 250ms; hold times vary wildly (server-dependent)
    const spans: Array<[number, number]> = [[0, 3000], [3100, 3600], [3650, 9000], [9100, 12000]];
    for (const [i, [s, e]] of spans.entries()) { a.observeRequest(req("p" + i, "http://h/api/poll", s)); a.observeEnd("p" + i, e); }
    expect(a.isAmbient("GET h/api/poll")).toBe(true);
  });
  test("ambient family inside a window attributes as ambient, not window", () => {
    const { a, win } = makeAttributor();
    for (const [i, t] of [0, 5000, 10000].entries()) a.observeRequest(req("h" + i, "http://h/api/hb", t));
    win.current = { actionId: "act:1", tStart: 14000, targetId: "T1" };
    const r = a.observeRequest(req("h3", "http://h/api/hb", 15000));
    expect(r.attribution).toBe("ambient");
    expect(r.actionId).toBe("act:1");
  });
  test("a family seen only inside windows never turns ambient", () => {
    const { a, win } = makeAttributor();
    win.current = { actionId: "act:1", tStart: 0, targetId: "T1" };
    for (const [i, t] of [100, 5100, 10100, 15100].entries()) a.observeRequest(req("w" + i, "http://h/api/data", t));
    expect(a.isAmbient("GET h/api/data")).toBe(false);
  });
});

describe("attribution tiers", () => {
  test("window when in a causality window", () => {
    const { a, win } = makeAttributor();
    win.current = { actionId: "act:2", tStart: 1000, targetId: "T1" };
    expect(a.observeRequest(req("r1", "http://h/api/data", 1200)).attribution).toBe("window");
  });
  test("task when inside a task span", () => {
    const { a, win } = makeAttributor();
    win.current = { actionId: "act:3", tStart: 1000, targetId: "T1", taskSpans: [{ t0: 1005, t2: 1020 }] };
    expect(a.observeRequest(req("r1", "http://h/api/data", 1010)).attribution).toBe("task");
    expect(a.observeRequest(req("r2", "http://h/api/data", 1400)).attribution).toBe("window");
  });
  test("redirect of an attributed request is dependency, even after the window closes", () => {
    const { a, win } = makeAttributor();
    win.current = { actionId: "act:4", tStart: 0, targetId: "T1" };
    a.observeRequest(req("r1", "http://h/api/doc", 100));
    win.current = null;
    const r = a.observeRequest(req("r1:r1", "http://h/api/doc2", 600, { redirectFrom: "r1" }));
    expect(r.attribution).toBe("dependency");
    expect(r.actionId).toBe("act:4");
  });
  test("none outside any window", () => {
    const { a } = makeAttributor();
    expect(a.observeRequest(req("r1", "http://h/api/data", 100)).attribution).toBe("none");
  });
});

describe("write kinds", () => {
  test("GET is read; POST is write; graphql query read; mutation write", () => {
    const { a } = makeAttributor();
    expect(a.observeRequest(req("1", "http://h/api/x", 0)).writeKind).toBe("read");
    expect(a.observeRequest({ ...req("2", "http://h/api/save", 1), method: "POST", postData: "{}" }).writeKind).toBe("write");
    expect(a.observeRequest({ ...req("3", "http://h/api/graphql", 2), method: "POST", postData: JSON.stringify({ query: "query { a }" }) }).writeKind).toBe("read");
    expect(a.observeRequest({ ...req("4", "http://h/api/graphql", 3), method: "POST", postData: JSON.stringify({ query: "mutation { b }" }) }).writeKind).toBe("write");
  });
});

describe("rules (DECISIONS #43): URL-substring overrides", () => {
  test("an `ambient` rule forces ambient inside a window; a `not-ambient` rule overrides a learned/marked family", () => {
    const rules = { ambient: ["backtrace.io"], notAmbient: ["/api/session"] };
    const win = { current: { actionId: "act:1", tStart: 0, targetId: "T1" } as WindowInfo };
    const a = new Attributor({ now: () => 0, windowFor: () => win.current, onFamily: () => {}, startT: 0, rules: () => rules });
    expect(a.observeRequest(req("r1", "https://submit.backtrace.io/u/t/json", 10)).attribution).toBe("ambient");
    a.observeRequest(req("s0", "http://h/api/session", 20));
    a.markAmbient("GET h/api/session", true);                       // the family says ambient…
    expect(a.isAmbient("GET h/api/session")).toBe(true);
    expect(a.observeRequest(req("s1", "http://h/api/session", 30)).attribution).not.toBe("ambient"); // …the rule wins
    expect(a.isAmbient("GET h/api/session", "http://h/api/session?x=1")).toBe(false);
  });
});
