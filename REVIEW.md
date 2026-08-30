# Review: discovery docs (original take)

Reviewed 2026-08-30: `ui-discovery-guidance.md` (v0.1, 278 lines — "the constitution") and
`ui-discovery-build-brief.md` (v0.1, 183 lines — "the construction plan").
Section refs: G§ = guidance, B§ = brief.

## Verdict

Strong pair. The guidance doc's central move — every action is an experiment returning an
observation report; settlement is a race of *scoped* quiescence signals under tiered deadlines —
is correct, well-argued, and honest about its own floor (outcome + Q + transport). The
"never mediate investigation through a weaker DSL than TS+SQL" principle and the
schema-is-the-interface stance are the right calls for greenfield agent tooling. The brief is
unusually disciplined: pre-decided choices, a forbidden-abstractions list, vertical slices each
gated by a runnable demo + acceptance suite, and an explicit divergence log.

What follows is mostly (A) places where the docs are more confident than CDP actually allows,
(B) one simplification, (C) gaps in the gauntlet that would let untested claims through Slice 8,
(D) small additions, (E) editorial. Ordered within each group by cost-if-found-mid-build.

---

## A. Technical claims that need softening or a mechanism

### A1. Initiator-stack attribution is weaker than the prose implies (G§4.4; B Slice 3)
`Network.requestWillBeSent.initiator.stack` is the *synchronous* JS stack at `fetch()` /
`xhr.send()` time. In React/Angular/RxJS apps the click handler dispatches to a store and the
request fires from an effect on a later micro/macrotask — the stack shows the scheduler, not the
handler. Async parents appear only with `Debugger.enable` + `Debugger.setAsyncCallStackDepth(n)`
(populates `initiator.stack.parent`), which costs renderer perf and still breaks across some
scheduler patterns (React's `MessageChannel` scheduling). And there is no CDP handle that links
an `Input.dispatchMouseEvent` to "the input event's task"; you'd be matching handler frames by
function/URL heuristically.
→ State plainly: **window + ambient classification is the workhorse; `stack` is a bonus tier.**
Name `setAsyncCallStackDepth` as the mechanism and make it a measured opt-in. Slice 3 acceptance
already allows `stack` *or* `window` (good) but the guidance prose leads with stack.

### A2. Visual quiescence at "~3 fps" cannot participate in a 500 ms verdict (G§4.2; B§1.7, §1.14)
Two consecutive identical frames at 3 fps means ≥ ~666 ms after the last change — that alone
exceeds the 500 ms target, and the no-effect tier (500 ms) may see zero frames at all. This
matters because the doc itself flags **canvas-rendered EHR regions** (G§7.2, §8) where pixels
are the *only* signal (DOM and network are silent) — a canvas click would misfire as `no-effect`.
→ Reframe: `Page.startScreencast` is *push-on-paint*. Run it at native rate (use `everyNthFrame`
for cost), treat **"no `screencastFrame` for Q ms" as the visual-quiet signal**, and apply the
3-fps / hash-dedup target to *storage*, not detection. Also note `screencastFrame` stops when the
tab is backgrounded — in attach mode the human switching tabs blinds the visual channel. Specify
which measured condition flips to the `captureScreenshot` fallback mode.

### A3. Long-poll reissue inside a causality window (G§4.4; B Slices 2–3)
A long-poll that returns *during* a window and immediately reissues is in-window by construction;
without an already-learned ambient family it holds settlement to budget → `still-active`.
Periodicity won't catch it (cadence depends on server hold time); only the independence heuristic
will, and only after evidence. Consequences:
- **Slice 2's timing suite will be flaky by design** if the gauntlet's ambient traffic is on —
  contradicting B§6.5 ("a flaky test is a bug"). Make ambient traffic **opt-in via `/ctl`,
  default off**; Slice 3 turns it on.
- The classifier has zero evidence at the first `act()`. Connect G§7.2's "ambient traffic
  profile" to the mechanism: `disco session new` (or recon) idle-observes ≥ N s before first act;
  early reports carry `classifier: immature`.
- Slice 3 acceptance should explicitly include the reissue-inside-window case.

### A4. Eager `Network.getResponseBody` has known failure modes (G§3.4; B Slice 1)
- Bodies are retrievable only after `loadingFinished` and while Chromium still buffers them; on
  busy pages they get evicted → `No resource with given identifier`. Set
  `Network.enable({maxTotalBufferSize, maxResourceBufferSize})` high (Playwright does).
- **Streaming responses (SSE, long chunked) never reach `loadingFinished`** → no body, ever.
  Given G§10's own worry that some EHRs "deliver results over the standing channel", SSE is a
  plausible channel and would be invisible. Either accept + document, or reserve
  `Fetch.enable` + `Fetch.takeResponseBodyAsStream` for it. Add an SSE endpoint to the gauntlet so
  the gap is *observed* rather than assumed away.
- Redirect chains reuse `requestId` with `redirectResponse` on the next `requestWillBeSent`; the
  Slice 1 schema needs to model this even though chaining logic is Slice 3.

### A5. Cross-origin iframes: input goes to the *root* target with translated coordinates (B§1.9; gauntlet #10)
`Input.dispatchMouseEvent` is sent to the top-level page session; resolution and hit-testing
happen in the OOPIF session; you must translate by the iframe's offset in the parent (walk
`DOM.getBoxModel` up the frame tree). This is the classic hand-rolled-CDP bite that Playwright
papers over. Call it out for Slice 2 and run the occlusion/hit-test acceptance in the
cross-origin frame too, not only in Slice 7.

