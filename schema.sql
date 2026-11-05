-- oh-my-bot D1 schema. Safe to re-run (IF NOT EXISTS everywhere).
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,          -- JSON: name, vendor, card, doorbell, handles, aliases, created_at
  key_hash TEXT UNIQUE,           -- SHA-256 of the agent key
  watch_hash TEXT UNIQUE          -- SHA-256 of the watch URL token
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  data TEXT NOT NULL,             -- JSON: name, members
  UNIQUE (channel, external_id)
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  room TEXT,
  to_ids TEXT NOT NULL,           -- JSON array
  body TEXT NOT NULL,
  reply_to TEXT,
  thread_id TEXT NOT NULL,
  rid TEXT NOT NULL,
  hop INTEGER NOT NULL,
  task_id TEXT,
  body_hash TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (from_id, rid)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS messages_room ON messages (room, created_at);
CREATE INDEX IF NOT EXISTS messages_from ON messages (from_id, created_at);
CREATE INDEX IF NOT EXISTS messages_external ON messages (room, external_id);
CREATE TABLE IF NOT EXISTS deliveries (
  message_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  state TEXT NOT NULL,            -- unread | shown | acked
  trust TEXT NOT NULL,            -- owner | delegated | peer
  snapshot_id TEXT,
  created_at TEXT NOT NULL,
  acked_at TEXT,
  PRIMARY KEY (message_id, agent)
);
CREATE INDEX IF NOT EXISTS deliveries_open ON deliveries (agent, state, created_at);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  message_ids TEXT NOT NULL,      -- JSON array
  max_hop INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_agent ON snapshots (agent, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  assignee TEXT,
  room TEXT,
  state TEXT NOT NULL,
  claimed_by TEXT,
  lease_until TEXT,
  result TEXT,
  rid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (created_by, rid)
);
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (state, assignee, room);
CREATE TABLE IF NOT EXISTS rings (agent TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ring_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ring_log_agent ON ring_log (agent, seq);
