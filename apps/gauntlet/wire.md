# gauntlet — wire map

Origin `http://localhost:4800` (main). A second origin `http://localhost:4801` serves the
cross-origin iframe only. All app data is JSON over fetch/XHR, plus one WebSocket, two SSE
streams, and long-poll endpoints. Bodies are cited by their `body_hash` prefix (from
`SELECT body_hash FROM requests`); `./disco body <prefix>` prints them.

## Static documents

| Method · Path | Carries | R/W | Notes |
|---|---|---|---|
| GET `/` | the SPA shell | R | `12b605e5d338` (5.9K). 302→`/login.html?next=/` when `ctl.requireAuth`. |
| GET `/style.css` | styles | R | `2a3bd7d123f5`. Positions of `.overlay` (fixed), `.toast`, `#ctx-menu` (fixed), `#rows`. |
| GET `/app.js` | the whole client | R | `b187749b6c87` (20.5K). **The app's logic is here** — read it to learn any behaviour. |
| GET `/iframe.html` | same-origin iframe | R | `eadfa92545d7`; contains nested `<iframe src="/iframe2.html">`. |
| GET `/iframe2.html` | depth-2 nested iframe | R | `766ff6b55b11`. |
| GET `/xframe.html` | cross-origin iframe body | R | `b6f03cd42a2c`; served from **:4801** (`state.xOrigin`). |
| GET `/child.html` | child popup | R | `f802643d54e0`; `window.open` target. |
| GET `/login.html?next=` | login form | R | `262685498079`; posts `/api/login`, then `location.href=next`. |
| GET `/secure.html` | protected page | R | `b774ee9bb194`; 302→login without the cookie; shows `Welcome, <user>`. |
| GET `/away.html` | "You navigated away" | R | `213ba5108e97`; beforeunload target for `#nav-away`. |

## Control plane (test knobs — not part of the app UI)

| Method · Path | Carries | R/W | Notes |
|---|---|---|---|
| GET `/ctl` | current knob state | R | `d8d884fd3750`. Defaults: `slowMs:400, modal:false, toastMs:2000, saveFails:false, ambient:false, heartbeatMs:5000, pollHoldMs:3000, wsPushMs:7000, timeoutMs:0, rerenderOnHover:true, requireAuth:false, notify:false, notifyPollHoldMs:25000, xOrigin:"http://localhost:4801"`. |
| POST `/ctl` | `{knob:value,…}` → new state | W | Merges knobs, returns full state. Also broadcasts `{type:"ctl",state}` over the WS. Special key `{push:"ws"\|"sse"\|"poll"}` injects one notification (see below). |
| POST `/ctl/reset` | defaults | W | Restores all knobs. |

## App data endpoints

