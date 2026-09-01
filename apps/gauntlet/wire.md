# gauntlet — the wire

Origins: **`http://localhost:4800`** (everything) and **`http://localhost:4801`** (the cross-origin
iframe only; its value is `ctl.xOrigin`). Bodies below are cited by their `body_hash` prefix —
`./disco body <prefix>` prints them.

## Control plane (not part of the app's UI — this is how the exam is configured)

| Endpoint | R/W | Carries |
|---|---|---|
| `GET /ctl` | read | the effective knob set, e.g. `d8d884fd3750`: `{"slowMs":400,"renderDelayMs":0,"modal":false,"modalDelayMs":0,"toastMs":2000,"saveFails":false,"ambient":false,"heartbeatMs":5000,"pollHoldMs":3000,"wsPushMs":7000,"timeoutMs":0,"rerenderOnHover":true,"requireAuth":false,"notifyPollHoldMs":25000,"notify":false,"xOrigin":"http://localhost:4801"}` |
| `POST /ctl` | write | a partial patch; returns the new effective set. `{"push":"ws"\|"sse"\|"poll"}` is a one-shot trigger, not a knob |
| `POST /ctl/reset` | write | restores the defaults above |

The page GETs `/ctl` on every load and prints it into `#ctl-state`; the WebSocket `hello` frame
carries it too. **Every "sometimes" behaviour in this app is one of these knobs — nothing is random.**

## Documents

| Endpoint | Carries |
|---|---|
| `GET /` | the whole shell, 6 KB, 27 `<section>`s, all ids literal (`12b605e5d338`). 302 → `/login.html?next=/` when `ctl.requireAuth` and no cookie |
| `GET /app.js` | 20.5 KB ES module — the entire client (`b187749b6c87`) |
| `GET /style.css`, `/iframe.html`, `/iframe2.html`, `/child.html`, `/away.html`, `/login.html`, `/secure.html` | static |
| `GET http://localhost:4801/xframe.html` | the cross-origin iframe document (`b6f03cd42a2c`) |

## Read endpoints

| Endpoint | Carries | Cited body |
|---|---|---|
| `GET /api/slow?ms=N` | resolves after `N` ms (`N` = `ctl.slowMs`) | `554db7361795` `{"ms":400,"at":…}` |
| `GET /api/chart/a`, `/api/chart/b` | one series each | `e565556a7a19` `{"series":"a","points":[1,3,2,5,4]}` |
| `GET /api/record/:id` (1‑5) | the record the form renders | `f0056a3f6602` `{"id":1,"name":"Ada Lovelace","dob":"1963-01-11","mrn":"MRN-0001","allergies":["Penicillin"]}` · `311c996db007` = record 2 |
| `GET /api/search?q=` | debounced search hits | `dc9bab08ca0c` `{"q":"ada","hits":["Ada Lovelace"]}` |
| `GET /api/meds?q=` | combobox suggestions, **not** debounced | `eed2f80b5a1e` (q=a, 14 hits) · `45f4839713a9` `{"q":"asp","hits":["Aspirin"]}` |
| `GET /api/rows` | **all 10 000 rows**, 484.7 KB — the virtualised table's only source of truth | `70f7def94492`, items `{"id":0,"name":"Aardvark-Row-0","group":"G0"}` |
| `GET /api/grid` | the canvas model the pixels are drawn from: `{"rows":4,"cols":8,"cells":[{"r","c","label"}…]}` | `8d63deae6960` |
| `GET /api/fake-stream` | mime `text/event-stream`, **finite** body → `body_state: ok` | `c46e5f2a155a` `<envelope><encounters><e id="1">complete payload behind a stream mime</e></encounters></envelope>` |
| `GET /api/heartbeat` | ambient only; `{"ok":true,"n":1}` | `27e1acbfee88` |
| `GET /api/poll` | ambient long-poll, holds `ctl.pollHoldMs` (3000) then reissues | `30718b5ee1bf` `{"n":3,"heldMs":3000}` |
| `GET /api/notify-poll` | push long-poll, holds `ctl.notifyPollHoldMs` (25000); only exists when `ctl.notify` | `8262681bc125` `{"n":7,"via":"poll","text":"Result 7 via poll"}` |
| `GET /api/notify-sse` | **endless** `text/event-stream`, opened on every load → `body_state: streaming`, `t_end` null, **messages never captured** | — |
| `GET /api/child-ping` | the popup's fetch | — |

