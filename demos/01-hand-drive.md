# Demo 1 — hand-drive the gauntlet, then interrogate the store (5 minutes)

1. `bun gauntlet` (leave running; note the printed origin, assume :4800)
2. `curl -X POST localhost:4800/ctl -d '{"ambient":true}'` (a livelier ambient profile: heartbeat + long-poll), then
   `chromium --remote-debugging-port=9222 --user-data-dir=$HOME/.cache/disco-demo http://localhost:4800 &`
   — the app must be OPEN before the next step, or the idle observation has nothing to learn from.
3. `bun cli/disco.ts session new gauntlet --attach 9222 --scope localhost:4800    # → apps/gauntlet/store/`
   (it idle-observes the open page for 30s: watch the heartbeat and the poll come out tagged `ambient`)
4. In the browser, drive BY HAND for ~2 minutes:
   click **Load Chart**, open a record, **Save**, type in **Search…**, **Load Rows** and scroll,
   click the canvas grid, open the child window, let the toast come and go.
5. `bun cli/disco.ts session end gauntlet` — the daemon is now gone. Everything below is plain SQLite (the app's whole history, run-tagged).
6. Every request with status+size:
   `bun cli/disco.ts sql gauntlet "SELECT method, path, status, resp_size, attribution FROM requests WHERE run=(SELECT max(run) FROM runs) ORDER BY t_start"`
   (the store holds EVERY run of this app and `t` restarts per run — filter on `run` or the runs interleave)
7. The full 10k-row response body (never fully rendered):
   `bun cli/disco.ts sql gauntlet "SELECT b.size, length(b.text) FROM requests r JOIN bodies b ON b.hash=r.body_hash WHERE r.path='/api/rows' AND r.run=(SELECT max(run) FROM runs)"`
8. Did `Zebra-Row-9741` ever appear anywhere? (FTS over bodies — it was never on screen)
   `bun cli/disco.ts sql gauntlet "SELECT r.path FROM bodies b JOIN bodies_fts f ON f.rowid=b.rowid JOIN requests r ON r.body_hash=b.hash WHERE bodies_fts MATCH '\"Zebra-Row-9741\"'"`
9. The screenshot nearest the toast:
   `bun cli/disco.ts sql gauntlet "SELECT t, detail, shot FROM sentinels WHERE name='toast' AND run=(SELECT max(run) FROM runs)"` (cells are cut at 60 chars — `--json` for the full hash; `blob` takes any prefix)
   then `bun cli/disco.ts blob <shot-hash-or-prefix> --out /tmp/toast.jpg --app gauntlet`
10. Every WS frame in order:
    `bun cli/disco.ts sql gauntlet "SELECT t, dir, substr(payload,1,60) FROM ws_frames WHERE run=(SELECT max(run) FROM runs) ORDER BY t"`
