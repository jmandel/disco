# Build Brief: Discovery Daemon & Framework

**Status:** v0.1 — companion to `ui-discovery-guidance.md` (read that first; it is the constitution, this is the construction plan)
**Audience:** the frontier agent (Claude Code / Codex CLI / similar) executing the build in a local loop, and the human supervising it
**Prime directive:** build the smallest system that fully honors the guidance doc, prove every timing and observation claim with executable tests, and log every divergence from the guidance rather than silently drifting.

---

## 0. How to use this document

Work in the vertical slices of §4, in order. Each slice ends in a **runnable demo** and a **green acceptance suite** — never move on with either missing. At each slice boundary, re-read the guidance doc and audit what you built against it (§6.3). When this brief and the guidance doc conflict, the guidance doc wins and the conflict goes in `DECISIONS.md`. When something is unspecified, apply the standing rule — **simple and powerful beats over-engineered** — make the direct choice, and log it.

Things you do not build, ever, without an explicit human decision: plugin systems, DI containers, config-file layers, event-bus abstractions, worker pools, sandboxes for trusted code, versioning/migration machinery, any agent-loop infrastructure. If you feel one of these becoming "necessary," stop and write down why in `DECISIONS.md` as an open question instead.

## 1. Settled decisions (do not relitigate)

These are pre-decided so the loop doesn't burn time or drift on them. Each is the simple choice on purpose.

