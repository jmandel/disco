// Test harness: gauntlet + headless Chromium + in-process daemon. Never uses /tmp (scratch lives under the repo's .scratch/).
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startGauntlet } from "../gauntlet/server.ts";
import { launchChromium, type Launched } from "../src/launch.ts";
import { Daemon } from "../src/daemon.ts";
import { openStore } from "../src/store.ts";

export const SCRATCH = join(import.meta.dir, "..", ".scratch");
let n = 0;

export interface Env {
  gauntlet: Awaited<ReturnType<typeof startGauntlet>>;
  browser: Launched;
  daemon: Daemon;
  dir: string;
  /** Open a new tab to a gauntlet path and wait for load. Returns the target id. */
  open(path: string): Promise<string>;
  /** Raw CDP evaluate in a page's main world (drives the gauntlet without the act() machinery). */
  evalIn(targetId: string, expression: string): Promise<any>;
  /** Wait (event-driven) until a predicate over the daemon's events holds, or a budget expires. */
  waitFor(pred: (ev: any) => boolean, budgetMs?: number): Promise<any>;
  store(): ReturnType<typeof openStore>;
  stop(): Promise<void>;
}

export async function startEnv(opts: { scope?: string; headless?: boolean; name?: string; dialogPolicy?: "accept" | "dismiss" } = {}): Promise<Env> {
  const id = `${Date.now().toString(36)}-${n++}`;
  const base = join(SCRATCH, "test", id);
  mkdirSync(base, { recursive: true });
  const gauntlet = await startGauntlet({ port: 0 });
  const browser = await launchChromium({ headless: opts.headless ?? true, userDataDir: join(base, "profile") });
  const dir = join(base, "session");
  const daemon = await Daemon.start({ dir, name: opts.name ?? `test-${id}`, mode: "attach", port: browser.port, scope: opts.scope ?? `localhost:${gauntlet.port}`, dialogPolicy: opts.dialogPolicy });
  const env: Env = {
    gauntlet, browser, daemon, dir,
    async open(path) {
      const url = path.startsWith("http") ? path : gauntlet.origin + path;
      const { targetId } = await daemon.cdp.send("Target.createTarget", { url });
      // Wait until THIS target is loaded and its observer is live (poll is fine in a test helper).
      const t0 = Date.now();
      for (;;) {
        const t = daemon.targets.get(targetId);
        const fr = t?.mainFrameId ? daemon.frames.get(t.mainFrameId) : null;
        if (fr?.observerReady) {
          const ready = await daemon.callInFrame(fr, "function(){ return document.readyState; }", [], "main").catch(() => null);
          if (ready?.value === "complete") break;
        }
        if (Date.now() - t0 > 20000) throw new Error(`open(${path}): target not ready in 20s`);
        await sleep(100);
      }
      return targetId;
    },
    async evalIn(targetId, expression) {
      const t = daemon.targets.get(targetId); if (!t) throw new Error("unknown target");
      const r = await daemon.send(t, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    waitFor(pred, budgetMs = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(`waitFor: budget ${budgetMs}ms expired`)); }, budgetMs);
        const off = daemon.listen((ev) => { if (pred(ev)) { clearTimeout(timer); off(); resolve(ev); } });
      });
    },
    store() { return openStore(dir); },
    async stop() {
      await daemon.stop().catch(() => {});
      await browser.kill();
      await gauntlet.stop();
      if (!process.env.DISCO_KEEP_SCRATCH) { try { rmSync(join(base, "profile"), { recursive: true, force: true }); } catch {} }
    },
  };
  return env;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
