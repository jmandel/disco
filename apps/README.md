# apps/ — one folder per app

An app folder is **documentation plus code**. Two files are special because tools run them; everything else
is markdown you organize however helps. The shape — grow into it; **any subset is a legitimate state**:

```
apps/<app>/
  NOTES.md     ← the accumulator: `disco note` appends here (run-headed, act ids inline). Raw, chronological, committed.
  README.md    ← the distilled doc: what this app is, how to drive it, what you know, what varies, what is open.
  lib.ts       ← the driving code, once flows are worth packaging (anchor in → anchor out, `until` on every transition).
  check.ts     ← the live check once lib.ts exists: `export const target = { url, scope }` (+ optional `ready`)
                 and `check(s)`; `bun scripts/run-check.ts <app>` runs it.
  wire.md      ← where the facts live on the wire: endpoint family → what it carries, read/write, standing channels.
  friction.md  ← where the tool or docs got in your way — feedback to disco, briefly and bluntly.
  store/       ← the recording (gitignored, run-tagged, machine-managed) — everything observed, re-queryable forever.
  …plus anything else that helps (screenshots/ with cited shots, etc.).
```

## The habit: accumulate, then distill

1. **If it is not in a committed file, it does not exist tomorrow.** The store is gitignored scratch;
   `disco note` already lands in NOTES.md, so the raw trail survives by default.
2. **Cite evidence** (`act:N`) so claims can be re-checked; mark guesses as guesses.
3. **Distill whenever something has earned it** — no phase, no ceremony: a note that became understanding
   moves into README.md (or wire.md when it is a wire fact); a routine becomes a lib.ts function; a function
   that matters gets a check.ts step; a tool gripe goes to friction.md.

Truths about the **tool** go to `src/` + `DECISIONS.md`; truths about the **class** of app go to
`GUIDANCE.md` and the usage docs. One observation can split across all three.

## The current instances

- **`gauntlet/`** — instance #1, the synthetic app (our known-answer control). `lib.ts` (20 functions: shell/anchors, `loadChart`, `openRecord` with the delayed modal both ways, `loadRows`/`findRow` off the 10k-row body, `save` verified on the wire, `deleteItem`, `search`, `selectMedication` (the keyboard recipe), `openSecureArea` through the auth 302, GraphQL query/mutation, SSE, `setScenario`/`getScenario` over the `/ctl` control plane, `waitForPush` on each standing channel, `readCanvasGrid`), `check.ts` (25 steps), `nav-and-quirks.md` (33-row transition table), `ledger.md`, `wire.md`, `screenshots/`, `friction.md`, plus the original dry-run's `friction-dryrun.md` and `scripts/`. **Characterized as an unknown app by a stranger from `prompts/characterize-app.md` in 15m37s** (DECISIONS #46).
- **`openemr/`** — instance #2, OpenEMR 8.3.0 demo. `lib.ts` (function library: `login`/`findPatient`/`openPatient`/`extractSummary`, anchor-oriented, wire-first, defensive), `check.ts` (live drift loop), `nav-and-quirks.md`, `ledger.md`, `dogfood-1.md`, `screenshots/`.

- **`saucedemo/`** — instance #3, Sauce Labs "Swag Labs" (a client-rendered React SPA, **no data API**). `lib.ts` (login / listProducts / addToCart / openCart / checkout / logout / resetAppState — DOM-first, every transition with its `until`), `check.ts` (15 steps incl. the locked-out refusal and `performance_glitch_user`), `nav-and-quirks.md`, `ledger.md`, `friction-rebuild.md`. **Rebuilt from the docs alone by a fresh agent in 14 minutes** (DECISIONS #41) — it proves the Layer-1 layer generalizes past wire-rich apps (`lib/nav` only, no `lib/wire`).
- **`openmrs/`** — instance #4, OpenMRS O3 reference application (an EHR-class React SPA over REST + FHIR, on `dev3.openmrs.org`; `o3.` is Cloudflare-gated). `lib.ts` (rules registration / login with a present-or-absent location picker / findPatient off the REST search body, paging past page 1 / openPatient to the chart anchor / openSection / extractSummary from FHIR `Condition`, `AllergyIntolerance`, `Observation` + REST `order` / listVisits / recoverToShell), `check.ts` (12 steps), `nav-and-quirks.md`, `ledger.md`, **`wire.md`** (where the facts live), `friction.md`, `screenshots/`. First built from the docs alone by a fresh agent in 20 minutes (DECISIONS #42), then **rebuilt by a second stranger from `prompts/characterize-ehr.md` in 26 minutes with the fixed tool** — the deeper pack that lives here (DECISIONS #45).
The packs above predate this simplified shape; their extra files (nav-and-quirks.md, ledger.md) stand as
splits that earned their place — read them as such, not as requirements.