1. **Runtime & repo:** Bun + TypeScript, one repo, workspaces only if genuinely needed (start without). `bun test` for everything. No build step beyond what Bun does natively. Strict TS, but don't fight the checker with ceremony — `unknown` + narrowing over elaborate generics.
2. **CDP client:** speak raw CDP over WebSocket with a thin hand-rolled client (connect, send with id, await response, dispatch events, session routing for flattened `Target.setAutoAttach`). No `chrome-remote-interface`, no Puppeteer, no Playwright in the daemon core. Type the messages you actually use (generate or hand-write a minimal `protocol.ts`); do not import the full protocol types package unless it's zero-friction.
3. **Daemon ⇄ client transport:** Unix domain socket at a well-known path per session (e.g. `$SESSION_DIR/daemon.sock`), newline-delimited JSON-RPC 2.0, hand-rolled framing (~50 lines). Streams (tail) are a subscription over the same socket. No HTTP server, no gRPC, no message broker.
4. **Agent-supplied functions:** shipped as **source strings**, evaluated in the daemon via dynamic import of a temp module (preferred, gets TS via Bun) or `new Function` for tiny lambdas. In-page functions go through `Runtime.evaluate`/`callFunctionOn` as stringified functions. Everything is trusted local code: **no sandboxing, no capability layer, no serialization cleverness.** Document loudly in the library README that closures don't transfer — functions must be self-contained, receiving `(ctx)` with everything they need.
5. **Store:** one SQLite DB per session (WAL mode) + content-addressed blob dir (`blobs/ab/cdef…`, SHA-256, first-2-hex sharding). Schema lives in a checked-in `schema.sql`, applied at session create, and **evolves freely as hand-driving experience demands** (see §6.4 — constraints and aesthetics are fixed, the blueprint is not); FTS5 external-content tables for textual bodies and WS frames, populated at capture time. Writers: the daemon only. Readers: anyone, directly. No ORM, no query builder — string SQL with a tiny typed helper at most.
6. **Direct store access is a feature, not a backdoor:** agent scripts open the SQLite DB in-process with `bun:sqlite` for pure store queries (no daemon round trip); the daemon is only required for live-page interaction and for blob-writing.
7. **Screencast:** `Page.startScreencast` (JPEG, quality ≈ 50, capped dimensions ≈ 1280 wide), ack every frame, hash-dedup before persisting. If it proves heavy in attach mode against a human's desktop browser, the sanctioned fallback is on-event + interval screenshots (`Page.captureScreenshot` on mutation/sentinel/interval) — implement the fallback as a mode switch, not an abstraction layer.
8. **Selector engine:** Phase 1 (through slice 5): CSS selectors + a small text/role resolver built on `DOMSnapshot`/accessibility tree — enough for the gauntlet and early dogfooding. Phase 2 (slice 7): attempt to vendor Playwright's `injected` script source for full `getByRole`/`getByText`/piercing semantics; if vendoring under Bun is not clean within a bounded effort (~a day of loop time), fall back to `playwright-core` `connectOverCDP` in parallel *for element resolution only* (resolve → backend node id → our CDP input dispatch), and log the choice. Do not hand-reimplement Playwright's semantics.
9. **Input dispatch:** CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent` with correct event sequences (move → down → up for click; proper `text`/`key`/`code` for typing). Crib sequencing details from Playwright's source where needed. Always scroll the target into view and verify hit-test point lands on it (or an acceptable descendant) before dispatching; report occlusion instead of clicking through it.
10. **Clocks:** one monotonic clock (daemon `performance.now()` mapped to an epoch anchor recorded in the manifest). Every stored event carries `t_mono` and derived wall time. CDP timestamps are mapped into this clock at ingest.
11. **IDs:** actions get `act:<n>` (per-session counter), events get a monotonic `seq`, blobs are their hash. Handles in reports are these IDs verbatim. No UUIDs anywhere they aren't needed.
12. **Session layout:** `sessions/<name>/` containing `manifest.json`, `store.sqlite`, `blobs/`, `daemon.sock`, `daemon.log`, `stream.jsonl` (the tail, also persisted). The CLI's `disco session new|attach|end` manages lifecycle.
13. **Ambient classifier v1:** periodicity + independence heuristics only — a request family (same method+host+path-shape) seen ≥3 times with regular cadence and occurrences outside any causality window is ambient; classification is recorded per-family with evidence and is *reversible* (attribution stores its confidence tag, and reports note when ambient-classified traffic occurred inside a window). Content-based fallback for "results delivered over the standing channel" is an open question for dogfooding, not v1 code.
14. **Defaults:** quiescence window Q = 300ms; no-effect tier = 500ms; default settlement budget = 3000ms; screencast target ≈ 3 fps equivalent post-dedup; report digest budget ≈ 300 tokens. All defaults live in one `defaults.ts` with a comment pointing at the tuning task in §5 — tune from gauntlet + dogfood measurements, not taste.

## 2. Repository shape

```
disco/
  README.md                  — quickstart: 10 lines to a first observed click
  GUIDANCE.md                — the guidance doc, checked in verbatim
  BRIEF.md                   — this document
  STATE.md                   — loop memory: done / next / how-to-run (§6.1)
  DECISIONS.md               — divergence & decision log (§6.2)
  schema.sql                 — the store schema; source of truth, freely evolving (§6.4)
  defaults.ts
  src/
    cdp.ts                   — CDP client (connect, sessions, typed send)
    daemon.ts                — lifecycle, RPC server, target auto-attach
    instrument/              — network, ws, console, dialogs, screencast, mutations
    settle.ts                — settlement race
    attribute.ts             — causality windows + ambient classifier
    act.ts                   — resolve → snapshot → dispatch → settle → report
    sentinels.ts
    report.ts                — digest construction
    store.ts                 — writers (daemon-side) + `store.*` readers (client-side)
    selectors.ts             — phase-1 resolver; phase-2 vendored engine
    client.ts                — the agent-facing library (`session.*`)
  cli/
    disco.ts                 — thin command surface incl. `sql`, `eval`, `tail`
  gauntlet/
    app/                     — the nasty test SPA (§3)
    server.ts
    scenarios.md             — what each control knob does
  test/
    unit/                    — settle logic, attribution, store, framing (fake clocks)
    gauntlet/                — end-to-end acceptance suites per slice (§4)
```

Flat is fine; only add depth when a directory exceeds ~10 files. Comments explain *why*; the guidance doc is cited by section (`// see GUIDANCE §4.2`) at every load-bearing behavior.

## 3. Milestone 0 — the gauntlet

A single-page app + Bun server, deliberately hostile, fully deterministic, controlled by URL/query params and a `/ctl` endpoint so tests can arrange any condition. **Every behavior below exists to make one claim in the guidance doc testable.** No framework needed — vanilla TS or Preact, whatever is fastest to write; ugly is fine.

Required behaviors (each with the guidance claim it exercises):

