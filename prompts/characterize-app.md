# Characterize a web app with disco — agent prompt (general)

Fill the `{{…}}` fields, then hand the whole text to a fresh agent (Claude Code `Agent` / a new session) with
this repository checked out, dependencies installed (`bun install`) and Chromium available. One agent, one
app, one pack. `characterize-ehr.md` is this prompt specialized for EHR-class systems.

---

You are characterizing a web application you have never seen, using **disco** — a browser-instrumentation
daemon + agent library in this repository — so that (a) a human can understand how the product works and
where its facts live, and (b) automation can drive it robustly afterwards. The output is a **pack** under
`apps/{{PACK}}/`. You are not evaluating disco; you are doing an excellent job on the app. Where disco gets
in your way, note it briefly and route around it.

## Target

- Product: **{{TARGET_NAME}}**
- URL: `{{BASE_URL}}` — {{HOSTING_NOTES}}
- Credentials: {{CREDENTIALS}}
- Data posture: {{DATA_POSTURE}}. **Never point disco at a production system with real personal data.**
- Stance: **{{STANCE}}**.
- What "done" means for this pass: {{DONE}}
- Time budget: {{TIME_BUDGET}}. Prefer depth on the core flows over breadth.

## Read first (in this order)

1. `README.md` — the three faces (store / library / CLI), report shapes, the timing model.
2. `docs/using-disco.md` — the whole field guide, especially **"The two questions"** (`act()` says what the
   app did; `until` says whether the state you need arrived — the verdict is never the readiness gate),
   **"Instrument"** (how to look at what you attached to, and how to warm the classifiers without blocking),
   and **"Writing a robust function"**.
3. `GUIDANCE.md` §7 (discovery methodology), §8 (failure-mode catalog), §9 (what discovery hands to automation).
4. `apps/README.md` — the ways of knowing a pack holds — then the reference packs that exist in your tree.
5. `lib/nav.ts` and `lib/wire.ts` — the Layer-1 moves you will build on.

## Method (GUIDANCE §7)

**0. Session contract.** Write it at the top of `nav-and-quirks.md` before acting: target, roles, stance,
posture, what "done" means for this pass.

**1. Instrument.** Start a session (`session new … --launch --headless --url …`, or attach), then look at
what you attached to (`disco targets`, a screenshot) before investing anything; warm the classifiers the
way the field guide describes — overlapped with recon, never as a blocking step. Check `disco families`:
what is ambient should be tagged ambient with evidence; when the classifier is wrong for this app, a rule
(`families --ambient|--not-ambient <url-part>`) or a sentinel mute is the override — note every override
in `nav-and-quirks.md` with its evidence.

**2. Recon before flows.** Architecture (SPA/MPA, frames, workers, standing channels — WS/SSE/long-poll),
auth (cookie/token, redirects, expiry), the wire at rest, the write-flag pass (which non-GET families are
reads, which genuinely change state — mark reads so the flag stays meaningful).

**3. Map as anchors and transitions, not scripts.** Name the states you can cheaply assert (URL + landmark)
and the transitions between them: action, verdict, `settle.ms`, attributed wire signature, the postcondition
naming the next anchor. Every interactive surface gets a row; `bun scripts/timing-report.ts {{PACK}}` gives
the settle profile at the end.

**4. Walk the flows with experiments.** Every act is an experiment that returns a report; **read it**. Every
act that transitions state carries its postcondition (`until`, combinators when the outcome is a
disjunction); never sleep; never trust the verdict alone; a diagnosis is read before any retry.

**5. Maintain the variability ledger.** What varies between runs or records, with n-counts, a hypothesis,
and the experiment that would resolve it. Observed vs inferred visibly different.

**6. Probe experiments (within stance).** Timeouts, a second tab, error paths, empty states, the things the
failure-mode catalog says to look for.

**7. Verify, then close.** `bun scripts/run-check.ts {{PACK}}` must pass; then produce the artifacts.

## The checklist (GUIDANCE §8 — record present / absent / unobserved for each)

Conditional interstitials · toasts/transient banners · spinners that lie · re-render races · virtualized
lists · iframes / cross-origin islands / shadow DOM / canvas · focus traps and keyboard-only widgets
(record the key recipe verbatim) · debounced / async-validated inputs · session expiry + keepalive ·
multi-window flows · reads over POST · optimistic UI · native dialogs / `beforeunload` · standing channels
(WS/SSE/long-poll) · third-party telemetry · bot challenges.

## Deliverables — `apps/{{PACK}}/`

- `nav-and-quirks.md` — session contract; architecture; **anchors** with cheap predicates; **transitions**
  with settle profile + wire signature; interstitials and how to handle each; keyboard recipes; recovery;
  the checklist with a verdict per item; open questions.
- `ledger.md` — the variability ledger (what varied | n | hypothesis | resolving experiment | evidence act ids).
- `wire.md` — **where the facts live**: endpoint family → what it carries, read/write, read-POSTs; the
  handful of bodies worth citing by handle; standing channels and what they deliver.
- `lib.ts` — plain importable TypeScript: the flows as robust functions (anchor in → anchor out,
  postcondition on every transition, wire-first reads, interstitials optional, idempotent where sensible,
  declared write footprint). Composable; no sleeps; one selector language.
- `check.ts` — `export const target = { url, scope }` (+ optional `ready`) and `check(s)` with PASS/FAIL
  per step and durations (`run-check` must pass).
- `screenshots/` — a handful of cited shots.
- `friction.md` — brief: where the tool or docs got in your way, in the format of the reference packs' logs.
- The store stays in `apps/{{PACK}}/store/` — every claim in the notes cites an act id or store cursor.

## Quality bar

- Zero `sleep(` / fixed waits anywhere in the pack; every wait is `until` on the act or `until()`/`watch()`.
- Every function verifies where it is and where it arrived; failures throw with verdict + diagnosis.
- Facts come from the wire where they are wire-available; the UI is for acting.
- Observed vs inferred explicit; every claim has an act id; write footprint declared; stance respected.
- `run-check` green; `timing-report` shows the settle profile you documented.

## Final report (your last message)

(a) One paragraph: what this app *is*. (b) The pack's contents and the `run-check` output. (c) The ledger's
most important rows. (d) The checklist verdicts. (e) Open questions and next probes. (f) Tool friction,
briefly. (g) Wall-clock time (`date -u` first and last).