## Write endpoints

| Endpoint | R/W | Carries |
|---|---|---|
| `POST /api/save` | write | req `{"form":{"name":"x"}}` → **202** `acfec170c2c0` `{"id":1,"pending":true,"received":{…}}`. `id` increments per process |
| `GET /api/save/status?id=N` | read | **the real outcome**: `200` = saved, `500` = failed (`ctl.saveFails`). The page never reads the body → `body_state` goes `pending` → `missing`. **Only the status code exists.** |
| `DELETE /api/item/1` | write | the app's only non-POST write; `78000dac3e34` `{"deleted":1}` |
| `POST /api/graphql` | both | req `{"query":"query { patient { name } }"}` → `f74fd6f2f865` `{"data":{"patient":{"name":"Ada Lovelace"}},"sawMutation":false,"operation":"query"}`; req `{"query":"mutation { rename(name: \"Renamed\") { name } }"}` → `7ac5cf5b514e` `{"data":{"rename":{"name":"Renamed"}},"sawMutation":true,"operation":"mutation"}`. Both are 200 — a GraphQL error would not be a 4xx |
| `POST /api/iframe-submit` | write | from the same-origin frame; `c684c60a7be2` `{"ok":true,"name":"Ada"}` |
| `POST /api/xframe-submit` | write | from the cross-origin frame, to **:4801**; `fe0036eb5b57` `{"ok":true,"name":"Grace","origin":"x"}` |
| `POST /api/drag-report` | write | fired on every mouse-up of section 26. `{"widget":"slider","value":43}` or `{"widget":"sort","order":"a,b,c"}`. **It fires even when the drag changed nothing** — the request is not evidence of a reorder |
| `POST /api/login` | write | req `{user,pass}`. **Any non-empty pair is accepted**; the response `{"ok":true,"user":"<user>"}` and `set-cookie: gauntlet_auth=<user>; Path=/; HttpOnly`. An empty field → **401** `{"ok":false,"error":"user and pass required"}` |

## WebSocket

One socket, opened on every page load, at the main origin. Frames seen:

| Direction | Payload |
|---|---|
| `in` (on open) | `{"type":"hello","id":<conn n>,"state":{…the whole ctl set…}}` |
| `out` | `{"type":"action","id":"<button id>","t":…}` — sent by every button click **except `#noop`** |
| `in` | `{"type":"echo","id":"<button id>","t":…,"seq":N}` — the server's echo; `seq` drives `#ws-count` |
| `in` | `{"type":"notify","n":4,"via":"ws","text":"Result 4 via ws"}` — a `POST /ctl {"push":"ws"}` delivery |

With `ctl.ambient` the server also pushes on its own every `ctl.wsPushMs` (7000).

## Auth

`ctl.requireAuth` turns `GET /` **and** `GET /secure.html` into `302 → /login.html?next=<path>`.
The cookie is `gauntlet_auth`, `HttpOnly` — `document.cookie` is empty, so read it from
`resp_headers` (`SELECT path, json_extract(resp_headers,'$."set-cookie"') FROM requests …`) or
`s.context.cookies()`. Clear it with `s.context.clearCookies()`.

## Useful queries

```sql
-- the endpoint map
SELECT method, path, count(*) n, min(status), max(status) FROM requests
 WHERE resource_type IN ('xhr','fetch') GROUP BY 1,2 ORDER BY n DESC;
-- what the app does with nobody driving it (ambient on)
SELECT t_start, method, path, status FROM requests WHERE action_id IS NULL AND run=? ORDER BY t_start;
-- the real outcome of a save
SELECT status FROM requests WHERE path='/api/save/status' AND action_id='act:N';
-- the login cookie
SELECT path, json_extract(resp_headers,'$."set-cookie"') FROM requests WHERE resp_headers LIKE '%set-cookie%';
```