### A6. "Instrumented before first script" needs `waitForDebuggerOnStart` + isolated worlds (G§3.4)
Mechanically: `Target.setAutoAttach({flatten:true, waitForDebuggerOnStart:true})` → enable
`Network/Page/Runtime` → `Page.addScriptToEvaluateOnNewDocument` (MutationObserver +
`Runtime.addBinding` push) → `Runtime.runIfWaitingForDebugger`. The observer should live in an
**isolated world** so app JS and CSP can't see or clobber it. Neither doc mentions either; both
are load-bearing for the "from the moment a target is attached" promise.

### A7. Attach mode auto-attaches to *every* tab in the human's browser (G§3.2; B Slice 1)
Against a real desktop Chromium with 20 tabs, "auto-attach to every target" instruments and
screencasts Gmail, Slack and the bank. Nothing scopes attachment. Needs a target filter (URL
pattern or explicit tab pick at `session new`; newer Chromium supports
`Target.setAutoAttach({filter})`, else ignore non-matching targets daemon-side), recorded in the
manifest. Privacy-relevant, cheap, belongs in Slice 1.

### A8. Focus emulation in attach mode
If the human's window isn't focused, `document.hasFocus()` is false; React focus handling,
`:focus` styling and some comboboxes misbehave under synthetic input. Playwright enables
`Emulation.setFocusEmulationEnabled`. One line in Slice 2.

### A9. "FTS5 external-content" contradicts blobs-on-disk (B§1.5)
External-content FTS5 requires the content in a SQLite table; bodies live in the blob dir.
Pick one: (a) **contentless** FTS (`content=''`) indexed at capture, `MATCH` → rowid → request →
blob (loses `snippet()`/`highlight()`); or (b) keep textual bodies under a size cap *in* SQLite
(`bodies` table), large/binary in blobs. (b) makes `appearances()` and one-line SQL nicer and is
what queryability-first argues for. Also: index only text/JSON content-types (base64/minified
bodies bloat the index), and reconcile G§6.2 (`appearances` covers DOM snapshots) with B§1.5
(indexes only bodies + WS frames).
Verified locally: Bun 1.3.14 / SQLite 3.53.0 `bun:sqlite` has FTS5 + JSON1.

### A10. `awaitSettlement` after `still-active` needs the window to stay open (G§5.1; B Slice 2)
If the causality window closes at budget expiry, re-arming attributes nothing and settles
`no-effect` immediately. State that the window closes at *eventual* settlement and that
`awaitSettlement` extends the same `act:<n>`.

### A11. Clock mapping detail (B§1.10)
CDP `Network.*` timestamps are `MonotonicTime` in *seconds* from the browser's `TimeTicks`
origin — not the daemon's `performance.now()`; `screencastFrame.metadata.timestamp` is epoch.
Derive the offset from paired (`timestamp`, `wallTime`) on `requestWillBeSent`, per browser
(TimeTicks is process-wide), re-estimated on reconnect. Fine as a decision; under-specified.

---

## B. Simplification: in-daemon `extract` may not earn its keep (G§2.5; B§1.4, Slice 5)

The stated motivation is "no second tool call". But a tool call is an *agent turn*, and one turn
is one Bun script — which can already `await session.act(...)` and then read
`store.body(handle)` in the same process, because bodies are persisted before the report returns.
A local Unix-socket round trip is ~1 ms; no turn is saved. What daemon-side `extract` uniquely
buys is running against the *live page at the instant of settlement* — which is `evaluate`.

