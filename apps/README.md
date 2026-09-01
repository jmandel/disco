# apps/

One folder per app you drive. The root README's **The app folder** section says what goes in it and why;
`apps/<app>/store/` is the log (gitignored), everything else is documentation and code you keep.

Starting a new app — the first hour:

1. `./disco open <app> <url>` (or `--attach <port>`), then `./disco sql "SELECT method, path, resource_type FROM requests WHERE run=(SELECT max(run) FROM runs)"` — what kind of app is it?
2. Look at the screen: `./disco aria` (the accessibility tree — control names and landmarks come for free; the HTML document of a SPA is an empty shell). `./disco sql "SELECT path, resource_type FROM requests WHERE resource_type IN ('xhr','fetch')"` for what it talks to.
3. One bare act per section; read the report; write the `until` you learned into `NOTES.md` with the act id.
4. When a workflow holds up twice, move it into `lib.ts` with `reached()` on every step, and a step in `check.ts`.
5. `node scripts/run-check.ts <app>` — warm, then after `./disco close <app>` cold. Both green before you write the README.
