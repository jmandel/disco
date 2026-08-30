# Discovery-First UI Reverse Engineering: Guidance Document

**Status:** v0.1 draft — first step toward a skill + supporting service ("the daemon")
**Audience:** frontier agents (Claude Code, Codex CLI, etc.) conducting discovery sessions; engineers building the Bun/TypeScript CDP service they drive
**Scope:** the *discovery* phase — learning how a web application (initially: EHR-class SPAs) is laid out, how to act on it reliably, where it varies, and how to observe it richly — upstream of any durable automation.

---

## 1. Purpose and framing

The goal is to let an agent learn a web application quickly enough, and thoroughly enough, that the eventual automation it produces is cheap to run (few tokens, few round trips) and defensive (survives variability the discovery phase surfaced or predicted). Discovery is a distinct activity from automation, with a distinct mindset: automation wants one reliable path; discovery wants a *map*, including the paths not taken, the branches only sometimes present, and the information that flows beneath the pixels.

The central design inversion: today, agents drive browsers by issuing blind imperatives ("click X, then wait up to 30s for selector Y") and paying for every wrong guess with a full timeout. Instead, the daemon treats **every action as an experiment that returns an observation report**. The agent's job shifts from *guessing what to wait for* to *interpreting what actually happened*. The daemon's job is to make "what actually happened" arrive fast, complete, and small.

Everything below serves four properties:

1. **Snappy** — the agent learns the outcome of an action as soon as the outcome is knowable, ideally within ~500ms of the page reaching a meaningful state, and learns "nothing happened" in well under a second rather than after a timeout.
2. **Rich** — observations jointly cover the screen (pixels, DOM) and the wire (HTTP, WebSocket), because the screen renders only a subset of what the system reveals.
3. **Retroactive** — everything is recorded append-only, so questions can be asked after the fact ("did that MRN ever appear in any response body?") without re-running the session.
4. **Variability-aware** — the output of discovery explicitly distinguishes what was observed from what is merely believed, and flags branches that likely exist but weren't seen.

---

## 2. Core principles

### 2.1 Actions are experiments; reports are the product

Every interaction (`click`, `type`, `press`, `select`, `navigate`, `hover`, `scroll`) is issued through a single choke point that: captures a pre-state, performs the input, watches all channels until the page *settles* (§4), and returns a structured **observation report**. There is no "fire and forget" path in the library. Even a no-op click produces a report — and a no-op report arriving in 400ms is a *successful, informative* result, not a failure. "Nothing changed" is one of the most valuable things discovery can learn cheaply.

### 2.2 Never wait blind; wait on evidence, and fail with a diagnosis

The classic failure mode — `waitForSelector('.modal', {timeout: 30000})` where the modal never comes — burns 30 seconds to learn nothing. Replace it with two rules:

- **Prefer settlement over selectors.** After an action, await the settlement report and inspect it. The report tells you what appeared; you don't have to predict it.
- **When a predicate wait is genuinely needed**, it must be cheap to arm, short by default (budgets in the 1–3s range, explicit when longer), and on expiry it returns a **diagnosis, not a bare timeout**: current URL, visible dialog/modal census, nearest fuzzy matches to the selector (similar classes, similar text), counts of pending network requests and their URLs, whether the DOM mutated at all during the window, and a screenshot handle. A timeout should leave the agent *smarter*, at the cost of one turn, never poorer by thirty seconds.

### 2.3 Joint attention: the screen and the wire are one evidence stream

The DOM shows what the app chose to render; the network shows what the backend actually said. Discovery reads both, correlated in time and causality. Practical consequences: response bodies and WebSocket frames are captured by default; requests are causally attributed to the actions that triggered them (§5.3); the agent is encouraged to prefer extracting facts from structured API payloads over scraping rendered text when both carry the same information — and to *note in its site documentation* which facts are wire-available, because that often lets eventual automation skip UI steps entirely.

### 2.4 Distinguish observed from inferred; assume unseen branches exist

