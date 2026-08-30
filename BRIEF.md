# Build Brief: Discovery Daemon & Framework

**Status:** v0.2 — companion to `GUIDANCE.md` (read that first; it is the constitution, this is the construction plan). Revised 2026-08-30 per `REVIEW.md`: settled decisions §1.4/1.5/1.7/1.8/1.9/1.10/1.13 restated, §1.15–1.19 added, gauntlet behaviors 16–22 added with ambient traffic off by default, slices re-sequenced (selector engine vendored in Slice 2; Slice 7 becomes frame/shadow acceptance). Every change has a `DECISIONS.md` entry.
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
4. **Agent-supplied functions run in-page only.** The only functions shipped over the socket are *in-page* functions (`session.evaluate(fn)`, `act(..., {evaluateAfter: fn})`, `watch(fn)`), sent as stringified source and run via `Runtime.callFunctionOn` in the target frame's isolated world (or main world on request). There is **no daemon-side function execution**: reduction over captured data happens in the agent's own Bun process against the store (GUIDANCE §2.5). Everything is trusted local code: **no sandboxing, no capability layer, no serialization cleverness.** Document loudly in the library README that closures don't transfer — in-page functions must be self-contained, receiving `(element, arg)`.
5. **Store:** one SQLite DB per session (WAL mode) + content-addressed blob dir (`blobs/ab/cdef…`, SHA-256, first-2-hex sharding). Schema lives in a checked-in `schema.sql`, applied at session create, and **evolves freely as hand-driving experience demands** (see §6.4 — constraints and aesthetics are fixed, the blueprint is not). **Content model:** every body/frame is a blob; textual bodies (text/JSON/HTML/XML under `bodyTextCap`) are *also* stored in a `bodies(hash, text)` table, and FTS5 external-content tables index `bodies.text` and `ws_frames.payload` at capture time. Writers: the daemon only. Readers: anyone, directly. No ORM, no query builder — string SQL with a tiny typed helper at most.
6. **Direct store access is a feature, not a backdoor:** agent scripts open the SQLite DB in-process with `bun:sqlite` for pure store queries (no daemon round trip); the daemon is only required for live-page interaction and for blob-writing.
7. **Screencast is the visual signal:** `Page.startScreencast` (JPEG, quality ≈ 50, max width ≈ 1280) at native push-on-paint rate, ack every frame, hash every frame; "last changed frame" feeds visual quiescence (GUIDANCE §4.2) while persistence is hash-deduped and rate-capped (≈3 fps). Top-level page targets only (never OOPIF/worker targets). If it proves heavy in attach mode against a human's desktop browser, the sanctioned fallback is on-event + interval screenshots (`Page.captureScreenshot` on mutation/sentinel/interval) — implement the fallback as a mode switch, not an abstraction layer.
8. **Selector engine:** Playwright's `InjectedScript`, vendored from `playwright-core`'s bundle by `scripts/vendor-injected.ts` into `src/vendor/injected-script.ts`, instantiated per frame in the daemon's isolated world. Agent-facing selector language is Playwright's from Slice 2 (`css=`, `text=`, `role=`, `xpath=`, `internal:label=…`, `>>` chaining, shadow-piercing). Also used for `ariaSnapshot` (semantic UI deltas), `expectHitTarget` (occlusion), `generateSelector` (diagnoses). No phase-1 resolver; no `connectOverCDP`. Pin the version; re-vendor deliberately.
9. **Input dispatch:** CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent` **on the top-level page session** with correct event sequences (move → down → up for click; proper `text`/`key`/`code` for typing). Elements in cross-origin iframes are resolved in their own target and their coordinates translated through the frame chain to root-viewport space before dispatch. Always scroll the target into view and verify hit-test point lands on it (or an acceptable descendant) before dispatching; report occlusion instead of clicking through it. Enable `Emulation.setFocusEmulationEnabled` on every page target so unfocused windows behave.
10. **Clocks:** one monotonic clock: daemon `performance.now()` mapped to an epoch anchor recorded in the manifest. Every stored event carries `t` (ms, session-monotonic) and derived wall time. CDP `MonotonicTime` values (seconds, browser `TimeTicks` origin) are mapped by an offset estimated from paired (`timestamp`, `wallTime`) on `Network.requestWillBeSent`, re-estimated on reconnect; epoch timestamps (screencast metadata) map directly.
11. **IDs:** actions get `act:<n>` (per-session counter), events get a monotonic `seq`, blobs are their hash. Handles in reports are these IDs verbatim. No UUIDs anywhere they aren't needed.
12. **Session layout:** `sessions/<name>/` containing `manifest.json`, `store.sqlite`, `blobs/`, `daemon.sock`, `daemon.log`, `stream.jsonl` (the tail, also persisted). The CLI's `disco session new|attach|end` manages lifecycle.
13. **Ambient classifier v1:** periodicity + independence heuristics only, running from Slice 1 so it has history by the time settlement needs it — a request family (same method+host+path-shape) is ambient when seen ≥3 times with regular cadence (coefficient of variation of the gaps < 0.3) **or** chained back-to-back like a long-poll (next start within 250ms of previous end, ≥3 links), with at least one occurrence outside any causality window; classification is recorded per-family with evidence and is *reversible* (attribution stores its confidence tag, and reports note when ambient-classified traffic occurred inside a window). Reports carry `classifier: immature` until the session has observed ≥ `classifierWarmupMs` of idle time. Content-based fallback for "results delivered over the standing channel" is an open question for dogfooding, not v1 code.
14. **Defaults:** quiescence window Q = 300ms; no-effect tier = 500ms; default settlement budget = 3000ms; screencast persistence cap ≈ 3 fps; report digest budget ≈ 300 tokens with a top-8 request cut; idle observation at session start = 20s (skippable). All defaults live in one `defaults.ts` with a comment pointing at the tuning task in §5 — tune from gauntlet + dogfood measurements, not taste.
15. **Target scope (attach mode):** `disco session new --attach <port> --scope <url-substring|regex>` (or `--pick` to choose a tab from a list). Only page targets whose URL matches the scope, plus targets they open (popups, child windows, OOPIFs), are instrumented; the rest are ignored and never appear in the store. Launch mode scopes to the launched browser. The scope is written to `manifest.json`.
16. **Instrumentation order:** `Target.setAutoAttach({flatten:true, waitForDebuggerOnStart:true})` at browser and page level → for each new target: `Network.enable` (raised buffer sizes), `Page.enable`, `Runtime.enable`, `Log.enable`, `Page.addScriptToEvaluateOnNewDocument({worldName:'disco'})` installing the observer, `Runtime.addBinding({name:'__disco', executionContextName:'disco'})`, focus emulation, screencast (page targets only) → `Runtime.runIfWaitingForDebugger`. Targets attached late (already running when the session began) get an `observed_from` timestamp in the `targets` table.
17. **`notes` table:** the one agent-written table (`disco note`, `session.note()`), kinds `state|transition|ledger|note`, optional `action_id`, free text or JSON. Ledger and state map are queries over it.
18. **Report truncation:** requests in the digest are ranked (non-2xx → write-flagged → non-attributed-in-window → by size desc) and cut at `digestMaxRequests`, followed by `+k more` and the cursor; UI delta lines cut at `digestMaxUiLines`.
19. **Write-flag per family:** a request family is `read`, `write`, or `unknown`; GET/HEAD/OPTIONS are `read`; non-GET families default to `write` except `/graphql`-style bodies without `mutation` (peeked at capture) and families the agent marks read via `disco family mark-read`. The report's write-flag fires only for `write`/`unknown` families.

## 2. Repository shape

```
disco/
  README.md                  — quickstart: 10 lines to a first observed click
  GUIDANCE.md                — the guidance doc, checked in verbatim
  BRIEF.md                   — this document
  STATE.md                   — loop memory: done / next / how-to-run (§6.1)
  DECISIONS.md               — divergence & decision log (§6.2)
  REVIEW.md                  — the v0.1 review that produced v0.2
  schema.sql                 — the store schema; source of truth, freely evolving (§6.4)
  defaults.ts
  scripts/vendor-injected.ts — extracts Playwright's InjectedScript into src/vendor/
  src/
    vendor/injected-script.ts — GENERATED: Playwright selector engine + ariaSnapshot
    cdp.ts                   — CDP client (connect, sessions, typed send)
    daemon.ts                — lifecycle, RPC server, target auto-attach
    instrument/              — network, ws, console, dialogs, screencast, observer (in-page)
    settle.ts                — settlement race (pure; fake-clock testable)
    attribute.ts             — causality windows + ambient classifier (pure)
    act.ts                   — resolve → snapshot → dispatch → settle → report
    sentinels.ts
    report.ts                — digest construction
    store.ts                 — writers (daemon-side) + `store.*` readers (client-side)
    selectors.ts             — injected-script bridge: resolve, ariaSnapshot, hit-test
    input.ts                 — mouse/keyboard dispatch, key layout, frame→root coords
    client.ts                — the agent-facing library (`session.*`)
    rpc.ts                   — NDJSON JSON-RPC framing over the unix socket
  cli/
    disco.ts                 — thin command surface incl. `sql`, `eval`, `tail`, `note`
  gauntlet/
    app/                     — the nasty test SPA (§3)
    server.ts
    scenarios.md             — what each control knob does
  demos/                     — human-followable scripts per slice
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
16. **Canvas grid** — an 8×4 grid drawn on `<canvas>`; clicking a cell redraws it with no DOM mutation and no request → pixel-only settlement and coordinate-based input (G§4.2, §7.2).
17. **Keyboard-only combobox** — a medication search whose options ignore mouse events and select only via ArrowDown + Enter → the "working input recipe" failure mode (G§8).
18. **Shadow DOM** — an open shadow root with a button and counter inside → shadow-piercing selectors (G§3.3).
19. **SSE stream** — an `EventSource` endpoint sending 5 events then closing → the streaming-body capture gap is *observed* and flagged, not assumed away (G§3.4).
20. **GraphQL over POST** — a query and a mutation to the same endpoint → per-family write-flag with body peek (§1.19).
21. **Cookie login** — `/login.html` + `/secure.html` → storage-state save/restore in Slice 6.
22. **Long-poll reissue** — the poll from #5 must be able to begin *inside* an action's causality window → the classifier's chained-poll heuristic (§1.13).

