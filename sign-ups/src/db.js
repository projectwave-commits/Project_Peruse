const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { OPTIONS, SETTINGS } = require('./seed-data');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'options.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    gender TEXT NOT NULL CHECK (gender IN ('M','F')),
    dob TEXT,
    form_level INTEGER NOT NULL,
    form_label TEXT NOT NULL,
    class_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sport_exempt INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    submitted_at TEXT,
    submitted_by TEXT,
    UNIQUE (class_name, name)
  );

  CREATE TABLE IF NOT EXISTS options (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('sport','club')),
    slot INTEGER NOT NULL,
    header TEXT NOT NULL,
    name TEXT NOT NULL,
    gender TEXT,
    min_form INTEGER NOT NULL DEFAULT 1,
    max_form INTEGER NOT NULL DEFAULT 6,
    is_primary INTEGER NOT NULL DEFAULT 0,
    counts_as_club INTEGER NOT NULL DEFAULT 0,
    by_application INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    capacity INTEGER,
    sessions TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS selections (
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
    sessions TEXT NOT NULL DEFAULT '',
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (student_id, option_id)
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    subject TEXT NOT NULL,
    action TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_selections_option ON selections(option_id);
  CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_name);
`);

function tx(fn) {
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

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

const now = () => new Date().toISOString();
const audit = (actor, subject, action) =>
  db.prepare('INSERT INTO audit (at, actor, subject, action) VALUES (?, ?, ?, ?)').run(now(), actor, subject, action);

function seedConfig() {
  for (const [key, value] of Object.entries(SETTINGS)) {
    if (getSetting(key) === null) setSetting(key, value);
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM options').get().n === 0) {
    const insert = db.prepare(`INSERT INTO options
      (category, slot, header, name, gender, min_form, max_form, is_primary, counts_as_club, by_application, closed, sessions, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    tx(() => {
      for (const o of OPTIONS) {
        insert.run(o.category, o.slot, o.header, o.name, o.gender ?? null, o.min_form ?? 1, o.max_form ?? 6,
          o.is_primary, o.counts_as_club, o.by_application ?? 0, o.closed ?? 0,
          JSON.stringify(o.sessions ?? []), o.note ?? '');
      }
    });
  }
  applyTimetableLimits();
}

/**
 * One-time update: form limits shown on the Term 3 timetables but not in the sheet headings.
 * Runs once per database, and skips any option whose limits were already changed on Setup.
 */
function applyTimetableLimits() {
  if (getSetting('timetable_limits_applied')) return;
  const limits = [
    ['INTERACT', 5, 6], ['TOAST MASTERS', 5, 6], ['MUN', 2, 6], ['TIME TRAVELLERS', 1, 3],
    ['DRAMA', 1, 2], ['FIRST AID', 2, 6], ['VOCAL ENSEMBLE', 3, 6],
  ];
  const update = db.prepare('UPDATE options SET min_form = ?, max_form = ? WHERE header = ? AND min_form = 1 AND max_form = 6');
  tx(() => {
    for (const [header, min, max] of limits) update.run(min, max, header);
    db.prepare(`UPDATE options SET note = 'For art students.' WHERE header = 'LIFE DRAWING' AND note = ''`).run();
    setSetting('timetable_limits_applied', '1');
  });
}

// ---- Staff password (scrypt) -------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function checkPassword(password) {
  const stored = getSetting('staff_password');
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(expected, actual);
}

const DEFAULT_PASSWORD = 'Password1';

function setPassword(password) {
  setSetting('staff_password', hashPassword(password));
}

/** On first run, set the starting staff password. Returns true if the default was used. */
function ensurePassword() {
  if (getSetting('staff_password')) return false;
  setSetting('staff_password', hashPassword(process.env.STAFF_PASSWORD || DEFAULT_PASSWORD));
  return !process.env.STAFF_PASSWORD;
}

/** Copy the database to data/backups so a risky change can be undone. */
function backup(label) {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `options-${label}-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

module.exports = {
  db, tx, now, audit, getSetting, setSetting, seedConfig, setPassword, checkPassword, ensurePassword, backup, DATA_DIR,
};
