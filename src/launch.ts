// Managed Chromium launch (GUIDANCE §3.2 launch mode). Used by the test harness from Slice 1 and by
// `disco session new --launch` (Slice 6). Parses the DevTools endpoint from stderr.
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Launched { proc: ReturnType<typeof Bun.spawn>; pid: number; port: number; wsUrl: string; userDataDir: string; kill(): Promise<void> }

export function findChromium(): string {
  for (const c of [process.env.DISCO_CHROMIUM, "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"]) {
    if (!c) continue;
    const p = Bun.which(c); if (p) return p;
    if (existsSync(c)) return c;
  }
  throw new Error("no Chromium found (set DISCO_CHROMIUM)");
}

export async function launchChromium(opts: { headless?: boolean; userDataDir: string; port?: number; args?: string[]; url?: string; windowSize?: string } = { userDataDir: "" }): Promise<Launched> {
  const exe = findChromium();
  mkdirSync(opts.userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${opts.port ?? 0}`, `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-features=Translate,OptimizationHints,MediaRouter", "--disable-search-engine-choice-screen", "--password-store=basic", "--use-mock-keychain",
    "--disable-popup-blocking", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-allow-origins=*", `--window-size=${opts.windowSize ?? "1200,900"}`,
    ...(opts.headless ? ["--headless=new", "--hide-scrollbars"] : []),
    ...(opts.args ?? []),
    opts.url ?? "about:blank",
  ];
  // Chromium's stderr goes to a FILE we poll for the DevTools line — never a pipe: a piped stderr kept the
  // launching process alive for the browser's lifetime (`disco session new --launch … | tail` hung until
  // `session end`; P4-A friction #4).
  mkdirSync(opts.userDataDir, { recursive: true });
  const errPath = join(opts.userDataDir, "chromium.stderr.log");
  const proc = Bun.spawn([exe, ...args], { stdout: "ignore", stderr: Bun.file(errPath), stdin: "ignore" });
  const wsUrl = await (async () => {
    const t0 = Date.now();
    for (;;) {
      const text = await Bun.file(errPath).text().catch(() => "");
      const m = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) return m[1];
      if (proc.exitCode !== null) throw new Error("Chromium exited before reporting DevTools endpoint: " + text.slice(-500));
      if (Date.now() - t0 > 20000) throw new Error("Chromium did not report a DevTools endpoint within 20s (see " + errPath + ")");
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const port = Number(new URL(wsUrl).port);
  return { proc, pid: proc.pid, port, wsUrl, userDataDir: opts.userDataDir, async kill() { try { proc.kill("SIGTERM"); } catch {} await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 3000))]); try { proc.kill("SIGKILL"); } catch {} } };
}

/** Read the port of a running managed browser from its profile dir (Chromium writes DevToolsActivePort). */
export function readActivePort(userDataDir: string): number | null {
  try { return Number(readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { return null; }
}
