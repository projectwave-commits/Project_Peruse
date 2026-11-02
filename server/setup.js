'use strict';
const auth = require('./auth');

function addUser(db, { username, displayName, role, isDummy = false }) {
  db.prepare(
    `INSERT INTO users (username, display_name, role, password_hash, must_change_password, is_dummy, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).run(username, displayName, role, auth.hashPassword(auth.DEFAULT_PASSWORD), isDummy ? 1 : 0, new Date().toISOString());
}

function ensureFirstAdmin(db) {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
  if (n > 0) return;
  addUser(db, { username: 'admin', displayName: 'School Admin', role: 'admin' });
  console.log(`First admin account created. Log in as admin with ${auth.DEFAULT_PASSWORD}, then choose a new password.`);
}

module.exports = { addUser, ensureFirstAdmin };
