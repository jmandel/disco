# Demo 2 — agent-drive with act(): observation reports in practice (5 minutes)

Prereqs: gauntlet on :4800, a session attached with scope localhost:4800 (see demo 1, steps 1–3),
the page open in the browser.

1. `disco act click 'role=button[name="Load Chart"]'` — watch the verdict line: `settled:network`,
   the three attributed requests with body handles, and the settle timeline.
2. `disco act click '#noop'` — `no-effect` in well under a second: "nothing happened" learned cheaply.
3. `disco act click 'role=button[name="Missing"]'` — a diagnosis, not a timeout: near-matches,
   dialog census, pending requests, a screenshot handle.
4. `curl -X POST localhost:4800/ctl -d '{"modal":true}'` then
   `disco act click 'css=.record[data-id="1"]'` — the allergy dialog lands in the report
   (sentinel + UI delta); `disco act click '#modal-ack'` clears it.
5. `disco act type '#search' --text zeb` — settlement waits for the debounced trailing XHR.
6. `disco act rightclick '#ctx-target'` / `disco act dblclick '#dbl-target'` /
   `disco act drag '#slider-thumb' --to-dx 150 --to-dy 0` — pointer grammar beyond clicks.
7. `disco act click 'role=button[name="Load Rows"]' --eval "function(){ return document.querySelectorAll('#rows .row').length }"`
   — ~25 DOM rows rendered; then read the full 10k from the store:
   `disco sql "SELECT length(b.text) FROM requests r JOIN bodies b ON b.hash=r.body_hash WHERE r.path='/api/rows'"`
8. `disco tail` in a second terminal while you click around by hand — sentinels, settlements, and
   notable requests stream live.
