// Relaunching into the SAME profile must connect to the NEW browser: the previous launch's "DevTools listening on …"
// line lingered in the profile's stderr log and the second launch parsed a dead port (stranger #2 friction #2).
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchChromium } from "../../src/launch.ts";
import { SCRATCH } from "../helpers.ts";

describe("launch", () => {
  test("a second launch into a reused profile reports its own live port", async () => {
    const dir = join(SCRATCH, "test", `relaunch-${Date.now().toString(36)}`, "profile");
    mkdirSync(dir, { recursive: true });
    const a = await launchChromium({ headless: true, userDataDir: dir });
    await a.kill();
    const b = await launchChromium({ headless: true, userDataDir: dir });
    try {
      const v = await fetch(`http://127.0.0.1:${b.port}/json/version`).then((r) => r.json() as Promise<any>);
      expect(String(v.webSocketDebuggerUrl)).toContain(`:${b.port}/`);
    } finally { await b.kill(); }
  }, 30000);
});

describe("session new --launch --url", () => {
  test("the document load is observed as act:1 (about:blank first, then navigate after attach)", async () => {
    const { startGauntlet } = await import("../../gauntlet/server.ts");
    const g = await startGauntlet({ port: 0 });
    const appsDir = join(SCRATCH, "test", `launchurl-${Date.now().toString(36)}`);
    mkdirSync(appsDir, { recursive: true });
    const env = { ...process.env, DISCO_APPS_DIR: appsDir };
    const cli = join(import.meta.dir, "..", "..", "cli", "disco.ts");
    try {
      const p = Bun.spawn(["bun", cli, "session", "new", "lu", "--launch", "--headless", "--url", g.origin + "/", "--scope", `localhost:${g.port}`, "--no-idle"], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); await p.exited;
      expect(err).toContain("act:1  navigate");
      expect(err).not.toContain("navigate failed");
      const q = Bun.spawnSync(["bun", cli, "sql", "lu", "SELECT path, attribution, action_id FROM requests WHERE path='/'", "--json"], { env });
      const rows = JSON.parse(q.stdout.toString());
      expect(rows.length).toBe(1);
      expect(rows[0].action_id).toBe("act:1");
      expect(out.length + err.length).toBeGreaterThan(0);
    } finally {
      Bun.spawnSync(["bun", cli, "session", "end", "lu"], { env });
      await g.stop();
    }
  }, 60000);
});
