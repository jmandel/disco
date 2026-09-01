# gauntlet — the wire

Two origins. **Main** `http://localhost:4800` serves the shell, the app code and everything under
`/api/*`. **x-origin** `http://localhost:4801` serves only the cross-origin iframe and its own
`/api/xframe-submit` (the value is in `GET /ctl` as `xOrigin`, and on screen in `#x-origin`).

All bodies below are cited by `body_hash` prefix; print one with `./disco body <hash>`.
Statuses/mimes come from `SELECT method, path, status, mime, body_state FROM requests`.

## Documents

| Method | Path | Carries |
|---|---|---|
| GET | `/` | the whole app shell, one page, sections `#s-1 … #s-28` — `12b605e5d338` |
| GET | `/app.js` | the client (ES module, ~20 KB) — `b187749b6c87` |
| GET | `/style.css` | — `2a3bd7d123f5` |
| GET | `/iframe.html` | same-origin frame, itself embedding `/iframe2.html` — `eadfa92545d7` |
| GET | `/iframe2.html` | depth-2 frame ("depth-2 island") — `766ff6b55b11` |
| GET | `http://localhost:4801/xframe.html` | cross-origin frame — `b6f03cd42a2c` |
| GET | `/child.html` | the child window — `f802643d54e0` |
| GET | `/away.html` | the beforeunload destination — `213ba5108e97` |
| GET | `/login.html?next=<path>` | login form; posts `/api/login`, then `location.href = next` — `262685498079` |
| GET | `/secure.html` | 200 with the cookie (`f2e4054b413c`), **302 → `/login.html?next=/secure.html` without it** |

## Read endpoints

| Method | Path | Carries | Body |
|---|---|---|---|
| GET | `/ctl` | the whole knob set; fetched by the page on load and shown in `#ctl-state` | `d8d884fd3750` (defaults) |
| GET | `/api/grid` | `{rows:4, cols:8, cells:[{r,c,label}]}` — the seed for the canvas | `8d63deae6960` |
| GET | `/api/slow?ms=<slowMs>` | `{"ms":400,"at":<epoch>}` — the deliberately slow leg of section 1 | `8ddec09c4889` |
| GET | `/api/chart/a` | `{"series":"a","points":[1,3,2,5,4]}` | `e565556a7a19` |
| GET | `/api/chart/b` | `{"series":"b","points":[2,2,3,1,6]}` | `89cf1590e155` |
| GET | `/api/record/<id>` | `{id,name,dob,mrn,allergies:[…]}`, ids 1–5, deterministic | `f0056a3f6602` (1), `311c996db007` (2) |
| GET | `/api/search?q=` | `{"q":"ada","hits":["Ada Lovelace"]}` — debounced 250 ms | `dc9bab08ca0c` |
| GET | `/api/meds?q=` | `{"q":"as","hits":[…]}` — **subsequence** match, not prefix | `4d5b401a3e4b` |
| GET | `/api/rows` | a bare JSON **array of 10 000** `{id,name,group}` — 484.7 KB, fully captured | `70f7def94492` |
| GET | `/api/fake-stream` | `text/event-stream` mime, ordinary finite body: `<envelope>…</envelope>`, 97 chars | `c46e5f2a155a` |
| GET | `/api/child-ping` | `{"pong":true}` — issued by the child *window*, still in this log | `3874e63167be` |
| GET | `/api/heartbeat` | `{"ok":true,"n":5}` — ambient, every `heartbeatMs` | `ec284f947ac5` |

## Write endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/save` | `{"form":{"name":"x"}}` | **202** `{"id":N,"pending":true,"received":{…}}` — `acfec170c2c0` |
| GET | `/api/save/status?id=N` | — | **200** when the save worked, **500** when `ctl.saveFails`. The page never reads this body, so the row is `body_state: pending/missing` — the status code is the whole signal |
| DELETE | `/api/item/1` | — | `{"deleted":1}` — `78000dac3e34` |
| POST | `/api/graphql` | `{"query":"query { patient { name } }"}` / `{"query":"mutation { rename(name: \"Renamed\") { name } }"}` | `{"data":…,"sawMutation":false|true,"operation":"query"|"mutation"}` — `f74fd6f2f865`, `7ac5cf5b514e`. **One path for both** — the operation lives in `requests.req_body` |
| POST | `/api/iframe-submit` | `{"name":"Grace"}` (or `{"name":…,"depth":2}` from the depth-2 frame) | `{"ok":true,"name":"Grace"}` — `8329910c8a17` |
| POST | `http://localhost:4801/api/xframe-submit` | `{"name":"Kate"}` | `{"ok":true,"name":"Kate","origin":"x"}` — `2870e1b6385c` |
| POST | `/api/drag-report` | `{"widget":"sort","order":"b,c,a"}` — fired on every drop | body never read by the page |
| POST | `/api/login` | `{"user":"demo","pass":"anything"}` | **200 for any credentials**, `set-cookie: gauntlet_auth=<user>; Path=/; HttpOnly` — `540dd9686b29`. The login page checks only `r.ok` |

