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