**Ambient traffic (#5, #22, spontaneous WS pushes in #6) is OFF by default** and enabled per test via `/ctl`, so Slice 2's timing suite is deterministic and Slice 3 turns it on deliberately.

Acceptance for milestone 0: gauntlet runs with `bun gauntlet`, every behavior manually verifiable in a browser, `scenarios.md` documents each knob, `test/gauntlet/gauntlet-server.test.ts` covers the endpoints. The gauntlet is also the demo sandbox for every subsequent slice.

## 4. Vertical slices

Each slice = implementation + acceptance tests (in `test/gauntlet/`) + a demo script or README section showing a human how to see it work + a `STATE.md` update. Timing assertions use generous-but-real bounds and should run against the local gauntlet where timing is controllable; mark them so they can be loosened on slow CI later, but they run locally by default.

### Slice 1 — Attach + store + always-on instrumentation
Daemon connects to a running Chromium (`--remote-debugging-port`) with a target scope (§1.15), auto-attaches scoped targets/frames in the §1.16 order, and records to the store: requests/responses with eagerly-fetched bodies (size-capped with truncation markers; `evicted`/`streaming` flags), WS lifecycle + frames, console, dialogs (auto-handled per a stub policy, always recorded), navigation/frame events, downloads, screencast frames (hashed every frame, persisted deduped), in-page observer batches (mutations, dialog/toast candidates — raw material for Slice 4). Ambient family tracking starts here. `disco session new/end/ls`, `disco tail`, `disco sql`, `disco note`, `disco targets`. FTS populated at capture. The acceptance test launches its own headless Chromium as the thing to attach to (launch *mode* — profile management, storage state — is still Slice 6).

*Acceptance:* drive the gauntlet **by hand** in the browser while the daemon watches (demo), and in the automated suite drive it via raw CDP `Runtime.evaluate` clicks; then, with the daemon stopped, answer via `sqlite3` alone: every request the page made with status+size; the full body of the virtualized-list response; "did the string `Zebra-Row-9741` ever appear anywhere" (FTS hit in a body, even though it was never rendered); the screenshot nearest the moment the toast was visible; every WS frame in order. A spontaneous WS push and the heartbeat both appear with correct timestamps. An unscoped tab's requests are *absent*. **This slice is independently useful: from here on, real hand-driven discovery sessions are already possible (G§7 note).**

*Demo:* `demos/01-hand-drive.md` — a 5-minute script a human follows.

### Slice 2 — `act()` + settlement
Vendored Playwright selectors (§1.8), input dispatch incl. frame-chain coordinate translation (§1.9), pre/post snapshots (ariaSnapshot-based), the settlement race (window-based attribution only for now; ambient traffic off in these tests), UI delta digest, report construction with truncation (§1.18), `awaitSettlement` (window stays open, G§5.1), `watch()` with diagnosis-on-expiry.

*Acceptance (the timing suite — the point of the whole system):*
- No-op button → verdict `no-effect`, report delivered < 800ms wall (target 600; assert 800 for slop).
- `slow?ms=4000` chart load → `settled:network`, report within `4000 + Q + 500ms`; same test at `ms=400` settles proportionally — **no fixed sleeps anywhere in the pass path.**
- Missing selector → immediate diagnosis (< 500ms) containing fuzzy near-matches, dialog census, pending-request count; **never** a bare 30s timeout.
- Re-render race button → click lands (re-resolve-once path), report notes the detachment.
- Debounced input: `type()` settlement includes the trailing XHR.
- Occluded target → occlusion reported, no blind click-through.
- Canvas cell click → settles on the visual signal (frame changed, then quiet); no DOM/network in the report.
- Cross-origin iframe button → resolved in the OOPIF target, clicked via translated root coordinates, the iframe's POST attributed.
- `watch()` for a selector that never comes, budget 1500ms → diagnosis, and elapsed < 1700ms.

### Slice 3 — Attribution + ambient classifier
Task-tier attribution (in-page one-shot listener, G§4.4), causality windows, redirect/dependency chaining, confidence tags; periodicity + chained-poll ambient classification with evidence records and the `immature` flag; settlement's network detector now uses attributed-only scoping; per-family write-flag (§1.19).

*Acceptance:* with ambient traffic ON and warmed up, heartbeat + long-poll never hold settlement open (chart load at `ms=4000` still settles at ~4.3s with heartbeats firing throughout, **including a long-poll that returns and reissues inside the window**); the 3 chart requests attribute with `task` or `window` confidence; a spontaneous WS push during an unrelated action shows up as *non-attributed activity in the window*; ambient families are queryable in the store with their evidence; a GraphQL query does not raise the write-flag, the mutation does.

### Slice 4 — Sentinels + stream
Dialog/modal, toast, error, session-expiry, new-target sentinels; firings persisted, surfaced in next report's environment flags, and streamed; `disco tail` shows digested live events.

*Acceptance:* conditional modal fires the dialog sentinel with a screenshot handle *even when it appears 2s after settlement*; toast sentinel captures a frame while the toast is visible (assert the blob's timestamp falls in the toast's lifetime); ctl-armed timeout modal fires session-expiry; child window fires new-target and is instrumented (a request made in the child is in the store); an exception + a 500 fire the error sentinel.

### Slice 5 — Client library + CLI + same-script reduction
`session.*` surface finalized: `act`, `awaitSettlement`, `watch`, `evaluate`, `cdp.send`, `note`, `store.*` readers, sentinel/event subscription; `evaluateAfter` in-page functions; canned helpers (`requests`, `appearances`, `timeline`, `screenshotAt`, `action`, `diffTrace`, `body`, `frames`) each documented with their SQL/TS desugaring; CLI generated over the same RPC incl. `disco eval`.

*Acceptance:* one Bun script does `act()` on "Load Rows" and, in the same process, reads the response body from the store and prints the 10k names reduced to a count + first/last — one agent turn, no second tool call; `diffTrace` of record-open with and without `?modal=1` reports the dialog + its requests as the structural difference; every helper's doc example runs verbatim; a script that *only* queries (no live page) runs with the daemon down.

### Slice 6 — Launch mode + hardening
Managed Chromium launch (headed + headless), storage-state save/restore, reconnect-on-daemon-restart against a still-running browser, dialog *policy* (per-session config for confirm/beforeunload), graceful multi-gigabyte-session behavior (blob dedup verified, DB size sane).

*Acceptance:* full slice-2/3/4 suites pass identically in launched-headless mode; kill and restart the daemon mid-session against the same browser and continue acting; a saved storage state restores an authenticated gauntlet variant.

### Slice 7 — Selector engine acceptance across frames and shadow roots
The engine is already vendored (Slice 2); this slice proves it everywhere the gauntlet is hostile, and adds frame-scoped targeting sugar (`{frame: 'iframe#cross-origin'}` or `frame=` prefixes).

*Acceptance:* role/text/label selectors resolve in main frame, nested same-origin iframe, and cross-origin iframe on the gauntlet; the shadow-DOM button resolves and its in-shadow counter is read via `evaluate`; the keyboard-only combobox is driven to a selection with `press` (ArrowDown, Enter) and the recipe is recorded in the report; CSS selectors still work.

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