If a popup appeared on 3 of 3 record-opens, the honest claim is "appeared in all observed cases (n=3), likely conditional on record state, condition unknown." Discovery maintains a **variability ledger** (§7.5): for each step of each flow, what varied, what's suspected to vary, and what evidence exists. The prior for enterprise SPAs — and EHRs especially — is that *every* interstitial is conditional: warnings keyed to record state, first-run tips, role-dependent panels, timing-dependent toasts. The agent should reason about the branch it hasn't seen, and the automation it eventually writes should be defensive against optional steps by construction (§9).

### 2.5 Context economy: digest first, drill by handle, extract in-daemon

The daemon never pushes bulk data at the agent. Reports are compact digests with **handles** (stable IDs into the session store) for every underlying artifact: screenshots, full response bodies, DOM snapshots, WS frames. The agent drills down only when needed — and when it knows exactly what it wants, it can pass its **own extraction function** (a real TypeScript function executed in the daemon against the captured data or live page) so the answer comes back already reduced, in the same round trip, with no second tool call. Full HARs, full DOMs, and full-page screenshots enter agent context only by explicit request.

The corollary (developed in §3.1 and §6): reduction happens in the agent's *native* languages — TS functions and SQL against the store — never through a constrained query DSL. Context economy is about moving computation to the data, and that only works if the computation language is unrestricted.

### 2.6 Read-only is a discipline, not a mechanism (yet)

Sessions declare a stance at the start: **read-only** (navigate, open, expand, filter — avoid anything that plausibly writes) or **experimental** (small, preferably reversible writes are permitted to differentiate behaviors; audit-log side effects accepted). The daemon does not mechanically enforce this in v1, but the stance shapes agent behavior: in read-only mode, uncertainty that could only be resolved by a write gets *recorded as an open question* in the ledger rather than probed. A useful supporting signal the daemon can provide cheaply: flag observation reports containing non-GET requests to non-telemetry endpoints, so unintentional writes are at least noticed immediately.

### 2.7 Discovery produces artifacts; the session contract defines which

Don't hard-code the deliverable. At session start the agent agrees on a contract with the user (§7.1): the questions to answer, the stance (read-only vs experimental), the environment (demo/test vs supervised live), and the target artifacts — typically some mix of (a) a site map / navigation-and-quirks document, (b) reusable subtask scripts, (c) a skill that stitches them together, (d) the raw session store itself for later mining. Sensitive-data handling is environmental (demo data, or BAA-covered secure storage with later shredding once shareable artifacts are refined), so capture-time redaction is out of scope for v1.

---

## 3. Architecture

### 3.1 Shape

A long-lived **Bun/TypeScript daemon** owns the browser connection and all state. Agents interact through faces of *descending power, ascending convenience* — and the design rule is that the convenient faces are sugar over the powerful ones, never gatekeepers in front of them:

- a **TypeScript library** (`import { session } from "…"`) — the primary face. Scripts run as short-lived Bun processes that connect to the daemon, so page/session state survives between agent turns. Anywhere the API accepts a filter, predicate, extractor, or reducer, it accepts a **real TS function**, shipped to and executed in the daemon (or in-page, where appropriate) — not a string in a query mini-language.
- **direct substrate access** — the SQLite store is openable read-only by the agent itself (`bun:sqlite`, `sqlite3` CLI) with a documented, stable schema; arbitrary in-page JS via `session.evaluate(frame, fn)` is first-class, not an escape hatch; and a raw CDP passthrough (`session.cdp.send(...)`) exists for anything the library hasn't wrapped yet.
- a **CLI** (`disco act click --sel '…'`, `disco tail`, `disco sql "…"`) for one-liners, tailing streams, and quick queries — generated from the same RPC surface, and including `disco sql` and `disco eval` so even the CLI bottoms out in SQL and TS rather than bespoke flags.

