// Demo 3 — the two questions: act() answers "what did the app do?", until/watch answers "am I where I
// need to be?" (docs/using-disco.md "The two questions"). Self-contained: starts its own gauntlet + headless
// Chromium + daemon, runs the worked examples, prints the real report digests, tears down. Executed by
// test/gauntlet/demos.test.ts so the doc's examples cannot rot.   bun demos/03-two-questions.ts
import { mkdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { startGauntlet } from "../gauntlet/server.ts";
import { launchChromium } from "../src/launch.ts";
import { Daemon } from "../src/daemon.ts";
import { Session } from "../src/client.ts";
import { printReport } from "../cli/commands.ts";
import { actIfPresent, reached, until } from "../lib/nav.ts";

const base = join(import.meta.dir, "..", ".scratch", "demo3", Date.now().toString(36));
mkdirSync(base, { recursive: true });
const gauntlet = await startGauntlet({ port: 0 });
const browser = await launchChromium({ headless: true, userDataDir: join(base, "profile") });
const daemon = await Daemon.start({ dir: join(base, "session"), name: "demo3", product: "demo3", mode: "attach", port: browser.port, scope: `localhost:${gauntlet.port}` });
const h = (t: string) => console.log(`\n${"═".repeat(78)}\n${t}\n${"═".repeat(78)}`);
const show = (r: any) => printReport(r, {}, { out: console.log } as any);
const ctl = async (patch: any) => { gauntlet.ctl.set(patch); await new Promise((r) => setTimeout(r, 400)); };
let ok = true;
try {
  await daemon.cdp.send("Target.createTarget", { url: gauntlet.origin + "/" });
  const s = await Session.connect(join(base, "session"));
  await until(s, { selector: "#load-chart", visible: true }, { budgetMs: 15000 });
  await s.idle(2500); // let the ambient classifiers learn the page baseline

  h("1a. Q1 only — Load Chart with a 900ms render gap: settlement closes BEFORE the screen shows the result");
  await ctl({ slowMs: 100, renderDelayMs: 900 });
  const a = await s.click("#load-chart", { evaluateAfter: () => document.querySelector("#chart-status")?.textContent });
  show(a);
  console.log(`→ verdict says the page went quiet; evaluateAfter says the screen still reads ${JSON.stringify(a.evaluateAfter)}. Settled ≠ ready.`);
  ok &&= a.evaluateAfter === "loading…";
  await until(s, { fn: () => document.querySelector("#chart-status")?.textContent === "idle" });

  h("1b. Q1 + Q2 — the same click with `until`: the postcondition gates the return; the verdict is still reported");
  const b = await s.click("#load-chart", { until: { fn: () => document.querySelector("#chart-status")?.textContent === "idle" }, evaluateAfter: () => document.querySelector("#chart-status")?.textContent });
  show(b);
  console.log(`→ settled at ${b.settle!.ms}ms, postcondition at ${b.until!.elapsedMs}ms, screen reads ${JSON.stringify(b.evaluateAfter)}. Both signals, one report.`);
  ok &&= b.until!.matched && b.evaluateAfter === "idle";

  h("2. Optimistic UI — Save says \"Saved ✓\" on a 202; `until` the status request LANDS keeps it attributed");
  await ctl({ renderDelayMs: 0 });
  const c = await s.click("#save", { until: { urlLike: "/api/save/status", landed: true }, evaluateAfter: () => document.getElementById("save-state")?.textContent });
  show(c);
  const post = c.wire!.attributed.find((w) => w.m === "POST" && w.p === "/api/save");
  const status = c.wire!.attributed.find((w) => w.p.startsWith("/api/save/status"));
  console.log(`→ screen at return: ${JSON.stringify(c.evaluateAfter)}; wire: POST → ${post?.s} ${JSON.stringify(s.store.json(post!.body!))}, then GET status → ${status?.s} (${status?.a}). The wire is the truth.`);
  ok &&= post?.s === 202 && status?.s === 200 && status?.a === "window";

  h("3. The sometimes-modal — a delayed interstitial occludes the next click: diagnosis, not a timeout");
  await ctl({ modal: true, modalDelayMs: 400 });
  const d1 = reached(await s.click("#record-1", { until: { urlLike: "/api/record/1", landed: true } }), "open record 1");
  console.log(`opened record 1 (${d1.verdict}, until ${d1.until!.elapsedMs}ms); the modal arrives ~400ms later…`);
  await until(s, { selector: "#record-modal", visible: true });
  const d2 = await s.click("#record-2");
  show(d2);
  console.log(`→ ${d2.verdict}: ${d2.diagnosis?.reason} by ${d2.diagnosis?.occludedBy} — the report names the blocker; actIfPresent clears it and the step retries.`);
  ok &&= d2.verdict === "diagnosis" && d2.diagnosis?.reason === "occluded";
  await actIfPresent(s, "#modal-ack");
  await ctl({ modal: false });

  h("4. Postcondition NOT reached — the verdict explains why (here: nothing happened at all)");
  const e = await s.click("#noop", { until: { selector: "#never-exists", budgetMs: 800 } });
  show(e);
  console.log(`→ verdict ${e.verdict} + until unmatched: the click was swallowed / did nothing — don't retry blindly, read the diagnosis.`);
  ok &&= e.verdict === "no-effect" && e.until!.matched === false;

  h("5. Where the milliseconds went (report.timing) — responsiveness is measured, not assumed");
  console.log(JSON.stringify(e.timing));
  s.close();
} catch (err) { ok = false; console.error("demo threw:", (err as Error).message); }
finally { await daemon.stop().catch(() => {}); await browser.kill(); await gauntlet.stop(); rmSync(base, { recursive: true, force: true }); try { rmdirSync(join(base, "..")); } catch {} /* parent only if empty */ }
console.log(`\ndemo 3: ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
