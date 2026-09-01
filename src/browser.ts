// The browser: either one we launch (Chromium with a debugging port, detached so it outlives the CLI
// process) or one already running that we attach to. Both are reached the same way: Playwright's
// connectOverCDP. `browser.json` in the app's store dir remembers how to reconnect.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

export interface BrowserInfo {
  mode: "launch" | "attach";
  endpoint: string;          // http://127.0.0.1:PORT or a ws:// URL — what connectOverCDP gets
  port?: number;
  pid?: number;              // only when launched by us
  startedWall: string;
  recorderPid?: number;      // a detached recorder process capturing everything until `close`
  pageTarget?: string;       // CDP target id of the page `open` drove first — later sessions prefer it over popups
}

export function pidAlive(pid: number | undefined): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

export function chromiumPath(): string {
  const env = process.env.DISCO_CHROMIUM; if (env) return env;
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) if (existsSync(p)) return p;
  throw new Error("no Chromium found — set DISCO_CHROMIUM=/path/to/chrome");
}

export function readBrowserInfo(storeDir: string): BrowserInfo | null {
  const p = join(storeDir, "browser.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
export function writeBrowserInfo(storeDir: string, info: BrowserInfo | null): void {
  const p = join(storeDir, "browser.json");
  if (!info) { if (existsSync(p)) rmSync(p); return; }
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(p, JSON.stringify(info, null, 2));
}

/** Is a CDP endpoint answering? (http endpoints only; ws endpoints are assumed alive.) */
export async function isAlive(endpoint: string): Promise<boolean> {
  if (!endpoint.startsWith("http")) return true;
  try {
    const r = await fetch(endpoint.replace(/\/$/, "") + "/json/version", { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

/** Launch Chromium detached with a fresh or reused profile under the store dir. Returns once the debugging port is known. */
export async function launchChromium(storeDir: string, opts: { headed?: boolean; profile?: string } = {}): Promise<BrowserInfo> {
  const profile = opts.profile ?? join(storeDir, "profile");
  mkdirSync(profile, { recursive: true });
  const logPath = join(storeDir, "chromium.log");
  writeFileSync(logPath, "");
  const fd = openSync(logPath, "a");
  const args = [
    "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--window-size=1280,900", ...(opts.headed ? [] : ["--headless=new"]), "about:blank",
  ];
  const child = spawn(chromiumPath(), args, { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const log = readFileSync(logPath, "utf8");
    const m = log.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/\S+)/);
    if (m) {
      const info: BrowserInfo = { mode: "launch", endpoint: `http://127.0.0.1:${m[2]}`, port: Number(m[2]), pid: child.pid!, startedWall: new Date().toISOString() };
      writeBrowserInfo(storeDir, info);
      return info;
    }
    if (child.exitCode !== null) throw new Error(`chromium exited (${child.exitCode}); see ${logPath}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`chromium did not report a DevTools port within 15s; see ${logPath}`);
}

/** Normalize a user-supplied attach target: a port, host:port, http://…, or ws://… */
export function attachEndpoint(x: string | number): string {
  const s = String(x);
  if (/^\d+$/.test(s)) return `http://127.0.0.1:${s}`;
  if (/^[\w.-]+:\d+$/.test(s)) return `http://${s}`;
  return s;
}

export async function connect(info: BrowserInfo): Promise<Browser> {
  return chromium.connectOverCDP(info.endpoint, { timeout: 10000 });
}

export function killLaunched(info: BrowserInfo | null): void {
  if (info?.mode === "launch" && info.pid) { try { process.kill(info.pid); } catch {} }
}
