'use strict';
// Adds prefect accounts from a CSV file with the columns: username,name
// Usernames are the part of the school email before the @, so they match the staff portal.
// Each new account starts with the default password and must change it at first login.
// Usernames that already exist are left as they are.
//   npm run add-prefects -- data\prefects.csv
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { addUser, ensureFirstAdmin } = require('./setup');
const { DEFAULT_PASSWORD } = require('./auth');

const file = process.argv[2];
if (!file) {
  console.error('Give the CSV file, e.g. npm run add-prefects -- data\\prefects.csv');
  process.exit(1);
}

const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data');
const db = openDb(path.join(DATA_DIR, 'prefects.db'));
ensureFirstAdmin(db);

const rows = fs.readFileSync(path.resolve(file), 'utf8').replace(/^﻿/, '').split(/\r?\n/)
  .map((line) => line.trim()).filter(Boolean);
if (/^username\s*,/i.test(rows[0] || '')) rows.shift();

let added = 0;
let skipped = 0;
for (const line of rows) {
  const comma = line.indexOf(',');
  // Accept a full email too, and keep only the part before the @.
  const username = (comma < 0 ? line : line.slice(0, comma)).trim().split('@')[0].toLowerCase();
  const name = comma < 0 ? '' : line.slice(comma + 1).trim().replace(/^"|"$/g, '');
  if (!username || !name) {
    console.error(`Skipped a line without both a username and a name: ${line}`);
    skipped += 1;
    continue;
  }
  if (db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(username)) {
    console.log(`Already exists: ${username}`);
    skipped += 1;
    continue;
  }
  addUser(db, { username, displayName: name, role: 'prefect' });
  added += 1;
}

console.log(`Added ${added} prefect account(s), skipped ${skipped}. New accounts sign in with ${DEFAULT_PASSWORD}.`);
