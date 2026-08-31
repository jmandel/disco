# prompts/ — reusable agent prompts

Parameterized prompts for jobs this repository is built to do. Fill the `{{…}}` fields and hand the text to a
fresh agent (a Claude Code `Agent`, or a new session) with the repo checked out, `bun install` done and
Chromium available. They are written for *doing the job well*, not for testing disco; when the tool gets in
the way, the agent notes it briefly and routes around it.

| prompt | job | provenance |
|---|---|---|
| `characterize-ehr.md` | characterize an EHR you have never seen and leave a pack (`nav-and-quirks`, `ledger`, `wire`, `lib.ts`, `check.ts`, screenshots, brief friction) | distilled from the P4-B run that built `apps/openmrs/` from the docs alone in 20 minutes (DECISIONS #42), plus GUIDANCE §7–9 |

Conventions: one agent, one product, one pack under `apps/<pack>/`; zero sleeps; every transition carries its
postcondition (`until`); facts off the wire where they are wire-available; observed vs inferred explicit;
every claim cites an act id; the write footprint is declared and the stance respected.