1. **`/api/slow?ms=N`** — configurable-latency JSON endpoint; a "Load Chart" button fires 3 requests incl. one slow one → settlement stays open while attributed requests fly, closes ~Q after the last (G§4.2).
2. **Conditional modal** — `?modal=1` (or ctl-set "record state") makes opening a record show a dialog; otherwise not → sentinel detection, variability ledger workflow, optional-interstitial handling (G§5.3, §7.5).
3. **Toast** — after "Save," a 2s transient toast, sometimes reporting an async *failure* while the UI looks fine → screencast/sentinel capture of transients; optimistic-UI wire-truth check (G§8).
4. **Perpetual spinner** — a region that animates forever → visual-quiescence ignore-region fingerprinting (G§4.2).
5. **Heartbeat + poll** — a 5s interval beacon and a long-poll that reissues on return → ambient classification; these must never hold settlement open (G§4.4).
6. **Unsolicited WebSocket** — echoes actions and also pushes spontaneous frames → WS capture both directions; between-action observation (G§3.4).
7. **Debounced search input** — per-keystroke XHRs with 250ms debounce → typing settlement waits for the trailing request (G§8).
8. **Virtualized list** — 10k rows, windowed rendering, while `/api/rows` returned everything → "the wire had it all along" extraction demo (G§2.3).
9. **Re-render race button** — clicking triggers an immediate re-render that replaces the button node → resolve-late/re-resolve-once behavior (G§8).
10. **Iframe island** — a nested (same-origin, then cross-origin via second port) iframe containing a form → multi-target/frame instrumentation and frame-scoped selectors (G§3.2).
11. **`beforeunload` trap + native `confirm`** — → dialog policy: auto-handled per session policy, always recorded (G§3.4).
12. **Session-timeout modal** — appears after ctl-armed idle N seconds → session-expiry sentinel (G§5.3).
13. **No-op button** — does nothing at all → fast `no-effect` verdict (G§4.2).
14. **Write endpoints** — a `POST /api/save` and a `DELETE` → write-flag surfacing in reports (G§2.6).
15. **New-window opener** — opens a child window with its own page → target auto-attach (G§3.2).

Acceptance for milestone 0: gauntlet runs with `bun gauntlet`, every behavior manually verifiable in a browser, `scenarios.md` documents each knob. The gauntlet is also the demo sandbox for every subsequent slice.

## 4. Vertical slices

Each slice = implementation + acceptance tests (in `test/gauntlet/`) + a demo script or README section showing a human how to see it work + a `STATE.md` update. Timing assertions use generous-but-real bounds and should run against the local gauntlet where timing is controllable; mark them so they can be loosened on slow CI later, but they run locally by default.

### Slice 1 — Attach + store + always-on instrumentation
Daemon connects to a running Chromium (`--remote-debugging-port`), auto-attaches all targets/frames, and records to the store: requests/responses with eagerly-fetched bodies (size-capped with truncation markers), WS lifecycle + frames, console, dialogs (recorded; policy handling can stub to "auto-dismiss + record" for now), navigation/frame events, downloads, screencast frames (deduped). `disco session new/end`, `disco tail`, `disco sql`. FTS populated at capture.

*Acceptance:* drive the gauntlet **by hand** in the browser while the daemon watches; then, with the daemon stopped, answer via `sqlite3` alone: every request the page made with status+size; the full body of the virtualized-list response; "did the string `Zebra-Row-9741` ever appear anywhere" (FTS hit in a body, even though it was never rendered); the screenshot nearest the moment the toast was visible; every WS frame in order. A spontaneous WS push and the heartbeat both appear with correct timestamps. **This slice is independently useful: from here on, real hand-driven discovery sessions are already possible (G§7 note).**

*Demo:* `demos/01-hand-drive.md` — a 5-minute script a human follows.

### Slice 2 — `act()` + settlement
Phase-1 selectors, input dispatch, pre/post snapshots, the settlement race (network-scoped stub: window-based attribution only for now), UI delta digest, report construction, `awaitSettlement`, `watch()` with diagnosis-on-expiry.

