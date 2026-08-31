# Characterize a new EHR with disco — agent prompt

Fill the `{{…}}` fields, then hand the whole text to a fresh agent (Claude Code `Agent` / a new session) with
this repository checked out, dependencies installed (`bun install`) and Chromium available. One agent, one
EHR, one pack. Budget: a few hours of agent time for a first pass.

---

You are characterizing an EHR you have never seen, using **disco** — a browser-instrumentation daemon +
agent library in this repository — so that (a) a human can understand how the product works and where its
facts live, and (b) automation can drive it robustly afterwards. The output is a **pack** under
`apps/{{PACK}}/`. You are not evaluating disco; you are doing an excellent job on the EHR. Where disco gets
in your way, note it briefly and route around it.

## Target

- Product: **{{TARGET_NAME}}** ({{VERSION_OR_EDITION}})
- URL: `{{BASE_URL}}` — {{HOSTING_NOTES: demo instance / staging / hosted sandbox}}
- Credentials: {{CREDENTIALS_AND_ROLES}} (try more than one role if given; roles see different UI)
- Data posture: {{DATA_POSTURE: synthetic demo data / BAA-covered sandbox}}. **Never point disco at a
  production system with real patient data.**
- Stance: **{{STANCE: read-only | writes allowed in these areas: …}}**. Under read-only, do not submit
  forms that persist (orders, notes, demographics edits); reads delivered over POST are fine.
- Time budget: {{TIME_BUDGET}}. Prefer depth on the core flows over breadth.

## Read first (in this order; ~30 minutes)

1. `README.md` — the three faces (store / library / CLI), report shapes, the timing model.
2. `docs/using-disco.md` — the whole field guide, especially **"The two questions"** (`act()` says what the
   app did; `until` says whether the state you need arrived — the verdict is never the readiness gate) and
   **"Writing a robust function"**.
3. `GUIDANCE.md` §7 (discovery methodology), §8 (failure-mode catalog — EHR examples throughout), §9 (what
   discovery hands to automation).
4. `apps/README.md` — the ways of knowing a pack holds — then the reference packs: `apps/openemr/` (an EHR:
   nested frames, read-POSTs, a native-alert interstitial), `apps/gauntlet/` (the synthetic hostile app; its
   `friction.md` is the format for yours), `apps/saucedemo/` (a DOM-first SPA).
5. `lib/nav.ts` and `lib/wire.ts` — the Layer-1 moves you will build on (`until`, `reached`,
   `assertVisible`, `actIfPresent`, `waitForFrame`, `extractFromWire`, `wireHas`).

## Method (GUIDANCE §7, applied to an EHR)

**0. Session contract.** make it your first `disco note` (it opens NOTES.md) before acting: target, roles, stance,
posture, what "done" means for this pass (the flows below).

**1. Instrument.** `bun cli/disco.ts session new {{PACK}} --launch --headless --url {{BASE_URL}}`, then
look at what you attached to (`disco targets`, a screenshot) before investing anything: if it is not the
app — the tool will say so when it can tell — reconsider the host or the attach mode first. EHRs have
minute-scale heartbeats and long-polls, so the classifiers need a longer warm-up than the default
observation; do it the way `docs/using-disco.md` "Instrument" describes (overlapped with recon, not as a
blocking step). Check `bun cli/disco.ts families`
— every ambient family should be tagged ambient with evidence. EHR front-ends refetch in bursts (SWR) and
re-read `session`/`user` on every route change: if a real heartbeat is not tagged, or a request that fired
*with* your action is (the report names these), a **rule** is the override: `disco families --ambient
<url-part>` (third-party telemetry, an unlearnable poll) / `--not-ambient <url-part>` (a mis-learned read);
`disco sentinels --mute <name> --text <t>` for sentinel noise (Carbon table rows). Rules persist per app;
register a pack's rules in its `login` so every run starts right, and `disco note` each one with its evidence.

**2. Recon before flows.** Before driving anything: what is the architecture (SPA? MPA? tabs as iframes —
`bun cli/disco.ts targets` shows frames), where does auth live (cookie/session, token, redirect patterns,
expiry warnings), what does the wire look like at rest (families, WS/SSE channels). Do the **read-POST
pass** early: sample the POST families; mark the read-shaped ones (`families --mark-read <family>`) so the
write-flag stays meaningful; record the genuinely state-changing endpoints.

**3. Map as anchors and transitions, not scripts.** Name the states you can cheaply assert (URL pattern +
landmark element): login page, app shell, patient search/finder, patient chart (dashboard), and the
sections inside the chart the flows need (problems, allergies, medications, vitals, encounters/notes).
For each transition record: the action, the verdict, `settle.ms`, the attributed wire signature (families,
statuses), and the postcondition that names the next anchor. `bun scripts/timing-report.ts {{PACK}}`
prints the settle/overhead distribution when you are done — put the per-transition profile in the pack.

