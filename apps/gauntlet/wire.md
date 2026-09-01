# gauntlet — wire

Main origin `http://localhost:4800`; a second **x-origin** `http://localhost:4801` serves only the
cross-origin iframe (`/xframe.html`) and its `/api/xframe-submit`. All bodies are JSON unless noted.
Hashes are body-hash prefixes; `./disco body <hash>` prints the captured body.

## Control plane (not part of the app UI)

| Endpoint | R/W | Carries |
|---|---|---|
| `GET /ctl` | R | the effective knob state (see below). body `d8d884fd3750` |
| `POST /ctl` | W | merge a partial knob patch; also `{push:"ws"\|"sse"\|"poll"}` to fire one notification. Returns the new full state |
| `POST /ctl/reset` | W | restore all knobs to defaults |

Default `/ctl` state:
```json
{"slowMs":400,"renderDelayMs":0,"modal":false,"modalDelayMs":0,"toastMs":2000,"saveFails":false,
 "ambient":false,"heartbeatMs":5000,"pollHoldMs":3000,"wsPushMs":7000,"timeoutMs":0,
 "rerenderOnHover":true,"requireAuth":false,"notifyPollHoldMs":25000,"notify":false,
 "xOrigin":"http://localhost:4801"}
```

## Documents

| Path | Carries |
|---|---|
| `GET /` | the whole app shell (`12b605e5d338`, ~6 KB). Sections `s-1`..`s-28`. |
| `GET /style.css`, `GET /app.js` | styles + the entire client (`b187749b6c87`, ~21 KB) |
| `GET /iframe.html` | same-origin iframe (`eadfa92545d7`); posts `/api/iframe-submit` |
| `GET /iframe2.html` | nested-in-same-origin iframe (`766ff6b55b11`); ids `#deep-name`/`#deep-submit` |
| `GET /xframe.html` | cross-origin iframe (`b6f03cd42a2c`, served on :4801) |
| `GET /child.html` | the child window (`f802643d54e0`); button GETs `/api/child-ping` |
| `GET /login.html` | login form (`262685498079aee3`); `#user`/`#pass`/`#login` |
| `GET /secure.html` | 302 to `/login.html?next=/secure.html` without cookie; else the "Secure area" page (`79132cd29461`) |

## Read endpoints (GET, fetch/xhr)

| Path | Carries | Sample body |
|---|---|---|
| `GET /api/slow?ms=<slowMs>` | the slow arm of Load Chart; waits `slowMs` | `{"ms":400,"at":...}` `70062ad142a788e0` |
| `GET /api/chart/a`, `/api/chart/b` | the two fast arms | `e565556a7a19d14c`, `89cf1590e155f464` |
| `GET /api/record/<1..5>` | a patient record | `{"id":1,"name":"Ada Lovelace","dob":"1963-01-11","mrn":"MRN-0001","allergies":["Penicillin"]}` `f0056a3f6602a21d` |
| `GET /api/save/status?id=N` | the async save outcome: `200 {"id":N,"ok":true}` or `500 {"id":N,"ok":false,"error":"write failed"}` (when `saveFails`) | **body never captured** — the client checks `Response.ok` and never reads it, so disco leaves it `body_state=pending`. Verified via direct fetch. |
| `GET /api/search?q=<q>` | debounced (250 ms) search hits (resource_type **xhr**) | `{"q":"ali","hits":["Silvio Micali"]}` `eafa8cf17ecc30b8` |
| `GET /api/meds?q=<q>` | combobox suggestions | `{"q":"as","hits":["Atorvastatin","Aspirin","Montelukast","Simvastatin"]}` `4d5b401a3e4b2646` |
| `GET /api/rows` | 10000 virtual-list rows, ~496 KB | `[{"id":0,"name":"Aardvark-Row-0","group":...},...]` `70f7def944928d5d` |
| `GET /api/grid` | canvas grid data (4×8 cells) — fired on every page load | `{"rows":4,"cols":8,"cells":[...]}` `8d63deae6960` |
| `GET /api/child-ping` | child-window ping | `{"pong":true}` `3874e63167becc35` |
| `GET /api/heartbeat` | ambient heartbeat (only when `ambient`) | small JSON |
| `GET /api/poll` | ambient reissuing long-poll (holds `pollHoldMs`, only when `ambient`) | small JSON |
| `GET /api/fake-stream` | **mime `text/event-stream` but an ordinary body** the client reads with `.text()` | `<envelope><encounters><e id="1">complete payload behind a stream mime</e></encounters></envelope>` `c46e5f2a155ae0db` |

## Streams / push channels

| Path | Kind | Carries |
|---|---|---|
| `GET /api/sse` | eventsource | 5 events then closes (section 19). `body_state=streaming/missing`, not captured. |
| `GET /api/notify-sse` | eventsource | standing notify channel, opened on every page load. `push:"sse"` delivers here. |
| `GET /api/notify-poll` | fetch long-poll | notify channel that runs **only when `notify:true`** (holds `notifyPollHoldMs`, default 25 s). `push:"poll"` delivers here. |
| WebSocket `/` (implicit) | websocket | opened on load. `hello` frame carries full ctl state; each wired button click sends `{type:"action",id:<btnId>}` and the server echoes `{type:"echo",id,seq}`. `push:"ws"` delivers `{type:"notify",n,via:"ws",text:"Result N via ws"}`. `#noop` is the one button that is **not** wired. |

## Write endpoints (POST/DELETE)

| Path | R/W | Carries |
|---|---|---|
| `POST /api/save` | W | `202 {"id":N,"pending":true,"received":{"form":{"name":"x"}}}` `acfec170c2c0`. Outcome is fetched separately from `/api/save/status`. |
| `DELETE /api/item/1` | W | `{"deleted":1}` `78000dac3e3426f0` |
| `POST /api/graphql` | W | GraphQL over a single POST. Query -> `{"data":{"patient":{"name":"Ada Lovelace"}},"sawMutation":false,"operation":"query"}` `f74fd6f2f865ddcc`; mutation -> `{"data":{"rename":{"name":"Renamed"}},"sawMutation":true,"operation":"mutation"}` `7ac5cf5b514eb10f` |
| `POST /api/login` | W | `{user,pass}` -> any non-empty pair `200 {"ok":true,"user":"<user>"}` + `Set-Cookie: gauntlet_auth=<user>; Path=/; HttpOnly`; empty -> `401 {"ok":false,"error":"user and pass required"}` |
| `POST /api/iframe-submit` | W | same-origin iframe submit -> `{"ok":true,"name":"Ada"}` `c684c60a7be2` |
| `POST /api/xframe-submit` | W | cross-origin iframe submit — posts to **:4801** (relative URL inside the cross-origin frame) |
| `POST /api/drag-report` | W | slider/reorder result: `{"widget":"slider","value":61}` or `{"widget":"sort","order":"b,c,a"}` |

## Auth

Cookie **`gauntlet_auth`** (HttpOnly, `Path=/`). Set by `POST /api/login`; its value is the username.
When `requireAuth`, `GET /secure.html` without the cookie 302-redirects to `/login.html?next=/secure.html`.
