-- disco session store. Source of truth; evolves freely (BRIEF §6.4). Read this file (or `.schema`)
-- at the start of a session and write SQL directly — there is no API layer in front of it.
-- Clock: every `t` is milliseconds since the session's epoch anchor (session.anchor_epoch_ms), monotonic.
-- Handles in reports: action ids `act:<n>`, event seq `ev:<n>`, blobs by sha256 hex, requests by `id`.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS runs (
  run INTEGER PRIMARY KEY,            -- exploration episode; every run-scoped row carries this
  name TEXT,
  started_wall TEXT NOT NULL,         -- ISO
  ended_wall TEXT,                    -- NULL while the run is open (resumable); set by `session end`
  anchor_epoch_ms REAL NOT NULL,      -- this run's t=0 in wall-clock ms (t columns are run-relative)
  mode TEXT NOT NULL,                 -- attach | launch
  scope TEXT,
  browser TEXT,
  contract TEXT,                      -- JSON: goals, stance, environment, artifacts (GUIDANCE §7.1)
  dialog_policy TEXT NOT NULL DEFAULT 'accept'
);

CREATE TABLE IF NOT EXISTS targets (
  target_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                -- page | iframe | worker | service_worker | other
  url TEXT,
  title TEXT,
  opener_id TEXT,                    -- target that opened this one (popups/child windows)
  parent_id TEXT,                    -- parent target for OOPIFs
  scoped INTEGER NOT NULL DEFAULT 1, -- 1 = instrumented; 0 = ignored (out of scope)
  attached_t REAL,
  observed_from REAL,                -- first moment we were fully listening (= attached_t unless attached late)
  late INTEGER NOT NULL DEFAULT 0,   -- 1 = target was already running when we attached (unobserved prefix)
  detached_t REAL
);

CREATE TABLE IF NOT EXISTS frames (
  frame_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  parent_frame_id TEXT,
  url TEXT,
  name TEXT,
  t REAL                             -- last navigation
);

-- The unified event stream. `seq` is the store cursor used in reports (ev:a-b).
CREATE TABLE IF NOT EXISTS events (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  target_id TEXT,
  frame_id TEXT,
  kind TEXT NOT NULL,                -- request | response | ws_open | ws_frame | ws_close | console | dialog | nav | download | frame | mutation | sentinel | action | settle | target | note | ...
  action_id TEXT,                    -- act:<n> when inside a causality window (attributed or not)
  ref TEXT,                          -- row id in the kind's table (request id, ws frame seq, blob hash, ...)
  summary TEXT                       -- compact JSON digest
);
CREATE INDEX IF NOT EXISTS events_t ON events(t);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, t);
CREATE INDEX IF NOT EXISTS events_action ON events(action_id);

CREATE TABLE IF NOT EXISTS requests (
  run INTEGER NOT NULL DEFAULT 1,
  id TEXT PRIMARY KEY,               -- CDP requestId; redirects get `<id>:r<n>`
  target_id TEXT,
  frame_id TEXT,
  t_start REAL NOT NULL,
  t_response REAL,
  t_end REAL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT,
  path TEXT,
  family TEXT,                       -- method + host + path-shape (ids/uuids/numbers -> *)
  resource_type TEXT,                -- Document | XHR | Fetch | Script | Image | EventSource | ...
  initiator_type TEXT,               -- parser | script | preload | other
  initiator TEXT,                    -- JSON (stack for script initiators)
  req_headers TEXT,                  -- JSON
  req_body TEXT,                     -- capped text
  status INTEGER,
  status_text TEXT,
  mime TEXT,
  resp_headers TEXT,                 -- JSON
  resp_size INTEGER,                 -- decoded body length when known
  encoded_size INTEGER,              -- bytes on the wire
  from_cache INTEGER,
  body_hash TEXT,                    -- -> bodies.hash / blobs
  body_state TEXT,                   -- ok | truncated | evicted | streaming | none | error | pending
  error TEXT,                        -- loadingFailed errorText
  redirect_from TEXT,                -- previous request id in a redirect chain
  action_id TEXT,                    -- causality window this started in (if any)
  attribution TEXT,                  -- task | window | dependency | ambient | none
  write_kind TEXT                    -- read | write | unknown (per family; BRIEF §1.19)
);
CREATE INDEX IF NOT EXISTS requests_t ON requests(t_start);
CREATE INDEX IF NOT EXISTS requests_action ON requests(action_id);
CREATE INDEX IF NOT EXISTS requests_family ON requests(family);
CREATE INDEX IF NOT EXISTS requests_body ON requests(body_hash);