The principle: **investigation is never mediated through a weaker DSL than the agent's native languages.** Frontier agents are fluent in TypeScript and SQL; a boutique `--grep`/`--jsonpath` flag language is strictly less expressive, costs round trips (query, read, refine, query again) where one function would do, and has to be learned besides. Convenience flags may exist for the common 80%, but every one of them must be definable as sugar over SQL-on-the-schema or a TS one-liner, and the docs should show the desugaring so agents graduate naturally to the full-power form when the canned form falls short.

The agent loop, planning, and summarization live in the host platform (Claude Code / Codex CLI); we build *no* agent infrastructure — only the daemon, the faces, and the store.

### 3.2 Attach modes

Both are first-class from day one, sharing one code path (CDP endpoint discovery differs, nothing else):

- **Attach**: connect to an already-running desktop Chromium (started with `--remote-debugging-port`), typically pre-authenticated by a human. This is the near-term mode and it implies: never assume we own navigation history, tolerate humans touching the mouse mid-session, and detect/adopt new tabs and popup windows the app opens.
- **Launch**: start our own Chromium (headed or headless) with a managed profile. Requires the daemon to handle auth flows and session persistence (storage-state save/restore), which discovery itself should document per-site.

Multi-target handling matters more than it seems: EHRs open child windows, print dialogs, and iframes with separate CDP targets. The daemon auto-attaches to every target (`Target.setAutoAttach`, flattened), instruments each identically, and reports include which target the activity occurred on.

### 3.3 CDP core, Playwright as an ergonomic guest

Build the instrumentation and settlement layer **directly on CDP** — this is the whole point of the system, and Playwright's abstractions actively obscure what we need (its auto-waiting is precisely the blind-wait behavior we're eliminating; it doesn't expose WebSocket frames, `Network.requestWillBeSent` initiators, or screencast frames on its terms). The domains we live in: `Target`, `Page`, `DOM`, `DOMSnapshot`, `Runtime`, `Network`, `Fetch` (only if interception is ever needed), `Input`, `Log`, `Overlay` (debug highlighting), `Page.startScreencast`.

That said, two Playwright assets are worth importing rather than rebuilding:

- **The selector engine.** Playwright's `getByRole`/`getByText`/`getByLabel` semantics, shadow-DOM piercing, and frame-scoped locators are excellent and deeply familiar to LLMs. Options, in order of preference: vendor/inject Playwright's open-source `InjectedScript` (its in-page selector evaluator) into each frame so our library resolves Playwright-style selectors natively; or run Playwright via `connectOverCDP` *in parallel* purely as a query/act convenience while all observation flows through our CDP instrumentation. Either way, the agent-facing selector language should look like Playwright's — that's pretrained knowledge we get for free.
- **Input event synthesis details** (trusted-feeling mouse event sequences, keyboard layouts) — crib from their source where CDP `Input.dispatch*` needs finesse.

What we do *not* take: Playwright's waiting model, its tracing (ours must be queryable and append-only, not a zip for a GUI), or its lifecycle management.

### 3.4 Always-on instrumentation

From the moment a target is attached, before any action is taken, the daemon records: all requests/responses with bodies (`Network.getResponseBody` fetched eagerly, subject to a size cap with truncation markers), WebSocket lifecycle + frames both directions, console messages and uncaught exceptions, JS dialogs (`alert`/`confirm`/`beforeunload` — auto-handled per a session policy, always recorded), navigation and frame lifecycle events, downloads, and a low-rate screencast or interval screenshot stream (~2–4 fps equivalent, JPEG, deduplicated when pixels are static) so that *between-action* changes — toasts, async refreshes, session-timeout warnings — are captured even when no action is in flight. Everything is timestamped on one monotonic clock and written to the store as it happens.

---

## 4. The action → observation loop

### 4.1 Anatomy of `act()`

```
report = await session.act(
  { kind: "click", target: role("button", { name: "Open Chart" }), frame: "main" },
  { settle: { budgetMs: 3000 }, extract?: (ctx) => …, expect?: … }
)
```

