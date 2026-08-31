// The unix-socket JSON-RPC framer (BRIEF §2 "framing"): newline-delimited, chunk-agnostic, UTF-8 safe.
import { describe, expect, test } from "bun:test";
import { framer } from "../../src/rpc.ts";

describe("rpc framer", () => {
  test("splits lines across chunks, joins partial lines, skips blank lines", () => {
    const lines: string[] = []; const feed = framer((l) => lines.push(l));
    feed('{"a":1}\n{"b":'); feed("2}\n\n  \n{\"c\":3}"); feed("\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
  test("a multi-byte UTF-8 sequence split across chunks decodes intact (streaming decoder)", () => {
    const lines: string[] = []; const feed = framer((l) => lines.push(l));
    const bytes = new TextEncoder().encode('{"s":"né"}\n'); // é = C3 A9
    const cut = bytes.indexOf(0xc3) + 1;
    feed(bytes.slice(0, cut)); feed(bytes.slice(cut));
    expect(lines).toEqual(['{"s":"né"}']);
  });
});

describe("rpc backpressure (DECISIONS #50)", () => {
  test("large results and large requests round-trip intact (partial socket writes are drained, not truncated)", async () => {
    const { serveRpc, RpcClient } = await import("../../src/rpc.ts");
    const { mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dir, "..", "..", ".scratch", "test", `rpcbp-${Date.now().toString(36)}`);
    mkdirSync(dir, { recursive: true });
    const sock = join(dir, "rpc.sock");
    const srv = serveRpc(sock, async (method, params: any) => {
      if (method === "big") return { items: Array.from({ length: params.n }, (_, i) => ({ i, s: "x".repeat(params.size) })) };
      if (method === "echoLen") return { len: JSON.stringify(params).length };
      return null;
    });
    const c = await RpcClient.connect(sock);
    try {
      for (const [n, size] of [[50, 10_000], [50, 100_000]] as const) {      // ~500KB and ~5MB responses
        const r = await c.call("big", { n, size }, 10000);
        expect(r.items.length).toBe(n);
        expect(r.items[n - 1].s.length).toBe(size);
      }
      const big = "y".repeat(2_000_000);                                      // ~2MB request
      const e = await c.call("echoLen", { big }, 10000);
      expect(e.len).toBeGreaterThan(2_000_000);
    } finally { c.close(); srv.stop(); rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
