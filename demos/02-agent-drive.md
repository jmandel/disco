# Demo 2 — agent-drive with act(): observation reports in practice (5 minutes)

Prereqs: gauntlet on :4800, a session attached with scope localhost:4800 (see demo 1, steps 1–3),
the page open in the browser. (`disco` = `bun cli/disco.ts`.)

1. `disco act click 'role=button[name="Load Chart"]'` — watch the verdict line: `settled:network`,
   the three attributed requests with body handles, the settle timeline, and the **timing** line (page
   time vs daemon overhead).
2. `disco act click '#noop'` — `no-effect` in well under a second: "nothing happened" learned cheaply.
3. `disco act click 'role=button[name="Missing"]'` — a diagnosis, not a timeout: near-matches,
   dialog census, pending requests, a screenshot handle.
4. **Settled ≠ ready.** `curl -X POST localhost:4800/ctl -d '{"renderDelayMs":900}'` then
   `disco act click '#load-chart' --eval "() => document.querySelector('#chart-status').textContent"` —
   `settled:network` while `eval` still says "loading…". Now the same with the postcondition on it:
   `disco act click '#load-chart' --until-fn "() => document.querySelector('#chart-status').textContent === 'idle'"` —
   `✓ until: matched in ~1000ms`, and `eval`/post-state read "idle". Reset: `curl -X POST localhost:4800/ctl -d '{"renderDelayMs":0}'`.
5. **Optimistic UI.** `disco act click '#save' --until-url /api/save/status --until-landed` — the screen
   said "Saved ✓" at once; the report carries `POST /api/save → 202 ✎write` *and* the later
   `GET /api/save/status → 200` attributed to this click, plus the toast sentinel.
6. `curl -X POST localhost:4800/ctl -d '{"modal":true,"modalDelayMs":400}'` then
   `disco act click '#record-1' --until-url /api/record/1 --until-landed`, wait a beat, then
   `disco act click '#record-2'` — `diagnosis: occluded by <div role="dialog" id="record-modal" …>`; the
   report names the blocker. `disco act click '#modal-ack'` clears it.
7. `disco act type '#search' --text zeb` — settlement waits for the debounced trailing XHR;
   `disco act fill '#search' --text ada` — `fill` replaces the value (real key events, `""` clears).
8. `disco act rightclick '#ctx-target'` / `disco act dblclick '#dbl-target'` /
   `disco act drag '#slider-thumb' --to-dx 150 --to-dy 0` — pointer grammar beyond clicks.
9. `disco act click 'role=button[name="Load Rows"]' --until-url /api/rows --until-landed --eval "function(){ return document.querySelectorAll('#rows .row').length }"`
   — ~25 DOM rows rendered; then read the full 10k from the store:
   `disco sql "SELECT length(b.text) FROM requests r JOIN bodies b ON b.hash=r.body_hash WHERE r.path='/api/rows'"`
10. `disco tail` in a second terminal while you click around by hand — sentinels, settlements (with
    `until` outcomes), and notable requests stream live. `bun scripts/timing-report.ts gauntlet` afterwards
    prints where the milliseconds went across everything you just did.

The library form of steps 4–6, with real output, is `bun demos/03-two-questions.ts`.