Internally: (1) resolve the target *now* — if resolution fails, return immediately with the fuzzy-match diagnosis (§2.2), never wait for an element to exist as a side effect of acting on it; (2) snapshot pre-state (screenshot, URL, cheap DOM digest, scroll positions, focused element, open-dialog census); (3) mark a **causality window** and dispatch the input; (4) run settlement detection (§4.2); (5) snapshot post-state; (6) compute deltas; (7) run the agent's `extract` function if provided; (8) persist everything; (9) return the digest.

### 4.2 Settlement: a race of quiescence signals under a hard budget

"Settled" means: the page has most likely finished reacting to this action. No single signal is trustworthy (SPAs long-poll; spinners animate forever; some clicks change nothing), so settlement is a **combination of quiescence detectors racing against tiered deadlines**:

- **Network quiescence (scoped):** no in-flight requests *attributed to this action* (§4.4) for ≥ Q ms (Q ≈ 300). Crucially scoped — heartbeats, analytics beacons, and long-lived polls are classified out (recognized within the first minutes of a session by their periodicity and independence from actions) so they never hold settlement open.
- **DOM quiescence:** no mutations (via a pre-installed `MutationObserver` per frame, batched) for ≥ Q ms — with an escape hatch that ignores identified "always animating" subtrees (clocks, spinners, blink cursors) after they're fingerprinted.
- **Visual quiescence:** consecutive screencast frames differ by < ε pixels outside ignored regions.
- **Discrete completion events:** navigation committed + load/`networkidle`-ish, dialog opened, download started, target created — any of these can settle immediately with a definitive verdict.

Tiers: if *nothing at all* has happened (no mutation, no attributed request, no pixel delta) within ~400–600ms, settle early with verdict **`no-effect`** — this is the fast "nothing happened" path. Otherwise run the quiescence race, hard-capped at the budget (default ~3s, agent-extendable per action for known-slow operations; the EHR reality of 1–10s server latency is handled by the network detector keeping settlement open *while attributed requests are genuinely in flight*, then closing ~Q ms after the last one lands — so a 7s server round trip yields a report at ~7.3s, and a 200ms one at ~0.5s, with no per-case tuning). On budget expiry, settle with verdict **`still-active`** and include *what is still moving* (pending request URLs, mutating subtree, spinner region) so the agent can choose to `awaitSettlement(more)` or proceed. The report always states *which* signal settled it and the timeline of signals — this is itself discovery data ("Open Chart settles on network, ~4s, 12 requests").

Feasibility of the ~500ms notification target: the binding constraint is the quiescence window Q, not our plumbing — you cannot declare "network quiet for 300ms" until 300ms after the last event. So the realistic floor is *outcome + Q (~300ms) + transport (~tens of ms)*, comfortably inside 500ms of the true finish, and discrete completion events (navigation, dialog) report faster still. Where the agent needs to react *mid-settlement*, the streaming interface (§5.4) exposes events as they occur rather than waiting for the report.

### 4.3 The observation report

Digest-sized (target: a few hundred tokens), everything else by handle:

- verdict (`no-effect` / `settled:<signal>` / `still-active` / `navigated` / `dialog` / `new-target` / `download`) + settlement timeline
- **UI delta:** appeared/disappeared/changed summary at the semantic level (roles, names, headings, dialog titles, row counts), not raw node diffs; bounding boxes of changed screen regions; post screenshot handle (+ diff-highlighted variant handle)
- **wire delta:** attributed requests as `method path → status, size, content-type, bodyHandle`, grouped; note of any *non-attributed* activity in the window (so surprises are visible); WS frames summarized
- console errors/warnings during the window
- environment flags: URL change, focus change, new/closed targets, dialog text, **write-flag** (non-GET to non-telemetry endpoint, §2.6)
- `extract` result, if a function was supplied
- store cursor (event-sequence range covering this action) for later queries

An optional `expect` clause (a cheap predicate over the report) doesn't change waiting behavior — it just lets the agent mark reports as surprising, which feeds the variability ledger.

### 4.4 Causal attribution of network activity

