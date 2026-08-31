# Demo 1 — hand-drive the gauntlet, then interrogate the store (5 minutes)

1. `bun gauntlet` (leave running; note the printed origin, assume :4800)
2. `chromium --remote-debugging-port=9222 --user-data-dir=$HOME/.cache/disco-demo &`
3. `bun cli/disco.ts session new gauntlet --attach 9222 --scope localhost:4800    # → apps/gauntlet/store/`
   (it idle-observes ~20s; enable ambient traffic first for a livelier profile:
   `curl -X POST localhost:4800/ctl -d '{"ambient":true}'`)
4. In the browser, open http://localhost:4800 and drive BY HAND for ~2 minutes:
   click **Load Chart**, open a record, **Save**, type in **Search…**, **Load Rows** and scroll,
   click the canvas grid, open the child window, let the toast come and go.
5. `bun cli/disco.ts session end gauntlet` — the daemon is now gone. Everything below is plain SQLite (the app's whole history, run-tagged).
6. Every request with status+size:
   `bun cli/disco.ts sql "SELECT method, path, status, resp_size, attribution FROM requests ORDER BY t_start" --app gauntlet`
7. The full 10k-row response body (never fully rendered):
   `bun cli/disco.ts sql "SELECT b.size, length(b.text) FROM requests r JOIN bodies b ON b.hash=r.body_hash WHERE r.path='/api/rows'" --app gauntlet`
8. Did `Zebra-Row-9741` ever appear anywhere? (FTS over bodies — it was never on screen)
   `bun cli/disco.ts sql "SELECT r.path FROM bodies b JOIN bodies_fts f ON f.rowid=b.rowid JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH '\"Zebra-Row-9741\"'" --app gauntlet`
9. The screenshot nearest the toast:
   `bun cli/disco.ts sql "SELECT t, detail, shot FROM sentinels WHERE name='toast'" --app gauntlet`
   then `bun cli/disco.ts blob <shot-hash> --out toast.jpg --app gauntlet`
10. Every WS frame in order:
    `bun cli/disco.ts sql "SELECT t, dir, substr(payload,1,60) FROM ws_frames ORDER BY t" --app gauntlet`