## Push channels (section 23)

Trigger any of them with `POST /ctl {"push":"ws"|"sse"|"poll"}`. Each delivers one notification;
`#notif-count` increments and `#notif-list` gains `Result N via <channel>`.

| Channel | Transport | In the log |
|---|---|---|
| ws | the standing WebSocket, open from page load | `ws_frames` — `{"type":"notify","n":1,"via":"ws","text":"Result 1 via ws"}` |
| sse | standing `GET /api/notify-sse` (`text/event-stream`, opened on load) | the request row only, `body_state: streaming`; **the messages are not captured** — read the DOM |
| poll | long-poll `GET /api/notify-poll`, held `notifyPollHoldMs` then reissued | full body captured: `{"n":7,"via":"poll","text":"Result 7 via poll"}` — `8262681bc125` |

The poll channel **only exists when `ctl.notify` is true**, and the page reads that knob at load —
so `{"push":"poll"}` on a default page is silently dropped (a 30 s wait taught me this).

## Streams

| Path | Behaviour |
|---|---|
| `GET /api/sse` | started by `#start-sse`; 5 events ~500 ms apart, then the server closes. `body_state` goes `streaming` → `missing`; the messages appear only as `<li>` in `#sse-log` |
| `GET /api/notify-sse` | standing, never ends: `body_state: streaming` for the life of the page |
| `GET /api/poll` | ambient long-poll, `{"n":9,"heldMs":400}` — `e2ff20fa1b51` |

## WebSocket

One socket, opened on page load, reconnecting on every navigation (`#ws-status`, `#ws-count`, `#ws-last`).

- **in**, on connect: `{"type":"hello","id":N,"state":{…the whole ctl set…}}`
- **in**, ambient: a push every `wsPushMs` when `ctl.ambient`
- **in**, on demand: `{"type":"notify","n":N,"via":"ws","text":"Result N via ws"}`
- **out**, on every button click **except `#noop`**: `{"type":"action","id":"<element id>","t":<epoch ms>}`

```sql
SELECT dir, payload FROM ws_frames WHERE dir='out' ORDER BY t DESC LIMIT 5;
```

## The control plane

```
GET  /ctl          → the effective knobs
POST /ctl  {…}     → merge, returns the effective knobs   (also accepts {"push":"ws"|"sse"|"poll"})
POST /ctl/reset    → back to the defaults below
```

```json
{"slowMs":400,"renderDelayMs":0,"modal":false,"modalDelayMs":0,"toastMs":2000,"saveFails":false,
 "ambient":false,"heartbeatMs":5000,"pollHoldMs":3000,"wsPushMs":7000,"timeoutMs":0,
 "rerenderOnHover":true,"requireAuth":false,"notifyPollHoldMs":25000,"notify":false,
 "xOrigin":"http://localhost:4801"}
```

Server-side knobs take effect immediately (`slowMs`, `saveFails`, `modal`, `modalDelayMs`, `toastMs`,
`requireAuth`, `push`). Client-side knobs are read once at page load and need a reload:
`ambient`, `heartbeatMs`, `pollHoldMs`, `wsPushMs`, `timeoutMs`, `notify`, `notifyPollHoldMs`,
`renderDelayMs`. `#ctl-state` in the header shows what the *page* currently believes.

## Useful queries

```sql
-- the endpoint map
SELECT method, path, count(*) n, min(status), max(status) FROM requests
WHERE path LIKE '/api/%' GROUP BY 1,2 ORDER BY n DESC;
-- what fired on its own (ambient traffic)
SELECT t_start, method, path, status FROM requests WHERE action_id IS NULL ORDER BY t_start DESC LIMIT 20;
-- did this save actually work?
SELECT status FROM requests WHERE path='/api/save/status' ORDER BY t_start DESC LIMIT 1;
-- which GraphQL operation was that?
SELECT req_body, status FROM requests WHERE path='/api/graphql' ORDER BY t_start DESC LIMIT 2;
-- the auth cookie
SELECT path, json_extract(resp_headers,'$."set-cookie"') FROM requests WHERE path='/api/login';
```