**4. Walk the flows with experiments.** Every act is an experiment that returns a report; **read it**.
Every act that transitions state carries its postcondition: `until: { selector | fn | urlLike (+landed) }`
— in another frame when the effect lands there (`until.frame`). Never sleep. Never trust the verdict
alone. When a selector is missing, the diagnosis (near-matches, dialog census, pending requests, shot)
tells you why — read it before retrying. Flows for this pass:
- **login** (idempotent; handles a location/role/department picker if one exists — present OR absent;
  detects the app's own failure message; reaches the shell anchor)
- **findPatient(name)** (search works past page 1; result read **off the wire** — the search API's
  response — not the rendered rows)
- **openPatient(idOrName)** (reaches the chart anchor; every interstitial optional both ways)
- **extractSummary()** (problems / allergies / medications / latest vitals — from captured API responses or
  summary fragments first, DOM as fallback; say which)
- {{OPTIONAL_FLOW: e.g. open the latest encounter and read its note; list appointments; open a result}}

**5. Maintain the variability ledger.** Open at least **three patients** (different ages/complexity) and
log what varies: interstitials that appear for some (allergy warnings, break-the-glass, due reminders,
care gaps, "what's new"), sections that are empty vs populated, per-patient wire differences
(`store.diffTrace(actA, actB)`). Each row: what varied, n-observed / n-total, hypothesis, the experiment
that would resolve it. Observed vs inferred must be visibly different in your notes.

**6. Probe experiments (only within stance).** Timeouts (idle until the expiry warning; how is it
delivered — dialog, redirect, toast?), a second tab, a role with fewer rights, a patient with no data.

**7. Verify, then close.** `bun scripts/run-check.ts {{PACK}}` must pass; then produce the artifacts.

## The EHR checklist (GUIDANCE §8 — look for each; record present / absent / unobserved)

Conditional interstitials on chart open · toasts/transient banners (async failures live there) ·
spinners that lie (perpetual or vanish-before-content) · re-render races on virtual-DOM lists · virtualized
lists (the full dataset is usually on the wire) · iframes / cross-origin islands / shadow DOM / canvas
(flowsheets, schedule grids) · focus traps and keyboard-only widgets (medication/order search: record the
key recipe verbatim) · debounced / async-validated inputs · session expiry + keepalive · multi-window flows
(documents, prints, signing) · reads delivered over POST · optimistic UI (the screen says saved before the
server agrees — the wire is the truth) · native dialogs / `beforeunload`.

## Deliverables — `apps/{{PACK}}/`

The shape is `apps/README.md`'s — **NOTES.md accumulates as you work** (`disco note` writes it; every
claim cites an act id) and you distill what earns it, as you go, into:

- `README.md` — what this app is; how to drive it (anchors with cheap predicates, transitions with their
  settle profile + wire signature, interstitials and recovery, keyboard recipes verbatim); where the facts
  live on the wire (endpoint family → what it carries, read/write); what varies (n-counts, observed vs
  inferred, the experiment that would resolve each); the checklist above with a verdict per item; open questions.
- `lib.ts` — the flows as robust functions: anchor in → anchor out, postcondition on every transition,
  wire-first reads, interstitials optional both ways, idempotent where sensible, declared write footprint,
  no sleeps, one selector language.
- `check.ts` — `export const target = { url, scope }` (+ optional `ready`) and `check(s)` with PASS/FAIL
  per step and durations; `bun scripts/run-check.ts` must pass.
- Extra files only when they earn their place (`screenshots/` with cited shots; `wire.md`; `friction.md` —
  put tool/doc friction somewhere, briefly and bluntly).

The store stays in `apps/{{PACK}}/store/` (gitignored, run-tagged); NOTES.md and README cite act ids so
everything can be re-queried.

## Quality bar

- Zero `sleep(` / fixed waits anywhere in the pack. Every wait is `until` on the act or `until()`/`watch()`
  with a budget and a diagnosis on expiry.
- Every function verifies where it is (anchor) and where it arrived (postcondition); failures throw with
  the verdict + diagnosis, never a bare timeout.
- Facts come from the wire where the ledger says they are wire-available; the UI is for acting.
- Observed vs inferred is explicit everywhere; every claim has an act id.
- Write footprint declared per function; the stance is respected.
- `run-check` green; `timing-report` shows the settle profile you documented.

## Final report (your last message)

(a) One paragraph: what this EHR *is* (architecture, auth, where facts live) — the sentence a human wants
first. (b) The pack's contents and the `run-check` output. (c) The variability ledger's most important rows.
(d) The checklist verdicts (present/absent/unobserved). (e) Open questions and the next probes. (f) Tool
friction, briefly. (g) Wall-clock time spent.
