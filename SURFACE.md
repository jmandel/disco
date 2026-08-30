# SURFACE.md — the human surface review (BRIEF §6.4 gate 1)

Generated 2026-08-30 after Slices 0–7 + Fable milestone review. Three surfaces: the store schema (the query interface), the library, the CLI.

## 1. Store schema (the query interface — GUIDANCE §6.2)

See [schema.sql](schema.sql) in full. Tables:
```
memory
actions              bodies_fts_idx   frames      session      ws_fts
bodies               console          mutations   shots        ws_fts_config
bodies_fts           dialogs          nav         sse_events   ws_fts_data
bodies_fts_config    downloads        notes       targets      ws_fts_docsize
bodies_fts_data      events           requests    websockets   ws_fts_idx
bodies_fts_docsize   families         sentinels   ws_frames
```

## 2. Library surface (src/client.ts — `Session`)

```ts
get store(): StoreReader { return (this._store ??= openStore(this.dir)); }
async act(p: Omit<ActParams, "evaluateAfter"> & { evaluateAfter?: PageFn; expect?: (report: Report) => boolean }): Promise<Report & { surprise?: boolean }>
click(target: string, o: ActOptions = {}) { return this.act({ kind: "click", target, ...o }); }
rightclick(target: string, o: ActOptions = {}) { return this.act({ kind: "rightclick", target, ...o }); }
dblclick(target: string, o: ActOptions = {}) { return this.act({ kind: "dblclick", target, ...o }); }
hover(target: string, o: ActOptions = {}) { return this.act({ kind: "hover", target, ...o }); }
type(target: string, text: string, o: ActOptions = {}) { return this.act({ kind: "type", target, text, ...o }); }
press(key: string, o: ActOptions = {}) { return this.act({ kind: "press", key, ...o }); }
scroll(o: ActOptions & { target?: string; deltaY?: number } = {}) { return this.act({ kind: "scroll", ...o }); }
select(target: string, value: string, o: ActOptions = {}) { return this.act({ kind: "select", target, value, ...o }); }
navigate(url: string, o: ActOptions = {}) { return this.act({ kind: "navigate", url, ...o }); }
drag(target: string, to: string | { dx: number; dy: number }, o: ActOptions = {})
awaitSettlement(o: { action?: string; budgetMs?: number; frame?: string } = {}): Promise<Report> { return this.rpc.call("settle", o, (o.budgetMs ?? 30000) + 30000); }
watch(pred: { selector?: string; fn?: PageFn; urlLike?: string }, o: { budgetMs?: number; frame?: string } = {})
note(text: string, o: { kind?: "state" | "transition" | "ledger" | "note"; name?: string; action?: string; data?: unknown } = {}) { return this.rpc.call("note", { text, ...o }); }
targets() { return this.rpc.call("targets"); }
info() { return this.rpc.call("session.info"); }
screenshot(o: { targetId?: string } = {}) { return this.rpc.call("screenshot", o); }
families() { return this.rpc.call("families"); }
idle(ms?: number) { return this.rpc.call("idle", { ms }, (ms ?? 30000) + 10000); }
focusTarget(targetId: string) { return this.rpc.call("focus", { targetId }); }
onEvent(fn: (ev: any) => void): Promise<() => void> { const off = this.rpc.onEvent(fn); return this.rpc.call("subscribe").then(() => off); }
end() { return this.rpc.call("session.end"); }
close() { this.rpc.close(); this._store?.close(); }
```

Store readers (src/store.ts — `openStore(dir)`): sql, one, body/bodyBytes/json (hash or 16-char prefix), blobPath, requests, appearances, timeline, screenshotAt, action, frames, diffTrace — each documented with its SQL/TS desugaring in the source and README.

## 3. CLI tree (`disco help`)

```
disco — discovery daemon CLI

session new <name> (--attach <port> [--host h] | --launch [--headless] [--url u]) [--scope <substr|/re/>] [--dialogs accept|dismiss] [--no-idle] [--idle-ms N] [--fg]
session end [name]            stop the daemon (store stays)
session ls | info             list sessions / show current session info
targets                       scoped targets + frames
tail [--from seq]             stream digested events as JSONL (Ctrl-C to stop)
sql "<query>" [--json]        query the store directly (read-only; works with the daemon down)
note "<text>" [--kind state|transition|ledger|note] [--name n] [--action act:N] [--data json]
families [--mark-read F] [--ambient F] [--not-ambient F]
idle [ms]                     idle-observe to warm the ambient classifier
screenshot [--out file.jpg]   capture now; prints the blob hash
blob <hash> [--out file]      copy a blob out / print text
eval "<fn source>" [--frame f] [--world main] [--args json]   run an in-page function, e.g. "() => document.title"
cdp <Method> [json params] [--target id | --browser]
act ... settle ... watch ...  (Slice 2)
All session-selecting commands accept --session <name|dir> or DISCO_SESSION; sessions live in --dir / DISCO_SESSIONS_DIR / ./sessions.
```

## Report digest (GUIDANCE §4.3) — one no-op and one network-bound example live in demos/02-agent-drive.md; shape documented in README ("Report & watch shapes").