-- Textual bodies (under defaults.bodyTextCap) live here too, so FTS and one-line SQL work.
-- Every body is also a blob file: blobs/<hash[0:2]>/<hash>.
CREATE TABLE IF NOT EXISTS bodies (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT,
  text TEXT,                         -- NULL for binary or over-cap bodies
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS bodies_fts USING fts5(text, content='bodies', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS bodies_ai AFTER INSERT ON bodies BEGIN
  INSERT INTO bodies_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS websockets (
  run INTEGER NOT NULL DEFAULT 1,
  id TEXT PRIMARY KEY,               -- CDP requestId of the handshake
  target_id TEXT,
  url TEXT NOT NULL,
  t_open REAL NOT NULL,
  t_close REAL,
  action_id TEXT
);
CREATE TABLE IF NOT EXISTS ws_frames (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ws_id TEXT NOT NULL,
  t REAL NOT NULL,
  dir TEXT NOT NULL,                 -- in | out
  opcode INTEGER,
  size INTEGER,
  payload TEXT,                      -- text (or base64 for binary), capped
  action_id TEXT                     -- causality window it occurred in (not attribution)
);
CREATE INDEX IF NOT EXISTS ws_frames_t ON ws_frames(t);
CREATE VIRTUAL TABLE IF NOT EXISTS ws_fts USING fts5(payload, content='ws_frames', content_rowid='seq');
CREATE TRIGGER IF NOT EXISTS ws_frames_ai AFTER INSERT ON ws_frames BEGIN
  INSERT INTO ws_fts(rowid, payload) VALUES (new.seq, new.payload);
END;

CREATE TABLE IF NOT EXISTS console (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  target_id TEXT,
  level TEXT NOT NULL,               -- log | info | warning | error | exception
  text TEXT,
  url TEXT,
  line INTEGER,
  stack TEXT,
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS dialogs (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  target_id TEXT,
  type TEXT NOT NULL,                -- alert | confirm | prompt | beforeunload
  message TEXT,
  handled TEXT,                      -- accept | dismiss
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS nav (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  target_id TEXT,
  frame_id TEXT,
  kind TEXT NOT NULL,                -- navigated | same_document | load | domcontentloaded | frame_attached | frame_detached | history
  url TEXT,
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS downloads (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  target_id TEXT,
  guid TEXT,
  url TEXT,
  filename TEXT,
  state TEXT                         -- begin | completed | canceled
);

-- Screencast frames and on-demand screenshots that were persisted (changed pixels, rate-capped).
CREATE TABLE IF NOT EXISTS shots (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  target_id TEXT,
  hash TEXT NOT NULL,                -- blob (jpeg/png)
  w INTEGER, h INTEGER,
  kind TEXT NOT NULL,                -- cast | shot
  reason TEXT,                       -- pre | post | sentinel:<name> | diag | interval | changed
  changed_tiles INTEGER              -- tiles differing from previous frame (outside ignore mask)
);
CREATE INDEX IF NOT EXISTS shots_t ON shots(t);

-- In-page observer batches (DOM mutation summaries), one row per batch per frame.
CREATE TABLE IF NOT EXISTS mutations (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,                   -- time of the last mutation in the batch
  target_id TEXT,
  frame_id TEXT,
  count INTEGER NOT NULL,
  added INTEGER, removed INTEGER, attrs INTEGER, text INTEGER,
  roots TEXT,                        -- JSON: up to N selector paths of touched subtrees
  action_id TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  run INTEGER NOT NULL DEFAULT 1,
  id TEXT PRIMARY KEY,               -- act:<n>
  n INTEGER NOT NULL,
  t_start REAL NOT NULL,             -- dispatch time (causality window open)
  t_settled REAL,                    -- window close
  target_id TEXT,
  frame_id TEXT,
  kind TEXT NOT NULL,                -- click | type | press | select | navigate | hover | scroll | settle | watch
  spec TEXT,                         -- JSON: the action as requested
  resolved TEXT,                     -- JSON: selector, generated selector, box, target description
  verdict TEXT,                      -- no-effect | settled:network|dom|visual | settled:late | still-active | navigated | dialog | new-target | download | diagnosis
  settle_ms REAL,
  timeline TEXT,                     -- JSON: settlement signal timeline
  pre_shot TEXT, post_shot TEXT,     -- blob hashes
  pre_aria TEXT, post_aria TEXT,     -- blob hashes of aria snapshots
  report TEXT,                       -- JSON: the full report as returned
  seq_start INTEGER, seq_end INTEGER -- events cursor
);

CREATE TABLE IF NOT EXISTS sentinels (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  target_id TEXT,
  frame_id TEXT,
  name TEXT NOT NULL,                -- dialog | toast | error | session_expiry | new_target
  detail TEXT,                       -- JSON: title/text/role/selector/status...
  shot TEXT,                         -- blob hash of the screenshot taken at firing
  action_id TEXT,                    -- window it fired in, if any
  reported INTEGER NOT NULL DEFAULT 0, -- 1 once surfaced in a report's environment flags
  muted INTEGER NOT NULL DEFAULT 0    -- 1 when a mute rule matched: recorded, never reported/streamed (DECISIONS #43)
);

-- Ambient classifier state, per request family (BRIEF §1.13). Reversible: attribution keeps its tag.
CREATE TABLE IF NOT EXISTS families (
  family TEXT PRIMARY KEY,
  method TEXT, host TEXT, path_shape TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  first_t REAL, last_t REAL,
  ambient INTEGER NOT NULL DEFAULT 0,
  ambient_reason TEXT,               -- periodic | chained | manual
  evidence TEXT,                     -- JSON: gaps, cv, outside-window count...
  write_kind TEXT NOT NULL DEFAULT 'unknown', -- read | write | unknown
  last_run INTEGER                   -- the run that last saw this family (stale families from another host are visible)
);

-- The one table the agent writes (via `disco note` / session.note()). GUIDANCE §6.2.
CREATE TABLE IF NOT EXISTS notes (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  kind TEXT NOT NULL,                -- state | transition | ledger | note
  action_id TEXT,
  name TEXT,                         -- e.g. state name, transition name, ledger step
  text TEXT,                         -- free text or JSON
  data TEXT                          -- JSON
);

-- Server-sent events: the body of an EventSource request never "finishes", but CDP reports each message.
CREATE TABLE IF NOT EXISTS sse_events (
  run INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t REAL NOT NULL,
  request_id TEXT NOT NULL,
  event TEXT,
  event_id TEXT,
  data TEXT,
  action_id TEXT
);

-- Drill-down join indexes (review nits, 2026-08-30). New sessions only; existing stores unaffected.
CREATE INDEX IF NOT EXISTS ws_frames_ws ON ws_frames(ws_id);
CREATE INDEX IF NOT EXISTS sse_events_req ON sse_events(request_id);
CREATE INDEX IF NOT EXISTS mutations_action ON mutations(action_id);
CREATE INDEX IF NOT EXISTS console_action ON console(action_id);

-- run filters (per-product history is one DB; scope temporal/episodic queries by run)
CREATE INDEX IF NOT EXISTS events_run ON events(run);
CREATE INDEX IF NOT EXISTS requests_run ON requests(run);
CREATE INDEX IF NOT EXISTS actions_run ON actions(run);
CREATE INDEX IF NOT EXISTS sentinels_run ON sentinels(run);

-- Per-app overrides (DECISIONS #43): URL-substring attribution rules and sentinel mutes. Persist across runs.
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run INTEGER NOT NULL DEFAULT 1,
  t REAL,
  kind TEXT NOT NULL,                -- ambient | not-ambient | mute-sentinel
  match TEXT NOT NULL,               -- ambient/not-ambient: a URL substring; mute-sentinel: JSON {name, selector?, text?, url?}
  note TEXT
);
