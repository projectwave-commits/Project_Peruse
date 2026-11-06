'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { localDate } = require('./lists');

const KEEP_DAYS = 30;
const CHECK_MS = 60 * 60 * 1000;

function backupNow(db, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `prefects-${localDate(new Date().toISOString())}.db`);
  if (!fs.existsSync(file)) {
    db.prepare('VACUUM INTO ?').run(file);
    console.log(`Backup written: ${file}`);
  }
  const old = fs.readdirSync(dir).filter((f) => /^prefects-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(KEEP_DAYS);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
}

function startBackups(db, dir) {
  const run = () => {
    try {
      backupNow(db, dir);
    } catch (err) {
      console.error('Backup failed:', err);
    }
  };
  run();
  setInterval(run, CHECK_MS).unref();
}

module.exports = { backupNow, startBackups };