Attribute a request to an action when any of: its `initiator` chain (script stack) descends from the input event's task; it started within the causality window (action dispatch → settlement) and is not classified as ambient (heartbeat/poll/analytics/prefetch, learned per-session); or it's a redirect/dependency of an attributed request. Attribution is recorded with a confidence tag (`stack` > `window` > `heuristic`) rather than pretended to be exact. The ambient-traffic classifier is important and cheap: within the first minute of instrumentation, periodic traffic identifies itself; everything about scoped network quiescence and clean reports depends on filtering it.

---

## 5. Watching, waiting, and streaming primitives

### 5.1 `awaitSettlement(opts)`

Re-arm settlement detection without an action — for "I know a refresh is coming" moments, or to extend a `still-active` verdict. Same report shape.

### 5.2 `watch(predicate, opts)` — evidence-driven waits

When a predicate wait is unavoidable, it's implemented as event-driven (mutation observer + network events trigger re-evaluation; no polling loops in the hot path), budgeted short by default, and — per §2.2 — resolves on expiry with the full diagnosis rather than throwing a bare error. The predicate can be a selector, a text/role query, a URL pattern, a "response matching X lands" condition, or an arbitrary in-page function.

### 5.3 Sentinels — standing watchers for the unexpected

Global, long-lived watchers that fire whenever their condition occurs, action or no action: *dialog/modal sentinel* (any element gaining modal/dialog role or a full-screen overlay appearing), *toast sentinel* (transient corner elements — capture a screenshot fast, toasts vanish), *session-expiry sentinel* (idle-timeout warning patterns, auth redirects), *error sentinel* (console exceptions, 4xx/5xx on attributed requests), *new-target sentinel*. Sentinel firings are recorded in the store, surfaced in the next report's environment flags, and available on the stream. Sentinels are the mechanical answer to "random popups you might not have noticed": you don't have to notice — the daemon does, with a timestamped screenshot, and the popup's existence lands in the variability ledger even if the agent was attending elsewhere.

### 5.4 The event stream

`disco tail` (and a library equivalent) streams digested events as they happen — sentinel firings, settlement verdicts, notable requests — as JSONL to stdout/file. This is how an agent (or a human supervising) reacts mid-flight instead of at report boundaries, and it composes naturally with host-platform patterns like backgrounding a tail and checking it between turns.

---

## 6. The session store and retroactive queries

### 6.1 Storage model

Append-only, local, two layers: a **SQLite event index** (one row per event: monotonic timestamp, target/frame, kind, action-id if attributed, compact JSON summary, artifact pointer) and a **content-addressed blob directory** for bodies, frames, screenshots, and DOM snapshots (dedup by hash — screencast frames and repeated API responses dedup heavily). Everything the daemon observes goes here at capture time; nothing is discarded because it seemed unimportant. Sessions are directories; a session manifest records the contract (§7.1), environment, attach mode, and start/end bookkeeping. Retention follows the environment posture from §2.7: keep raw stores while refining artifacts, shred after.

### 6.2 The schema *is* the query interface

The store is designed to be queried directly, not through a mediating layer:

- **The SQLite schema is documented and queried directly — no compatibility machinery.** The agent opens the DB read-only (`bun:sqlite` in scripts, `sqlite3`/`disco sql` from the shell) and writes arbitrary SQL — joins, aggregates, window functions, whatever the investigation needs. Schema design choices serve queryability: normalized-enough tables for requests/frames/mutations/actions/sentinel-firings, generated columns for hot filters (URL host+path, method, status, action-id, attribution confidence), JSON1 for the summary blobs, and **FTS5 full-text indexes over textual response bodies and WS frames** so "did this MRN ever appear" is a native `MATCH`, fast even on large sessions. Live queries during a session are safe via WAL mode. No versioning layer, no views-as-API, no migration story: this is greenfield tooling for frontier agents, which read the actual schema (`.schema`, or a checked-in `schema.sql`) at the start of a session and adapt — when the schema improves, it just changes, and any saved script that breaks gets fixed by the agent in seconds. **Simple and powerful beats over-engineered** is a standing design rule for the whole system: prefer the direct thing (a real table, a real function, a real file) over an abstraction protecting a stability nobody needs.
- **Blobs join in through TS.** Body content lives in the blob directory keyed by hash; the library exposes `store.body(handle)`, `store.frames(range)`, etc., so a typical investigation is a small Bun script: SQL to find the rows, TS to open the blobs and reduce them (`JSON.parse`, walk, extract) — full language, one process, one round trip.
- **Canned helpers are documented as desugarings.** A handful of the highest-frequency questions get named helpers — `requests({urlLike, method, actionId})`, `appearances(textOrRegex)` (bodies + WS + DOM snapshots; screenshots via OCR later), `timeline(t0, t1)`, `screenshotAt(t)`, `action(id)`, `diffTrace(a, b)` (structural comparison of two runs of "the same" step — the substrate for variability analysis and eventual N-record sampling). Each helper's doc shows the SQL/TS it expands to. They're on-ramps and token-savers for the common case, not the interface; the moment a question doesn't fit a helper, the agent drops to SQL+TS without ceremony, and helper source doubles as schema-by-example.