*Acceptance (the timing suite — the point of the whole system):*
- No-op button → verdict `no-effect`, report delivered < 800ms wall (target 600; assert 800 for slop).
- `slow?ms=4000` chart load → `settled:network`, report within `4000 + Q + 500ms`; same test at `ms=400` settles proportionally — **no fixed sleeps anywhere in the pass path.**
- Missing selector → immediate diagnosis (< 500ms) containing fuzzy near-matches, dialog census, pending-request count; **never** a bare 30s timeout.
- Re-render race button → click lands (re-resolve-once path), report notes the detachment.
- Debounced input: `type()` settlement includes the trailing XHR.
- Occluded target → occlusion reported, no blind click-through.
- `watch()` for a selector that never comes, budget 1500ms → diagnosis, and elapsed < 1700ms.

### Slice 3 — Attribution + ambient classifier
Initiator-stack attribution, causality windows, redirect/dependency chaining, confidence tags; periodicity-based ambient classification with evidence records; settlement's network detector now uses attributed-only scoping.

*Acceptance:* heartbeat + long-poll never hold settlement open (chart load at `ms=4000` still settles at ~4.3s with heartbeats firing throughout); the 3 chart requests attribute with `stack` or `window` confidence; a spontaneous WS push during an unrelated action shows up as *non-attributed activity in the window*; ambient families are queryable in the store with their evidence.

### Slice 4 — Sentinels + stream
Dialog/modal, toast, error, session-expiry, new-target sentinels; firings persisted, surfaced in next report's environment flags, and streamed; `disco tail` shows digested live events.

*Acceptance:* conditional modal fires the dialog sentinel with a screenshot handle *even when it appears 2s after settlement*; toast sentinel captures a frame while the toast is visible (assert the blob's timestamp falls in the toast's lifetime); ctl-armed timeout modal fires session-expiry; child window fires new-target and is instrumented (a request made in the child is in the store); an exception + a 500 fire the error sentinel.

### Slice 5 — Client library + CLI + in-daemon extraction
`session.*` surface finalized: `act`, `awaitSettlement`, `watch`, `evaluate`, `cdp.send`, `store.*` readers, sentinel subscription; `extract` functions as source strings executed against `(ctx)` with the report's data + live page access; canned helpers (`requests`, `appearances`, `timeline`, `screenshotAt`, `action`, `diffTrace`) each documented with their SQL/TS desugaring; CLI generated over the same RPC incl. `disco eval`.

*Acceptance:* a single `act()` with an `extract` returns the virtualized list's full 10k names reduced to a count + first/last, in one round trip; `diffTrace` of record-open with and without `?modal=1` reports the dialog + its requests as the structural difference; every helper's doc example runs verbatim; a script that *only* queries (no live page) runs with the daemon down.

### Slice 6 — Launch mode + hardening
Managed Chromium launch (headed + headless), storage-state save/restore, reconnect-on-daemon-restart against a still-running browser, dialog *policy* (per-session config for confirm/beforeunload), graceful multi-gigabyte-session behavior (blob dedup verified, DB size sane).

*Acceptance:* full slice-2/3/4 suites pass identically in launched-headless mode; kill and restart the daemon mid-session against the same browser and continue acting; a saved storage state restores an authenticated gauntlet variant.

### Slice 7 — Real selector engine
Per settled decision §1.8: vendor Playwright's injected script or fall back to `connectOverCDP` resolution. Either way the agent-facing selector language is Playwright's (`role=`, `text=`, `getByLabel`, frame-scoped, shadow-piercing).

*Acceptance:* role/text/label selectors resolve in main frame, nested iframe, and cross-origin iframe on the gauntlet; shadow-DOM element (add one to the gauntlet) resolves; phase-1 CSS path still works.

### Slice 8 — Methodology dry run (exit criterion for the build)
Not code: run a **full discovery session against the gauntlet as if it were an unknown EHR**, following the guidance doc's methodology (§7) end to end — contract, recon, state map, flow walks, variability ledger (the conditional modal must end up there with n and a hypothesis), artifacts (nav-and-quirks doc + at least three tested subtask scripts + ledger). The human reviews the artifacts, not the code.

*Acceptance:* the artifacts are good enough that a *fresh* agent session, given only the artifacts + library README, can execute "open a record and extract the row names via the wire" on the first try, defensively handling both modal states.

