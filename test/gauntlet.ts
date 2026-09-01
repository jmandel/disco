// Starts the gauntlet (a Bun process) on a random port and exposes its control plane over HTTP.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface GauntletHandle {
  origin: string; xOrigin: string;
  ctl: { get(): Promise<any>; set(patch: Record<string, unknown>): Promise<void>; reset(): Promise<void> };
  stop(): void;
}

export async function startGauntlet(): Promise<GauntletHandle> {
  const root = join(import.meta.dirname, "..");
  const child: ChildProcess = spawn("bun", [join(root, "gauntlet/server.ts"), "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const origins = await new Promise<{ origin: string; xOrigin: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gauntlet did not start: " + out)), 15000);
    child.stdout!.on("data", (d) => {
      out += String(d);
      const m = out.match(/main origin: (\S+)[\s\S]*x-origin:\s+(\S+)/);
      if (m) { clearTimeout(timer); resolve({ origin: m[1], xOrigin: m[2] }); }
    });
    child.stderr!.on("data", (d) => { out += String(d); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`gauntlet exited ${code}: ${out}`)); });
  });
  const ctlUrl = origins.origin + "/ctl";
  return {
    ...origins,
    ctl: {
      get: async () => (await fetch(ctlUrl)).json(),
      set: async (patch) => { await fetch(ctlUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }); },
      reset: async () => { await fetch(ctlUrl + "/reset", { method: "POST" }); },
    },
    stop: () => { try { child.kill(); } catch {} },
  };
}