Suggest: drop daemon-side `extract`; add `act(..., { evaluateAfter: fn })` (in-page,
stringified — closures can't transfer there anyway). Keep CLI `--extract` as *client-side* sugar.
This deletes the temp-module dynamic-import machinery and removes the "closures don't transfer"
footgun from the library face. Either way, an explicit DECISIONS entry.

---

## C. Gaps the gauntlet won't catch (B§3)

The gauntlet is the proof system; anything missing from it is an untested claim at Slice 8.
Proposed additions:

16. **Canvas-rendered grid** — G§7.2/§8 call this EHR reality; nothing exercises coordinate
    clicks or pixel-only settlement (see A2).
17. **Keyboard-only widget** — G§8 "focus traps"; a combobox ignoring synthetic click, needing
    ArrowDown + Enter.
18. **Shadow DOM** — Slice 7 says "add one"; put it in milestone 0.
19. **SSE / streaming response** — see A4.
20. **GraphQL / RPC-over-POST read endpoint** — to measure the write-flag false-positive rate (D2).
21. **Trivial cookie login** — Slice 6's "authenticated gauntlet variant" needs it.
22. **Long-poll that reissues mid-action**, with all ambient traffic ctl-gated off by default (A3).

Also: `demos/01-hand-drive.md` (Slice 1) has no `demos/` in the §2 repo shape.

---

## D. Additions that honor "simple and powerful"

**D1. A `notes` table.** G§7.4: interpretations are "the part only the agent can produce, and
context windows end" — yet they live in markdown while evidence lives in SQLite, so
cross-referencing by `act:<n>` is manual. `disco note --kind ledger|state|transition|note
--action act:12 "..."` → one table, ~20 lines, and `timeline()` interleaves interpretation with
evidence. The variability ledger becomes a *query*, not a document.

**D2. Write-flag per family, with a GraphQL peek.** "Non-GET to non-telemetry" fires on every
GraphQL query and RPC-style read; the agent will learn to ignore it. Classify per request
family, let recon mark families as read, peek `/graphql` bodies for `mutation`.

**D3. Report truncation policy.** ~300 tokens won't hold a 12-request chart-open with UI delta +
timeline + flags (Appendix A's 3-request example is already ~250). Specify top-N by
interestingness (non-2xx, write-flag, largest body, non-attributed) plus "+k more, cursor
ev:a–b". Tune later as the brief says, but the policy must exist in Slice 2.

**D4. Slice 7 vendoring is low-risk — say so.** `playwright-core/lib/generated/
injectedScriptSource.js` exports a plain `source` string. Playwright itself instantiates it as
```js
(() => { const module = {}; ${source};
  return new (module.exports.InjectedScript())(globalThis, false, "javascript",
    "data-testid", rafCount, "chromium", []); })()
```
then calls `injected.querySelectorAll(injected.parseSelector(sel), document)`. That's ~15 lines
via `Runtime.evaluate` in an isolated world; the `connectOverCDP` fallback is very unlikely to
be needed. Pin the version — you're depending on an internal bundle (fine under no-compat).

---

## E. Internal inconsistencies & editorial

- G§8 opening: "(§ per your scoping: assumptions earn their place…)" is leftover chat-transcript
  residue — delete.
- CLI syntax differs: G§3.1 `disco act click --sel '…'` vs Appendix A `--role button --name
  "Open Chart"`. Pick one — suggest a single `--target` taking Playwright selector syntax
  (`role=button[name="Open Chart"]`), since that's the language Slice 7 lands on.
- G§3.2 "both attach modes first-class from day one" vs B Slice 6 deferring launch — reasonable
  sequencing, but by the brief's own rule it's a divergence; pre-seed DECISIONS.md with it.
- Screencast should run on top-level page targets only (not OOPIF/worker targets); service
  workers network-instrumented but not screencast. One line in B§1.7.
- G§2.2 diagnosis "< 500 ms" with fuzzy matches: `Accessibility.getFullAXTree` on a 10k-node EHR
  page can take seconds. Scope to frame + node cap, or compute candidates in-page via the
  injected script once Slice 7 lands; phase-1 diagnosis will be crude and should say so.
- `Page.javascriptDialogOpening` *must* be answered or the renderer blocks — Slice 1's
  "auto-dismiss + record" stub is required, not optional.
- B§1.13 "occurrences outside any causality window": in a hand-driven Slice 1 session there are
  no windows; fine, but say the classifier runs from Slice 1 so it has history by Slice 3.

---

## What I'd change first

1. **A2 + A3** — screencast-as-signal reframing; ambient traffic off by default; idle-observe
   before first act. These set Slice 2's acceptance numbers.
2. **A7** — target scoping in attach mode (privacy; Slice 1).
3. **A9** — FTS content model (schema decision; Slice 1).
4. **A1** — wording, so the build doesn't chase stack attribution.
5. **C16–C22** — gauntlet additions before Slice 1 starts.
6. **B** — decide on `extract` before Slice 5 builds it.
