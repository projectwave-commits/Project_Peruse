// Checks the app can run behind nginx at a sub-path such as /sign_ups/. Uses no class lists or student names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'options-subpath-'));
process.env.DATA_DIR = tmp;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.CLASS_LIST_DIR = path.join(tmp, 'no-class-lists');


// Stands in for the demerits app, which answers who a sign-in session belongs to.
const people = {
  staff1: { role: 'admin', display_name: 'Ms Test Staff', must_change_password: 0 },
  newstaff: { role: 'admin', display_name: 'Mr New Staff', must_change_password: 1 },
  prefect1: { role: 'prefect', display_name: 'Test Prefect', must_change_password: 0 },
};
const signIn = http.createServer((req, res) => {
  const token = /prefects_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (token === 'broken') { res.writeHead(500); return res.end('{}'); }
  const person = people[token];
  res.writeHead(person ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(person || { error: 'Please log in.' }));
});
let start;

const PUBLIC = path.join(__dirname, '..', 'public');
let server;
let base;

test.before(async () => {
  await new Promise((resolve) => signIn.listen(0, '127.0.0.1', resolve));
  process.env.SIGN_IN_URL = `http://127.0.0.1:${signIn.address().port}/api/me`;
  ({ start } = require('../server'));
  server = await start();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  server.closeAllConnections();
  signIn.close();
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

const asPerson = (token) => fetch(`${base}/api/staff/me`, { headers: { cookie: `other=1; prefects_session=${token}` } });

test('staff screens need a sign-in from the home page', async () => {
  assert.equal((await fetch(`${base}/api/staff/me`)).status, 401);
  assert.equal((await asPerson('nobody')).status, 401);
});

test('a staff account opens the staff screens, under its own name', async () => {
  const res = await asPerson('staff1');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'Ms Test Staff');
  assert.equal((await fetch(`${base}/api/staff/progress`, { headers: { cookie: 'prefects_session=staff1' } })).status, 200);
});

test('prefects, and staff who still have to change their password, are turned away', async () => {
  assert.equal((await asPerson('prefect1')).status, 403);
  assert.equal((await asPerson('newstaff')).status, 403);
});

test('a fault in the sign-in check says so, rather than looking like a sign-out', async () => {
  assert.equal((await asPerson('broken')).status, 503);
});

test('the old staff password sign-in is gone', async () => {
  const res = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Tester', password: 'Password1' }),
  });
  assert.notEqual(res.status, 200);
});
