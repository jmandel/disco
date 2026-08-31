# SURFACE.md — the human surface review (BRIEF §6.4 gate 1)

Regenerated 2026-08-30 after P1/P2 (`until`, `fill`, timing). Three surfaces: the store schema (the query interface), the library, the CLI. Regenerate by hand from `schema.sql`, `src/client.ts`, `cli/disco.ts` HELP — this file must never drift from them.

## 1. Store schema (the query interface — GUIDANCE §6.2)

One SQLite per app (`apps/<product>/store/store.sqlite`), every row tagged by `run`. See [schema.sql](schema.sql) in full. Tables:
```
actions bodies console dialogs downloads events families frames mutations nav notes requests runs 
sentinels shots sse_events targets websockets ws_frames
(fts) bodies_fts ws_fts
```

## 2. Library surface (src/client.ts — `Session`)

```ts
  get store(): StoreReader
  async act(p: Omit<ActParams, "evaluateAfter" | "until"> & { evaluateAfter?: PageFn; until?: UntilOptions; expect?: (report: Report) => boolean }): Promise<Report & { surprise?: boolean }>
  click(target: string, o: ActOptions = {})
  rightclick(target: string, o: ActOptions = {})
  dblclick(target: string, o: ActOptions = {})
  hover(target: string, o: ActOptions = {})
  type(target: string, text: string, o: ActOptions = {})
  fill(target: string, text: string, o: ActOptions = {})
  press(key: string, o: ActOptions = {})
  scroll(o: ActOptions & { target?: string; deltaY?: number } = {})
  select(target: string, value: string, o: ActOptions = {})
  navigate(url: string, o: ActOptions = {})
  drag(target: string, to: string | { dx: number; dy: number }, o: ActOptions = {})
  awaitSettlement(o: { action?: string; budgetMs?: number; frame?: string } = {}): Promise<Report>
  watch(pred: Omit<WatchPred, "fn"> & { fn?: PageFn }, o: { budgetMs?: number; frame?: string } = {}): Promise<import("./report.ts").UntilResult>
  note(text: string, o: { kind?: "state" | "transition" | "ledger" | "note"; name?: string; action?: string; data?: unknown } = {})
  targets()
  info()
  screenshot(o: { targetId?: string } = {})
  families()
  idle(ms?: number)
  focusTarget(targetId: string)
  onEvent(fn: (ev: any) => void): Promise<() => void> { const off = this.rpc.onEvent(fn); return this.rpc.call("subscribe").then(() => off); }
  end()
  close() { this.rpc.close(); this._store?.close(); }
```

Options: `ActOptions = { frame?, targetId?, budgetMs?, quietMs?, noEffectMs?, maxBudgetMs?, evaluateAfter?, evaluateAfterArg?, world?, until?, expect? }`;
`until = { selector?, visible?, fn?, fnArg?, urlLike?, landed?, budgetMs?, tailMs?, frame? }` (the postcondition — DECISIONS #35, #38); `expect` never waits (client-side ledger flag).
Report: `{ action, kind, verdict, target?, settle?, until?, timing?, ui?, wire?, console?, env, evaluateAfter?, shots, aria, cursor, diagnosis?, extended? }` — shapes in README "Report & watch shapes".

Store readers (src/store.ts — `openStore(dir)` / `openApp(product)`): sql, one, body/bodyBytes/json (hash or 16-char prefix), blobPath, requests, appearances, timeline, screenshotAt, action, frames, diffTrace, runs — each documented with its SQL/TS desugaring in the source and README.

Layer 1 (`lib/`): `nav.ts` — `until(s, pred, {budgetMs, frame, msg})`, `reached(report)`, `assertVisible(s, sel, msg?, {frame, budgetMs})`, `actIfPresent(s, sel, {budgetMs, frame})`, `waitForFrame(s, urlLike, budgetMs)`, `diagnosisLine(dg)`; `wire.ts` — `extractFromWire(store, {urlLike, as, which, optional, actionId})`, `wireHas(store, urlLike)`.

## 3. CLI tree (`disco help`)

```
disco — discovery daemon CLI

session new <product> (--attach <port> [--host h] | --launch [--headless] [--url u]) [--scope <substr|/re/>] [--run name] [--dialogs accept|dismiss] [--no-idle] [--idle-ms N] [--fg]
session end [product]         end current run; next 'session new' starts another
session ls | info             list apps (runs per app) / current run info
targets                       scoped targets + frames
tail [--from seq]             stream digested events as JSONL (Ctrl-C to stop)
sql [<product>] <query> [--json]  query one app whole history (all runs, tagged by run); read-only
note "<text>" [--kind state|transition|ledger|note] [--name n] [--action act:N] [--data json]
families [--mark-read F] [--ambient F] [--not-ambient F]
idle [ms]                     idle-observe to warm the ambient classifier
screenshot [--out file.jpg]   capture now; prints the blob hash
blob <hash> [--out file]      copy a blob out / print text
eval "<fn source>" [--frame f] [--world main] [--args json]   run an in-page function, e.g. "() => document.title"
cdp <Method> [json params] [--target id | --browser]
act <kind> [target] [--frame f] [--budget ms] [--eval "fn"] [--until sel|--until-fn "fn"|--until-url part] [--until-budget ms] [--json]
                              kind: click|rightclick|dblclick|middleclick|hover|type(--text)|fill(--text, replaces)|press(key)|scroll|select(--value)|navigate(url)|drag(--to|--to-dx/--to-dy)
settle [--action act:N] [--budget ms]   re-arm / extend settlement without acting
watch <selector> [--visible] | --url-like part [--landed] | --fn "fn" [--fn-arg json] [--budget ms]   evidence-driven wait; diagnosis on expiry
Select an app via --app <product> (or --session / DISCO_APP / the current app). One home per app: apps/<product>/ (committed pack) + apps/<product>/store/ (gitignored history: one run-tagged SQLite + blobs + stream.jsonl).
```

## Report digest (GUIDANCE §4.3) — real digests for every verdict path: run `bun demos/03-two-questions.ts` (executed by `test/gauntlet/demos.test.ts`); shapes in README ("Report & watch shapes").
