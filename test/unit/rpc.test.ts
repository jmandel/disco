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
