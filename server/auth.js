'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 14;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 8;
const LOCK_MS = 10 * 60 * 1000;
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

// Easy to read aloud or copy from a slip of paper; always replaced at first login.
function tempPassword(length = 10) {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_MS).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expires);
  return token;
}

function userForToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(hashToken(token), new Date().toISOString());
  return row || null;
}

const deleteSession = (db, token) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
const deleteUserSessions = (db, userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

// Per username and address, so one person's typos cannot lock out a whole shared Wi-Fi network.
class LoginLimiter {
  constructor() {
    this.failures = new Map();
  }
  isLocked(key) {
    const f = this.failures.get(key);
    if (!f) return false;
    if (Date.now() > f.until) {
      this.failures.delete(key);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }
  fail(key) {
    const f = this.failures.get(key) || { count: 0 };
    f.count += 1;
    f.until = Date.now() + LOCK_MS;
    this.failures.set(key, f);
  }
  clear(key) {
    this.failures.delete(key);
  }
}

module.exports = {
  SESSION_MS,
  hashPassword,
  verifyPassword,
  tempPassword,
  createSession,
  userForToken,
  deleteSession,
  deleteUserSessions,
  LoginLimiter,
};
