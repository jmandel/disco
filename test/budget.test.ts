// The BUDGET. This test is the whole governance of v4's surface: the counts below may only change together
// with a DECISIONS.md line, and adding one thing means deleting one thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("module exports: open and reached, nothing else", async () => {
  const mod: Record<string, unknown> = await import("../src/index.ts");
  assert.deepEqual(Object.keys(mod).sort(), ["open", "reached"]);
});

test("Session methods: act, body, close, json, look, sql, waitFor — nothing else public", async () => {
  const { Session } = await import("../src/session.ts");
  const methods = Object.getOwnPropertyNames(Session.prototype).filter((n) => n !== "constructor").sort();
  assert.deepEqual(methods, ["act", "body", "close", "json", "look", "sql", "waitFor"]);
});

test("act options: until, quiet, max — nothing else", () => {
  const src = read("src/session.ts");
  const m = src.match(/export interface ActOptions \{([\s\S]*?)\n\}/);
  assert.ok(m, "ActOptions interface not found");
  const keys = [...m![1].matchAll(/^\s*([a-zA-Z]+)\??:/gm)].map((x) => x[1]).sort();
  assert.deepEqual(keys, ["max", "quiet", "until"]);
});

test("CLI commands: open, close, look, act, sql — nothing else", () => {
  const src = read("cli/disco.ts");
  const cases = [...src.matchAll(/^\s*case "([a-z][a-z-]*)":/gm)].map((x) => x[1]);
  assert.deepEqual([...new Set(cases)].sort(), ["act", "close", "look", "open", "sql"]);
});

test("README: at most 300 lines; the method is one paragraph", () => {
  const lines = read("README.md").split("\n");
  assert.ok(lines.length <= 300, `README.md is ${lines.length} lines`);
  const start = lines.findIndex((l) => /^## Method\b/.test(l));
  assert.ok(start >= 0, "README.md has no '## Method' section");
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) body.push(lines[i]);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1)!.trim()) body.pop();
  assert.ok(body.length > 0, "the method is empty");
  assert.ok(!body.some((l) => !l.trim()), "the method must be a single paragraph (no blank line inside it)");
});

test("a pack is README.md + sdk.ts or sdk/ (+ store/, evidence/) — nothing else", () => {
  const apps = join(root, "apps");
  if (!existsSync(apps)) return;
  for (const app of readdirSync(apps)) {
    const d = join(apps, app);
    if (!statSync(d).isDirectory()) continue;
    const extra = readdirSync(d).filter((f) => !["README.md", "sdk.ts", "sdk", "store", "evidence"].includes(f));
    assert.deepEqual(extra, [], `apps/${app} has files outside the pack convention: ${extra.join(", ")}`);
    if (existsSync(join(d, "sdk"))) assert.ok(existsSync(join(d, "sdk", "index.ts")), `apps/${app}/sdk/ has no index.ts entry`);
  }
});