## 5. After the slices: dogfood against a real EHR

Schedule the first supervised real-EHR demo-environment session as soon as Slice 1 lands (hand-driven, trace-mining only) and a second after Slice 4. These are evals of the *vision*, and their outputs are work items:

- Measure real settle-time distributions and revisit every `defaults.ts` value with data.
- Test the ambient classifier against real heartbeat/token-refresh/long-poll traffic; decide whether the content-based attribution fallback (results over the standing channel, G§10) is needed.
- Judge report digests: are they the right ~300 tokens? What did the agent immediately drill into every time (promote it into the digest)? What was never read (demote it)?
- Measure screencast cost in attach mode on the human's actual machine; flip to fallback mode if needed.
- Keep a **friction log**; it feeds both code fixes and, verbatim, the "advice and quirks" content of the eventual skill.

## 6. Loop hygiene

### 6.1 `STATE.md`
Maintained continuously, structured as: *Done* (slices/tests green, one line each) / *In progress* (current task, current blocker) / *Next* / *How to run* (daemon, gauntlet, tests, demos — exact commands). Written for a cold-start agent with zero conversational context. Update before ending any session and after any milestone.

### 6.2 `DECISIONS.md`
Append-only log. Entry format: date, decision, alternatives considered (one line), why, and — crucially — **whether it diverges from GUIDANCE.md or BRIEF.md and where**. Silent divergence is the failure mode this file exists to prevent. Open questions live here too, tagged `OPEN`, reviewed at slice boundaries.

### 6.3 Slice-boundary audit
At each slice completion, before starting the next: re-read GUIDANCE.md in full; walk its claims against the code (especially §2 principles and §4.2 settlement semantics); fix or log every mismatch; re-read the §0 forbidden-abstractions list and delete anything that crept in; update README quickstart if the surface moved.

### 6.4 Human review gates and schema evolution
The schema and API surfaces are **designed from experience, not up front**: build Slice 1, hand-drive the gauntlet, feel where queries are awkward, and let that feedback shape `schema.sql` and `session.*` — within fixed constraints and aesthetics rather than a fixed blueprint. The constraints are the guidance doc's: queryability-first (generated columns for hot filters, FTS5 over textual content, JSON1 for summaries), digest+handles conventions, one monotonic clock, blobs by hash, no ORM/no versioning machinery. The aesthetics: short lowercase snake_case names, tables that read like the event stream they record, columns a fresh agent can guess from `.schema` alone, SQL for the common questions fitting on one line. Since there is no compat burden (GUIDANCE §6.2), reshaping the schema whenever experience argues for it is *expected* — do it freely, note significant reshapes in `DECISIONS.md` with the query pain that motivated them.

Human sign-off points:
1. **Surface review (end of Slice 1):** present `schema.sql`, the `session.*` type signatures so far, and the `disco --help` tree — now informed by real hand-driving. Twenty minutes of review here catches vision-drift at its cheapest point.
2. **Artifact gate (Slice 8):** the human reviews the dry-run artifacts.
Otherwise the loop runs autonomously, with the human sampling demos at will, and later schema reshapes need only the `DECISIONS.md` note, not re-review.

### 6.5 Test discipline
Timing tests assert generous-but-meaningful bounds and run by default. Unit-test the settlement race and attribution with **fake clocks and synthetic event streams** (they're pure logic; keep them pure) so the tricky cases — signal orderings, budget expiry, ambient interleavings — are exhaustively cheap; gauntlet tests then cover integration truth. A flaky test is a bug in the framework's determinism story: fix the framework, never retry-loop the test.

---

## Appendix: Definition of done, in one paragraph

The build is done when a human can start the daemon against a browser in one command; hand-drive or agent-drive an unknown app while everything lands queryably in SQLite + blobs; issue any action and receive, within a few hundred milliseconds of the true outcome, a ~300-token report that says what happened on screen and on the wire, why we believe it's finished, and what surprised us; ask arbitrary retrospective questions in plain SQL and TypeScript; be interrupted by nothing the sentinels didn't catch; and hand a fresh agent the dry-run artifacts and watch it drive the gauntlet defensively on the first attempt. Everything not needed for that paragraph is out of scope.
