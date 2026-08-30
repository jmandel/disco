# artifacts/ — where discovered knowledge lives

Three kinds of knowledge come out of a discovery session, and they go to three different homes decided
by one question: **is this true of the tool, true of this app, or true of the class of apps?**
(BRIEF §5 names the fork: the friction log "feeds both code fixes and … the advice-and-quirks content
of the eventual skill.") This directory is home #2 — **per-app knowledge**. The other two live elsewhere:

| home | what belongs here | where |
|---|---|---|
| **the framework** | truths about the *tool* — bugs, missing capabilities, tuning that helps *any* app | `src/`, `defaults.ts`, logged in `DECISIONS.md` |
| **per-app site packs** | truths about *this app* — states, transitions, quirks, wire endpoints, reusable scripts | **here**, one subdir per target |
| **the methodology** | truths about the *class / the craft* — priors and procedures for EHR-class SPAs | `GUIDANCE.md` §7–8, and the eventual skill |

## What's here

- **`openemr/`** — the OpenEMR site pack (dogfood #1). A site pack is:
  - `nav-and-quirks.md` — narrative map: states, transitions with settlement profiles, selector strategy, quirks, wire-available facts, honest coverage/gaps.
  - `site.json` — the same, machine-readable: a **hint pack** a future session (or the framework) can preload to skip re-learning (heartbeat families, read-POST families, login recipe, states). Confirm, don't trust.
  - `ledger.md` — the variability ledger: observed-vs-inferred with n-counts and the experiment that resolves each.
  - `scripts/` — reusable, defensive subtask scripts (each tested against a live session at least once).
  - `dogfood-1.md` + `screenshots/` — the session report and evidence.
- **`gauntlet/`** — the site pack for the gauntlet-as-unknown-app (the Slice-8 dry-run handover). Same shape as any target: `nav-and-quirks.md`, `ledger.md`, `friction.md`, `scripts/`.

Every target gets its own subdir `artifacts/<target>/`; there is no top-level per-target file.

## The promotion path (raw → durable)

Knowledge starts raw and gets distilled:

1. **store** (`sessions/<name>/store.sqlite` + blobs) — empirical ground truth, append-only, retroactively queryable. Nothing is "known" that isn't recorded here.
2. **notes/ledger** (`disco note`) — the agent's interpretations, cited to act ids, with confidence.
3. **in-session learned models** (ambient classifier, DOM-churn roots, visual ignore mask) — learned *during* the session, then thrown away. Their *conclusions* (e.g. "these 3 endpoints are the heartbeat") are durable app facts and should be **promoted** into `site.json` so the next session preloads instead of re-learning.
4. **site pack** (this dir) — the distilled, portable app knowledge that survives the session and hands off to automation or a future agent.
5. **framework + DECISIONS** — distilled *tool* competence, cross-app.

A single observation can split across homes: "OpenEMR renders reads via POST" became (a) the specific
read-POST families → `openemr/site.json`, (b) the prior "EHRs POST for reads, do a mark-read recon pass"
→ methodology, and (c) an open question about a better write-flag heuristic → `DECISIONS.md` (OPEN).