All query output follows the digest+handles convention by default; the agent controls verbosity fully since it's writing the reduction itself.

---

## 7. Discovery methodology

The daemon is the instrument; this section is the mindset. It should eventually become the heart of the skill.

### 7.1 Open with a session contract

Before touching the page, agree with the user on: **goals** (specific questions/flows, e.g. "map the path from schedule → open encounter → sign note"), **stance** (read-only vs experimental, per §2.6 — and if experimental, which kinds of writes are acceptable), **environment** (demo/test/live-supervised; who is logged in, what role, what data exists), **budget** (rough time/turn expectations), and **artifacts** (which of: navigation-and-quirks doc, subtask scripts, skill, raw store). Offer defaults, don't interrogate. Revisit the contract when discoveries change the picture ("this flow requires a signed order to proceed — that's a write; how do you want to handle it?"). Uncertainties that the stance forbids resolving get logged as open questions, not silently skipped.

### 7.2 Recon before flows

Spend the first minutes characterizing the terrain, because everything after is cheaper with this map:

- **Target/frame census:** how many frames and windows, which contain the app vs chrome vs ads/legacy islands; EHRs frequently nest the working UI several iframes deep, sometimes cross-origin.
- **Framework and rendering fingerprint:** React/Angular/GWT/jQuery-era/custom; presence of shadow DOM; presence of canvas-rendered regions (flowsheets and schedule grids are canvas in several EHRs — these need screenshot/coordinate techniques and are worth flagging *early* because DOM-based selection is blind there).
- **Ambient traffic profile:** identify heartbeats, polls, token refresh, analytics (feeds the classifier in §4.4); note session-keepalive behavior and idle-timeout policy — discovery sessions are long, and knowing the timeout (and how the warning presents) prevents mysterious mid-session death.
- **Selector viability sampling:** poke a few interactive elements; do they carry stable ids/`data-*`/test hooks, or generated class soup? Do accessible roles/names exist? This decides the selector strategy for the whole session and belongs in the artifacts (automation should know *why* text-anchored selectors were chosen).
- **API shape skim:** eyeball a handful of response bodies; REST vs RPC vs GraphQL, entity id patterns, whether the wire is readable enough to be a primary information source (§2.3).

### 7.3 Map as states and transitions, not scripts

Model the app as **named states** (recognizable by cheap predicates: URL pattern + a distinguishing landmark element + optionally a distinguishing request) and **transitions** (actions with their settlement profiles and wire signatures). Names matter — they become the shared vocabulary of the docs, the scripts, and future sessions. For each transition record: preconditions, settlement signal + typical duration, requests it fires, and known/possible interruptions. A flow is then a path through states — and automation later becomes "verify state, transition, verify state" rather than a brittle keystroke tape.

### 7.4 Walk flows with experiments, not sleepwalking

