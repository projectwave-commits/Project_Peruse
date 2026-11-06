'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('prefect','admin')),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  is_dummy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  student_no TEXT UNIQUE,
  first_name TEXT NOT NULL,
  surname TEXT NOT NULL,
  form TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  is_dummy INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS list_types (
  key TEXT PRIMARY KEY CHECK (key IN ('dress','manual')),
  name TEXT NOT NULL,
  threshold INTEGER NOT NULL DEFAULT 2 CHECK (threshold >= 1),
  default_time TEXT NOT NULL DEFAULT '',
  default_instructions TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS offences (
  id INTEGER PRIMARY KEY,
  list_type TEXT NOT NULL REFERENCES list_types(key),
  class TEXT CHECK (class IN ('C1','C2')),
  name TEXT NOT NULL,
  straight_to_list INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (list_type, name)
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  list_type TEXT NOT NULL REFERENCES list_types(key),
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_time TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  published_at TEXT,
  closed_at TEXT,
  session_started_at TEXT,
  session_started_by INTEGER REFERENCES users(id),
  is_dummy INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS list_duty (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, user_id)
);
CREATE TABLE IF NOT EXISTS register_alerts (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  changes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  dismissed_at TEXT
);
CREATE TABLE IF NOT EXISTS list_entries (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  entry_date TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  carried_from_entry_id INTEGER REFERENCES list_entries(id),
  attendance TEXT CHECK (attendance IN ('present','absent')),
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT,
  query_note TEXT,
  query_by INTEGER REFERENCES users(id),
  query_at TEXT,
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  removed_reason TEXT
);
CREATE TABLE IF NOT EXISTS demerits (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  list_type TEXT NOT NULL REFERENCES list_types(key),
  offence_id INTEGER REFERENCES offences(id),
  label TEXT NOT NULL,
  straight_to_list INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  reported_by TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  list_entry_id INTEGER REFERENCES list_entries(id),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  expired_at TEXT
);
CREATE TABLE IF NOT EXISTS term_starts (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  started_by INTEGER REFERENCES users(id),
  demerits_cleared INTEGER NOT NULL,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS demerits_student ON demerits(student_id, created_at);
CREATE INDEX IF NOT EXISTS demerits_pending ON demerits(list_type, list_entry_id, voided_at);
CREATE INDEX IF NOT EXISTS demerits_author ON demerits(created_by, created_at);
CREATE INDEX IF NOT EXISTS entries_list ON list_entries(list_id);
CREATE INDEX IF NOT EXISTS entries_student ON list_entries(student_id);
CREATE INDEX IF NOT EXISTS entries_carried ON list_entries(carried_from_entry_id);
`;

// Taken from the school's current lists and demerit guide; admins can edit all of this in the app.
const DEFAULT_LIST_TYPES = [
  {
    key: 'dress',
    name: 'Dress Parade',
    time: '6:45 AM',
    instructions: 'All pupils must wear full numbers and hats and report on time to the tuck shop',
  },
  {
    key: 'manual',
    name: 'Manual Labour',
    time: '14:00 – 16:00',
    instructions:
      'Meet at the AMPHITHEATRE in your sports kit. It is YOUR responsibility to excuse yourself from any other activity you are scheduled to have at this time. Manual takes precedence over all other activities. Failure to attend manual is a CLASS ONE offence.',
  },
];

const DEFAULT_OFFENCES = [
  ['dress', null, 'Grooming', 0],
  ['dress', null, 'Uniform', 0],
  ['dress', null, 'Chewing gum', 0],
  ['dress', null, 'Other minor offence', 0],
  ['manual', 'C2', 'General Transgression', 0],
  ['manual', 'C2', 'Lateness', 0],
  ['manual', 'C2', 'Unauthorised Absence', 0],
  ['manual', 'C2', 'Disrespect', 0],
  ['manual', 'C2', 'Disobedience', 0],
  ['manual', 'C2', 'Campus Violation', 0],
  ['manual', 'C2', 'Disrupting Events', 0],
  ['manual', 'C2', 'Dress Code Violation', 0],
  ['manual', 'C1', 'Misconduct', 1],
  ['manual', 'C1', 'Aggression', 1],
  ['manual', 'C1', 'Making Threats', 1],
  ['manual', 'C1', 'Cyber-Bullying', 1],
  ['manual', 'C1', 'Vaping', 1],
  ['manual', 'C1', 'Cheating', 1],
  ['manual', 'C1', 'Failure to attend manual', 1],
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  seedDefaults(db);
  return db;
}

// Brings databases created by earlier versions up to the current schema.
function migrate(db) {
  const addColumn = (table, column, type) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('demerits', 'expired_at', 'TEXT');
  addColumn('lists', 'session_started_at', 'TEXT');
  addColumn('lists', 'session_started_by', 'INTEGER REFERENCES users(id)');
  // Assigning duty became admin-only.
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (userColumns.includes('can_assign_duty')) db.exec('ALTER TABLE users DROP COLUMN can_assign_duty');
}

function seedDefaults(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM list_types').get();
  if (n > 0) return;
  const addType = db.prepare(
    'INSERT INTO list_types (key, name, threshold, default_time, default_instructions) VALUES (?, ?, 2, ?, ?)'
  );
  for (const t of DEFAULT_LIST_TYPES) addType.run(t.key, t.name, t.time, t.instructions);
  const addOffence = db.prepare(
    'INSERT INTO offences (list_type, class, name, straight_to_list, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  DEFAULT_OFFENCES.forEach(([type, cls, name, straight], i) => addOffence.run(type, cls, name, straight, i));
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
