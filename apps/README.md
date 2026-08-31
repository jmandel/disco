# apps/ — the per-product packs

This directory is **Layer 2** (see `PLATFORM.md`): one subdir per system we explore, `apps/<target>/`.
A pack is **not a template** — it's a loose home that accretes whatever *ways of knowing* the product
needs. Packs differ on purpose (`gauntlet/` is function/script-heavy; `openemr/` is understanding-heavy,
partial). The other two homes for knowledge live elsewhere: truths about the **tool** → `src/` +
`DECISIONS.md`; truths about the **class / the craft** → the methodology & usage docs (`GUIDANCE.md`,
and the usage guides). One observation can split across all three (see the promotion path below).

## Ways of knowing a pack can hold (take any subset)

1. **Raw debug sessions** — the captured store(s) + blobs. *Empirical, retroactively re-queryable* — you can ask new questions of an old run. (In `apps/<target>/store/`, run-tagged; every run of the app lands in the same history.)
2. **Ledger / notes** — observed-vs-inferred, variability with n-counts, open questions + the probe that resolves each. *Interpreted, with confidence and honest unknowns.* (`nav-and-quirks.md` narrative + `ledger.md`.)
3. **Navigation notes** — how to drive it, the rough edges, how to recover, and the **known anchor points** workflows start from. *Explanatory — for a human or agent to read in.*
4. **A function library** — plain TypeScript: job-specific, robust functions that navigate to anchor states and perform specific steps (`login`, `openPatient(pid)`, `goToProblemList`, …). Composable, decomposed/refined over time. **The growing asset** — and the future basis for MCP/agent tools and for automated test loops that run over them. The engineering goes into *robustness*, not file format; they're just `.ts` files.
5. **Evidence** — screenshots, reports, cited act ids / store cursors. *Provenance — every claim points back to what was observed.*

Optional and un-fancy: a pack *may* keep a small machine-readable hints file, but that's a convenience,
not a required shape — such knowledge is usually better expressed as functions (#4) + notes (#3). (The
OpenEMR pack started with a `site.json` and then folded it into `lib.ts` + `nav-and-quirks.md`, which is
the expected direction.)

## The current instances

- **`gauntlet/`** — instance #1, the synthetic app (our known-answer control). `nav-and-quirks.md`, `ledger.md`, `friction.md`, `scripts/` (early functions, as standalone runnables — will lift toward composable importable functions).
- **`openemr/`** — instance #2, OpenEMR 8.3.0 demo. `lib.ts` (function library: `login`/`findPatient`/`openPatient`/`extractSummary`, anchor-oriented, wire-first, defensive), `check.ts` (live drift loop), `nav-and-quirks.md`, `ledger.md`, `dogfood-1.md`, `screenshots/`.

- **`saucedemo/`** — instance #3, Sauce Labs "Swag Labs" (a client-rendered React SPA, **no data API**). `lib.ts` (login / listProducts / addToCart / openCart / checkout / logout / resetAppState — DOM-first, every transition with its `until`), `check.ts` (15 steps incl. the locked-out refusal and `performance_glitch_user`), `nav-and-quirks.md`, `ledger.md`, `friction-rebuild.md`. **Rebuilt from the docs alone by a fresh agent in 14 minutes** (DECISIONS #41) — it proves the Layer-1 layer generalizes past wire-rich apps (`lib/nav` only, no `lib/wire`).
- **`openmrs/`** — instance #4, OpenMRS O3 reference application (an EHR-class React SPA over REST + FHIR, on `dev3.openmrs.org`; `o3.` is Cloudflare-gated). `lib.ts` (rules registration / login with a present-or-absent location picker / findPatient off the REST search body, paging past page 1 / openPatient to the chart anchor / openSection / extractSummary from FHIR `Condition`, `AllergyIntolerance`, `Observation` + REST `order` / listVisits / recoverToShell), `check.ts` (12 steps), `nav-and-quirks.md`, `ledger.md`, **`wire.md`** (where the facts live), `friction.md`, `screenshots/`. First built from the docs alone by a fresh agent in 20 minutes (DECISIONS #42), then **rebuilt by a second stranger from `prompts/characterize-ehr.md` in 26 minutes with the fixed tool** — the deeper pack that lives here (DECISIONS #45).

## The promotion path (raw → durable)

1. **store** (`apps/<target>/store/`) — empirical ground truth; nothing is "known" that isn't recorded here.
2. **notes/ledger** (`disco note`) — interpretations, cited to act ids, with confidence.
3. **in-session learned models** (ambient classifier, DOM-churn roots, visual ignore mask) — learned *during* the run, then thrown away. Their *conclusions* (e.g. "these 3 endpoints are the heartbeat") are durable product facts → promote them into the pack (as functions/notes) so the next session confirms instead of re-learning.
4. **the pack** (this dir) — the distilled, portable product knowledge that survives the run.
5. **framework + DECISIONS** — distilled *tool* competence, cross-product.

A single observation splits by altitude: "OpenEMR renders reads via POST" became (a) the specific
read-POST families → the OpenEMR pack, (b) the prior "EHRs POST for reads, do a mark-read recon pass" →
the methodology (`GUIDANCE.md §8`), and (c) an open question about a better write-flag heuristic →
`DECISIONS.md` (OPEN).
