'use strict';
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');

const LOGINS_FILE = 'initial-logins.csv';

function recordLogin(dataDir, role, name, username, password) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOGINS_FILE);
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'Role,Name,Username,Temporary password\r\n');
  fs.appendFileSync(file, `${role},${name},${username},${password}\r\n`);
}

function addUser(db, { username, displayName, role, isDummy = false }, dataDir) {
  const password = auth.tempPassword();
  db.prepare(
    `INSERT INTO users (username, display_name, role, password_hash, must_change_password, is_dummy, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).run(username, displayName, role, auth.hashPassword(password), isDummy ? 1 : 0, new Date().toISOString());
  recordLogin(dataDir, role, displayName, username, password);
  return { username, password };
}

function ensureFirstAdmin(db, dataDir) {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
  if (n > 0) return;
  addUser(db, { username: 'admin', displayName: 'School Admin', role: 'admin' }, dataDir);
  console.log(`First admin account created. Its temporary password is in ${path.join(dataDir, LOGINS_FILE)}`);
}

module.exports = { addUser, ensureFirstAdmin, LOGINS_FILE };