Per step: predict (what should this click do?), act via `act()`, compare report to prediction, record surprises. Prefer reading facts off attributed API responses over scraping pixels when both exist, and note in the docs which facts are wire-available. When a step's report shows `still-active` or an unexplained request, that's a thread to pull, not noise to skip. Keep per-step notes *as you go* in the working doc — the session store remembers everything, but the agent's interpretations are the part only it can produce, and context windows end.

### 7.5 Maintain the variability ledger

A running table, per flow step: what was observed (with n), what varied across observations, what is *suspected* to vary and why, and what would resolve the uncertainty (e.g., "open a record with no allergies recorded" — possibly a note for the user to arrange, or a probe if the stance allows). Populate it from three sources: direct observation of variation, sentinel firings (a toast you didn't ask about is variability announcing itself), and priors — interstitials are conditional until proven otherwise, lists are empty sometimes, permissions differ by role, first-visit differs from return-visit. The ledger is a first-class deliverable: it is exactly the list of things defensive automation must handle and the list of experiments a future session should run.

### 7.6 Probe experiments (when stance allows)

Small, deliberate actions to distinguish hypotheses: hypothesis → minimal differentiating action → expected observable difference (on screen or wire) → rollback/cleanup plan → run → record in the ledger. Prefer probes that are reversible, that touch demo data, and that resolve the *highest-leverage* uncertainty (the branch automation will hit most often). When the stance forbids the probe, write it down as a proposed experiment and move on; offer the list to the user at wrap-up.

### 7.7 Close by producing the contracted artifacts

Typical set: (a) a **navigation-and-quirks document** — states, transitions, selector strategy and rationale, settlement profiles, the failure-mode instances actually seen, wire-available facts, auth/session behavior; (b) **subtask scripts** — small TS programs against the library, each doing one named transition or extraction, each *tested at least once during the session* and each defensive per §9; (c) the **variability ledger** with open questions; (d) optionally a skill wrapping (a)–(c). Artifacts should cite evidence (action ids, store cursors) so future sessions can re-inspect rather than re-trust.

---

## 8. Failure-mode catalog

What discovery should expect, detect, and document. Generic to enterprise SPAs; the EHR examples justify their base-layer weight (§ per your scoping: assumptions earn their place by materially improving results).

- **Conditional interstitials:** state-dependent popups on record open (allergy warnings, break-the-glass, care gaps), first-run tips, "what's new" modals. Sentinel-detected; ledger-recorded; automation must treat all as optional.
- **Toasts and transient banners:** carry real information (save confirmations, *async failure* notices) and vanish in seconds; only the screencast/sentinel reliably catches them.
- **Spinners that lie:** perpetual animations that defeat naive visual quiescence (hence fingerprinted ignore-regions), and conversely spinners that vanish *before* content lands (hence never settle on spinner-gone alone).
- **Re-render races:** the element resolved is detached/replaced by the time input dispatches (virtual-DOM re-renders). Resolve-late, dispatch-immediately; on `node detached`, re-resolve once and report that it happened — flakiness worth documenting.
- **Virtualized lists/grids:** rows exist only when scrolled into view; row DOM is recycled. Counting or finding requires scroll-probing — but often the *full* dataset is sitting in an API response already captured (§2.3).
- **Iframes and cross-origin islands; shadow DOM; canvas regions:** covered in recon (§7.2); each demands a different selection technique and the docs must say which applies where.
- **Focus traps and keyboard-only widgets:** date pickers, med-search comboboxes that require real key events (down-arrow + enter) and ignore synthetic clicks; discovery should find the working input recipe and record it verbatim.
- **Debounced/async-validated inputs:** typing triggers per-keystroke or trailing requests; settlement must attribute them, and automation must wait for validation, not just keystrokes.
- **Session expiry and keepalive:** idle timeouts mid-session; warning modals; silent auth redirects that turn every subsequent action into a login-page no-op. Sentinel + recon profile.
- **Multi-window flows:** child windows for documents/prints/signing; auto-attach (§3.2) or lose the plot.
- **Optimistic UI:** the screen says saved before the server agrees; the wire is the truth — check the attributed response status, not the toast.
- **Native browser dialogs and `beforeunload`:** auto-handled per session policy, always recorded, because an unhandled `confirm` freezes everything silently.

Each instance actually encountered goes in the artifacts with its evidence handle; the catalog above seeds the *checklist* discovery runs even when nothing goes wrong.

---

## 9. What discovery hands to automation: defensiveness by construction

Discovery's outputs should make the following the *path of least resistance* for whoever (agent or human) writes automation next:

- Scripts are built from **verified transitions**: assert the named precondition state (cheap predicate from §7.3), act, settle, assert the postcondition — never assume position.
- Every interstitial in the ledger is handled as **optional**: "if dialog X present, dismiss via Y; proceed" — including the ones never observed but predicted.
- **No sleeps.** Waits are settlement- or evidence-based with short budgets and diagnostic failures, same as discovery.
- Failures return **observation dumps** (the report + store cursor), so a failed automation run is itself a discovery datum, not a shrug.
- Facts come from the wire where the ledger says they're wire-available; the UI is for acting, the API for reading, wherever that split is possible.
- Scripts declare their **write footprint**, so read-only orchestration can refuse to run the wrong ones.

---

## 10. Open questions and v1 cut lines

**In v1:** daemon with always-on instrumentation; `act()`/settlement/reports; attribution + ambient classifier; sentinels; watch-with-diagnosis; event stream; session store with documented SQL schema, FTS body index, blob-join library, and the §6.2 helpers (minus OCR); CLI + library; both attach modes (attach first); methodology as documentation.

**Deliberately out of v1:** mechanical read-only enforcement (stance + write-flags only); orchestrated N-record sampling (store supports it; agent can do it by hand); capture-time redaction (environmental posture instead); screenshot OCR in `appearances`; request interception/mocking (`Fetch` domain reserved for later); any agent-loop infrastructure.

**To resolve during build, with real EHR traffic:** default Q and budget values (tune against measured settle-time distributions, not taste); how aggressive the ambient classifier can be before it misclassifies real long-polls that *do* carry action results (some EHRs deliver results over the standing WS/poll channel — attribution may need a content-based fallback); whether screencast at 2–4 fps is cheap enough attached to a human's desktop Chromium or needs to drop to on-event screenshots; how much of Playwright's `InjectedScript` can be vendored cleanly under Bun vs falling back to `connectOverCDP` parallel attachment; and the report-digest token budget (start ~300 tokens, adjust by feel in supervised sessions).

---

## Appendix A: A discovery turn, end to end (illustrative)

1. Agent: `disco act click --role button --name "Open Chart" --budget 6000` (recon showed chart-open is slow).
2. Daemon: resolves target in main frame (34ms), snapshots pre-state, dispatches click, opens causality window.
3. 180ms: three XHRs attributed by initiator stack; DOM mutating; screencast shows spinner region (fingerprinted, ignored for visual quiescence).
4. 4.1s: last attributed response lands (a 900KB patient-summary JSON — body stored, hash-deduped); 4.4s: network quiet ≥300ms, DOM quiet, pixels quiet → settled on network.
5. 4.45s: sentinel fired at 4.2s: dialog role appeared, title "Allergy Review Required" — flagged in report, screenshot handle attached.
6. Report (~250 tokens): `settled:network 4.4s`, UI delta (dialog "Allergy Review Required" over chart view; header now shows patient name/DOB), wire delta (3 requests, incl. `GET /api/patient/{id}/summary → 200, 900KB, bodyHandle b41f`), write-flag: none, cursor `ev:1042-1131`.
7. Agent reads the report, notes the interstitial in the ledger (n=1, suspected conditional on allergy-record state), and instead of scraping the header, writes a three-line Bun script: `const s = JSON.parse(await store.body("b41f")); console.log(s.problems.map(p => p.display))` — getting the full problem list, most of which was never rendered. Had it wanted "every response this session that mentions a problem-list entry," it would have gone straight to SQL: `SELECT … FROM requests JOIN bodies_fts ON … WHERE bodies_fts MATCH 'hypertension'`.

