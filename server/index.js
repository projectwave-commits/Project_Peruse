'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const os = require('node:os');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { ensureFirstAdmin } = require('./setup');
const { startBackups } = require('./backup');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const PORT = Number(process.env.PORT || 3080);
const HOST = process.env.HOST || undefined;
const PFX = process.env.HTTPS_PFX;

const db = openDb(path.join(DATA_DIR, 'prefects.db'));
ensureFirstAdmin(db, DATA_DIR);
startBackups(db, path.join(DATA_DIR, 'backups'));

const app = createApp(db, {
  secureCookies: Boolean(PFX) || process.env.SECURE_COOKIES === '1',
  cookiePath: process.env.COOKIE_PATH || '/',
});
const server = PFX
  ? https.createServer({ pfx: fs.readFileSync(path.resolve(ROOT, PFX)), passphrase: process.env.HTTPS_PFX_PASSPHRASE }, app)
  : http.createServer(app);

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} is already used by another program. Set a different PORT in the .env file.`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const scheme = PFX ? 'https' : 'http';
  console.log(`Prefects app running on ${scheme}://localhost:${PORT}`);
  if (HOST) return;
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`  On the school network: ${scheme}://${net.address}:${PORT}`);
    }
  }
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
