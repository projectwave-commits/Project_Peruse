// Checks the app can run behind nginx at a sub-path such as /sign_ups/. Uses no class lists or student names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'options-subpath-'));
process.env.DATA_DIR = tmp;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.STAFF_PASSWORD = 'test-password';
process.env.COOKIE_PATH = '/sign_ups/';
process.env.CLASS_LIST_DIR = path.join(tmp, 'no-class-lists');

const { start } = require('../server');

const PUBLIC = path.join(__dirname, '..', 'public');
let server;
let base;

test.before(async () => {
  server = await start();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  server.closeAllConnections();
});

test('pages load their files relative to the address they are served from', () => {
  for (const page of ['index.html', 'staff.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    assert.doesNotMatch(html, /(?:href|src)="\//, `${page} has an address that ignores the sub-path`);
  }
});

test('scripts call the API relative to the page', () => {
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.doesNotMatch(code, /['"`]\/api\//, `${file} has an API address that ignores the sub-path`);
  }
});

test('the staff login cookie stays inside the sub-path', async () => {
  const res = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Tester', password: 'test-password' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Path=\/sign_ups\/;/);
  const out = await fetch(`${base}/api/staff/logout`, { method: 'POST' });
  assert.match(out.headers.get('set-cookie'), /Path=\/sign_ups\/;/);
});

test('the login limiter sees the device behind nginx, not nginx itself', async () => {
  const attempt = (device) => fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': device },
    body: JSON.stringify({ name: 'Tester', password: 'wrong' }),
  });
  for (let i = 0; i < 8; i += 1) await attempt('10.9.9.1');
  assert.equal((await attempt('10.9.9.1')).status, 429);
  assert.equal((await attempt('10.9.9.2')).status, 401, 'another device is not locked out');
});