| Method · Path | Carries | R/W | Body / notes |
|---|---|---|---|
| GET `/api/slow?ms=N` | `{ms,at}` | R | `f89de4d7bc5b`. Server delays ~`ms` (default `state.slowMs=400`). The slow arm of Load Chart. |
| GET `/api/chart/a` | `{series:"a",points:[1,3,2,5,4]}` | R | `e565556a7a19`. Fast. |
| GET `/api/chart/b` | `{series:"b",points:[2,2,3,1,6]}` | R | `89cf1590e155`. Fast. |
| GET `/api/record/{n}` | patient record | R | `311c996db007` (n=2). `{id,name,dob,mrn,allergies[]}`. n=1 Ada Lovelace/[Penicillin]; n=2 Alan Turing/[Penicillin,Latex]; n=5 Donald Knuth. |
| POST `/api/save` | `{id,pending:true,received}` | W | `acfec170c2c0`. **202 Accepted**, optimistic. Assigns an incrementing `id`. |
| GET `/api/save/status?id=N` | outcome | R | **200** ok / **500** when `ctl.saveFails`. **Body is `missing`** — the page reads only `r.ok`, so Chromium never hands the body over. Read the *status code*, not the body. |
| GET `/api/rows` | 10,000 rows | R | `70f7def94492` (485 KB). `[{id,name,group}]`. Rendered as a windowed list (~23 DOM nodes). |
| GET `/api/search?q=` | `{q,hits[]}` | R | `dc9bab08ca0c` (q=ada → ["Ada Lovelace"]). Debounced 250 ms, issued by **XHR**. Empty q → no request. |
| GET `/api/meds?q=` | `{q,hits[]}` | R | `4d5b401a3e4b` (q=as). Combobox suggestions; issued per keystroke. |
| GET `/api/grid` | `{rows,cols,cells[]}` | R | `8d63deae6960` (4×8). Rendered to `<canvas>` only. |
| DELETE `/api/item/1` | `{deleted:1}` | W | `78000dac3e34`. The Delete button. |
| POST `/api/iframe-submit` | `{name,depth?}` echo | W | same-origin (`c684c60a7be2`) and nested depth-2 (`1256a6b29e24`). |
| POST `/api/xframe-submit` | `{name}` echo | W | `dccbe4f9d790`. Issued from :4801 (relative URL inside the cross frame). |
| GET `/api/child-ping` | `{pong:true}` | R | Called by the child window. |
| POST `/api/graphql` | `{data,sawMutation,operation}` | R/W | `f74fd6f2f865` (query). `query{patient{name}}`→Ada Lovelace; `mutation{rename(name)}`→echoes name, `sawMutation:true`, **does not persist** (a later query still returns Ada). |
| POST `/api/drag-report` | slider/reorder result | W | `{widget:"slider",value}` or `{widget:"sort",order}`. Body `missing` (page never reads it). |
| POST `/api/login` | 200 + `Set-Cookie` | W | Accepts **any** `{user,pass}`. `Set-Cookie: gauntlet_auth=<user>; Path=/; HttpOnly`. |
| GET `/api/fake-stream` | XML envelope | R | `c46e5f2a155a`. **mime `text/event-stream` but a finite ordinary body** — captured fine (contrast the real SSE). Page reads `.text()`. |

## Push / ambient channels

| Method · Path | Kind | Notes |
|---|---|---|
| WS `/ws` | websocket | Opens on load. Server → `{type:"hello",id,state}`; then echoes each button click as `{type:"action",id}` → `{type:"echo",id,seq}`; `{type:"ctl",state}` on knob change; `{type:"notify",text}` on `push:"ws"`. `#noop` is the only button that does not send. Frames in `ws_frames`. |
| GET `/api/notify-sse` | eventsource | Standing SSE from load (`body_state: streaming`, not captured). Delivers `push:"sse"` notifications. |
| GET `/api/notify-poll` | fetch (long-poll) | `{n}` or `{n:null}`. Only looped when `ctl.notify=true`; held up to `notifyPollHoldMs`. Delivers `push:"poll"` notifications. |
| GET `/api/sse` | eventsource | On demand (`#start-sse`). 5 events ~500 ms apart then closes. `body_state: missing`; events land in the DOM. |
| GET `/api/heartbeat` | fetch | `{ok,n}`. Ambient only (`ctl.ambient`), every `heartbeatMs`. |
| GET `/api/poll` | fetch (long-poll) | `{…}`. Ambient only, reissued; held up to `pollHoldMs`. |

## Useful SQL

```sql
-- endpoint map for a run
SELECT method, path, count(*) n, min(status), max(status) FROM requests
 WHERE resource_type IN ('xhr','fetch') AND run=<n> GROUP BY 1,2 ORDER BY n DESC;
-- the WS conversation
SELECT t, dir, substr(payload,1,80) FROM ws_frames WHERE run=<n> ORDER BY seq;
-- who set the auth cookie
SELECT path, json_extract(resp_headers,'$."set-cookie"') FROM requests WHERE resp_headers LIKE '%set-cookie%';
-- the real save outcome (body is missing; status is truth)
SELECT path, status FROM requests WHERE path='/api/save/status' ORDER BY t_start DESC LIMIT 1;
```
