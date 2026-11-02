'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const auth = require('../server/auth');
const lists = require('../server/lists');
const { searchStudents, parseStudentRows, importStudents, removeDummyData } = require('../server/students');

const d = (id, student, extra = {}) => ({
  id, student_id: student, label: 'C2: Lateness', straight_to_list: 0, reported_by: null, created_at: `2026-11-0${id}T08:00:00.000Z`, ...extra,
});

test('one demerit waits; two make one entry; a third waits again', () => {
  assert.equal(lists.groupDemerits([d(1, 1)], 2).entries.length, 0);
  const two = lists.groupDemerits([d(1, 1), d(2, 1)], 2);
  assert.equal(two.entries.length, 1);
  assert.deepEqual(two.entries[0].demeritIds, [1, 2]);
  const three = lists.groupDemerits([d(1, 1), d(2, 1), d(3, 1)], 2);
  assert.equal(three.entries.length, 1);
  assert.deepEqual(three.pending.map((x) => x.id), [3]);
});

test('demerits from different students never combine', () => {
  const { entries, pending } = lists.groupDemerits([d(1, 1), d(2, 2)], 2);
  assert.equal(entries.length, 0);
  assert.equal(pending.length, 2);
});

test('a straight-to-list demerit is listed alone and leaves the count untouched', () => {
  const { entries, pending } = lists.groupDemerits([d(1, 1), d(2, 1, { straight_to_list: 1, label: 'C1: Vaping' })], 2);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, 'C1: Vaping');
  assert.deepEqual(pending.map((x) => x.id), [1]);
});

test('entry shows Hellenic Prefects unless a teacher reported it, and lists distinct reasons', () => {
  const { entries } = lists.groupDemerits([d(1, 1), d(2, 1, { reported_by: 'Mrs Tester', label: 'C2: Disrespect' })], 2);
  assert.equal(entries[0].reportedBy, 'Hellenic Prefects, Mrs Tester');
  assert.equal(entries[0].reason, 'C2: Lateness; C2: Disrespect');
  assert.equal(lists.groupDemerits([d(1, 1), d(2, 1)], 2).entries[0].reason, 'C2: Lateness');
});

test('forms sort 1 to 4, then L6, then U6', () => {
  const forms = ['U6 Plato', 'L6 Basil', '4 John', '1 Gregory', '10 Basil'];
  assert.deepEqual([...forms].sort((a, b) => lists.formRank(a) - lists.formRank(b)), ['1 Gregory', '4 John', '10 Basil', 'L6 Basil', 'U6 Plato']);
});

function fixture() {
  const db = openDb(':memory:');
  const addStudent = db.prepare('INSERT INTO students (first_name, surname, form, student_no, is_dummy) VALUES (?, ?, ?, ?, ?)');
  addStudent.run('Tariro', 'Moyo', '4 Plato', 'A1', 0);
  addStudent.run('Sean', "O'Connor", '3 Gregory', 'A2', 0);
  addStudent.run('Noah', 'van der Merwe', 'L6 John', 'A3', 1);
  return db;
}

test('search understands the shorthand prefects already use', () => {
  const db = fixture();
  const names = (q) => searchStudents(db, q).map((s) => s.surname);
  assert.deepEqual(names('moyo'), ['Moyo']);
  assert.deepEqual(names('4P'), ['Moyo']);
  assert.deepEqual(names('tariro 4 plato'), ['Moyo']);
  assert.deepEqual(names('3 greg'), ["O'Connor"]);
  assert.deepEqual(names('oconnor'), ["O'Connor"]);
  assert.deepEqual(names('merwe'), ['van der Merwe']);
  assert.deepEqual(names('l6j'), ['van der Merwe']);
  assert.deepEqual(names('zzz'), []);
  assert.deepEqual(names('  '), []);
});

test('CSV import handles quotes, BOM, semicolons, and Surname, First in one column', () => {
  assert.deepEqual(parseStudentRows('﻿Name,Form\n"Moyo, Tariro",4 Plato\n').students, [
    { first: 'Tariro', surname: 'Moyo', form: '4 Plato', no: null },
  ]);
  assert.deepEqual(parseStudentRows('Surname;First Name;Class;Student No\r\nDube;Anesu;1 John;77\r\n').students, [
    { first: 'Anesu', surname: 'Dube', form: '1 John', no: '77' },
  ]);
  assert.deepEqual(parseStudentRows('Name,Form\nMoyo,\nSean Carter,2 John\n').skipped, [2]);
  assert.throws(() => parseStudentRows('Foo,Bar\n1,2\n'), /Form column/);
});

test('re-import moves a student to a new form and keeps the same record', () => {
  const db = fixture();
  const before = db.prepare("SELECT id FROM students WHERE surname = 'Moyo'").get().id;
  const result = importStudents(db, 'Surname,First Name,Form\nMoyo,Tariro,L6 Plato\nNew,Student,1 John\n', { deactivateMissing: true });
  assert.deepEqual([result.added, result.updated, result.deactivated], [1, 1, 1]);
  const after = db.prepare("SELECT id, form FROM students WHERE surname = 'Moyo'").get();
  assert.equal(after.id, before);
  assert.equal(after.form, 'L6 Plato');
  assert.equal(db.prepare("SELECT active FROM students WHERE student_no = 'A2'").get().active, 0);
  assert.equal(db.prepare("SELECT active FROM students WHERE student_no = 'A3'").get().active, 1, 'dummy rows are left alone');
});

async function startServer() {
  const db = fixture();
  const hash = auth.hashPassword('password123');
  const addUser = db.prepare(
    "INSERT INTO users (username, display_name, role, password_hash, must_change_password, is_dummy, created_at) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01')"
  );
  addUser.run('admin', 'Admin', 'admin', hash, 0, 0);
  addUser.run('p1', 'Prefect One', 'prefect', hash, 0, 0);
  addUser.run('p2', 'Prefect Two', 'prefect', hash, 0, 1);
  addUser.run('fresh', 'New Prefect', 'prefect', hash, 1, 0);
  const server = createApp(db).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  function client() {
    let cookie = '';
    const call = async (path, { method = 'GET', body, csrf = true } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Requested-With': 'prefects-app' } : {}), Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    const login = (username) => call('/login', { method: 'POST', body: { username, password: 'password123' } });
    return { call, login };
  }
  const as = async (username) => {
    const c = client();
    assert.equal((await c.login(username)).status, 200);
    return c.call;
  };
  const offenceId = (name) => db.prepare('SELECT id FROM offences WHERE name = ?').get(name).id;
  const studentId = (surname) => db.prepare('SELECT id FROM students WHERE surname = ?').get(surname).id;
  return { db, server, client, as, offenceId, studentId, close: () => { server.close(); server.closeAllConnections(); } };
}

const NEXT = { title: 'DRESS PARADE', eventDate: '2026-11-05', eventTime: '6:45 AM', instructions: 'Report on time' };

test('security: logins, roles, CSRF and forced password change', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const anon = s.client();
  assert.equal((await anon.call('/students?q=moyo')).status, 401);
  assert.equal((await anon.call('/login', { method: 'POST', body: { username: 'p1', password: 'wrong' } })).status, 401);

  const p1 = await s.as('p1');
  assert.equal((await p1('/admin/users')).status, 403);
  assert.equal((await p1('/admin/lists', { method: 'POST', body: { listType: 'dress', ...NEXT } })).status, 403);
  assert.equal((await p1(`/demerits`, { method: 'POST', csrf: false, body: {} })).status, 403);

  const fresh = await s.as('fresh');
  assert.equal((await fresh('/students?q=moyo')).status, 403);
  assert.equal((await fresh('/me/password', { method: 'POST', body: { currentPassword: 'password123', newPassword: 'short' } })).status, 400);
  assert.equal((await fresh('/me/password', { method: 'POST', body: { currentPassword: 'password123', newPassword: 'a-new-password' } })).status, 200);
  assert.equal((await fresh('/students?q=moyo')).status, 200);

  const limited = s.client();
  for (let i = 0; i < 8; i++) await limited.call('/login', { method: 'POST', body: { username: 'p2', password: 'wrong' } });
  assert.equal((await limited.login('p2')).status, 429);
});

test('prefects cannot see who else recorded a demerit, or their notes', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const p2 = await s.as('p2');
  const admin = await s.as('admin');
  const sid = s.studentId('Moyo');
  await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Lateness'), note: 'secret note' } });

  const seenByOther = (await p2(`/students/${sid}`)).body.demerits[0];
  assert.equal(seenByOther.note, null);
  assert.equal(seenByOther.created_by_name, null);
  assert.equal(seenByOther.can_cancel, false);
  const seenByAdmin = (await admin(`/students/${sid}`)).body.demerits[0];
  assert.equal(seenByAdmin.note, 'secret note');
  assert.equal(seenByAdmin.created_by_name, 'Prefect One');
  assert.equal((await p2(`/demerits/${seenByOther.id}/cancel`, { method: 'POST', body: {} })).status, 403);
});

test('the same offence twice in a day needs confirming', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const p2 = await s.as('p2');
  const body = { studentId: s.studentId('Moyo'), offenceId: s.offenceId('Lateness') };
  const first = await p1('/demerits', { method: 'POST', body });
  assert.equal(first.status, 201);
  assert.equal(first.body.tally.count, 1);
  const repeat = await p2('/demerits', { method: 'POST', body });
  assert.equal(repeat.status, 409);
  assert.equal(repeat.body.code, 'duplicate');
  const confirmed = await p2('/demerits', { method: 'POST', body: { ...body, confirmDuplicate: true } });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.tally.listed, 1);
  assert.equal(confirmed.body.tally.count, 0);
});

test('a cancelled demerit no longer counts', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const sid = s.studentId('Moyo');
  const first = await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Lateness') } });
  await p1(`/demerits/${first.body.id}/cancel`, { method: 'POST', body: {} });
  const second = await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Disrespect') } });
  assert.equal(second.body.tally.count, 1);
  assert.equal(second.body.tally.listed, 0);
});

test('full cycle: cut-off, register, no-show carried to next list once, removal', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  const moyo = s.studentId('Moyo');
  const oconnor = s.studentId("O'Connor");
  const give = (studentId, name, confirm = true) =>
    p1('/demerits', { method: 'POST', body: { studentId, offenceId: s.offenceId(name), confirmDuplicate: confirm } });

  await give(moyo, 'Grooming');
  await give(moyo, 'Uniform');
  await give(oconnor, 'Grooming');
  await give(oconnor, 'Chewing gum');

  const created = await admin('/admin/lists', { method: 'POST', body: { listType: 'dress', ...NEXT } });
  assert.equal(created.status, 201);
  const listId = created.body.id;
  assert.equal((await admin('/admin/lists', { method: 'POST', body: { listType: 'dress', ...NEXT } })).status, 409);

  // Thursday rule: anything after the list is made waits for the next one.
  await give(moyo, 'Grooming');
  await give(moyo, 'Uniform');
  let view = (await p1(`/lists/${listId}`)).body;
  assert.equal(view.entries.length, 2);
  assert.equal((await p1(`/lists/${listId}/register`, { method: 'POST', body: { marks: [{ entryId: view.entries[0].id, attendance: 'present' }] } })).status, 409, 'draft has no register');

  assert.equal((await p1(`/admin/lists/${listId}/publish`, { method: 'POST', body: {} })).status, 403);
  await admin(`/admin/lists/${listId}/publish`, { method: 'POST', body: {} });
  view = (await p1(`/lists/${listId}`)).body;
  const moyoEntry = view.entries.find((e) => e.surname === 'Moyo');
  assert.equal((await p1(`/lists/${listId}/register`, { method: 'POST', body: { marks: [{ entryId: moyoEntry.id, attendance: 'present' }] } })).status, 200);
  assert.equal((await admin(`/lists/${listId}/close`, { method: 'POST', body: {} })).body.absent, 1);

  const preview = (await admin('/admin/lists/preview?type=dress')).body;
  assert.equal(preview.fromDemerits, 1);
  assert.equal(preview.carried, 1);

  const second = (await admin('/admin/lists', { method: 'POST', body: { listType: 'dress', ...NEXT, eventDate: '2026-11-12' } })).body.id;
  view = (await p1(`/lists/${second}`)).body;
  const carried = view.entries.find((e) => e.surname === "O'Connor");
  assert.equal(carried.carried, true);
  assert.equal(view.entries.find((e) => e.surname === 'Moyo').carried, false);

  // A register that fed a later list cannot be reopened, or the no-show would be counted twice.
  assert.equal((await admin(`/admin/lists/${listId}/reopen`, { method: 'POST', body: {} })).status, 409);

  // Discarding returns demerits and no-shows, so creating again gives the same list.
  await admin(`/admin/lists/${second}`, { method: 'DELETE' });
  assert.equal((await admin('/admin/lists/preview?type=dress')).body.carried, 1);
  const third = (await admin('/admin/lists', { method: 'POST', body: { listType: 'dress', ...NEXT, eventDate: '2026-11-12' } })).body.id;
  view = (await p1(`/lists/${third}`)).body;
  assert.equal(view.entries.length, 2);
  await admin(`/admin/lists/${third}/publish`, { method: 'POST', body: {} });
  await admin(`/lists/${third}/close`, { method: 'POST', body: {} });
  const present = (await admin('/admin/lists/preview?type=dress')).body;
  assert.equal(present.carried, 2, 'both were unmarked, so both carry; the first register does not carry again');
});

test('removing an entry cancels its demerits except those kept; queries reach the admin', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  const sid = s.studentId('Moyo');
  await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Grooming') } });
  await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Uniform') } });
  const listId = (await admin('/admin/lists', { method: 'POST', body: { listType: 'dress', ...NEXT } })).body.id;
  const entry = (await p1(`/lists/${listId}`)).body.entries[0];

  assert.equal((await p1(`/entries/${entry.id}/query`, { method: 'POST', body: { note: 'Wrong student' } })).status, 200);
  const summary = (await admin('/admin/summary')).body;
  assert.equal(summary.queries[0].query_note, 'Wrong student');
  assert.equal(summary.queries[0].query_by_name, 'Prefect One');

  const demerits = (await admin(`/admin/entries/${entry.id}/demerits`)).body;
  assert.equal(demerits.length, 2);
  assert.equal((await p1(`/admin/entries/${entry.id}/remove`, { method: 'POST', body: { reason: 'x' } })).status, 403);
  await admin(`/admin/entries/${entry.id}/remove`, { method: 'POST', body: { reason: 'Misunderstanding', keepDemeritIds: [demerits[0].id] } });

  assert.equal((await p1(`/lists/${listId}`)).body.entries.length, 0);
  assert.equal((await admin('/admin/summary')).body.queries.length, 0);
  const record = (await p1(`/students/${sid}`)).body;
  const dress = record.tallies.find((x) => x.key === 'dress');
  assert.equal(dress.count, 1, 'the kept demerit waits again');
  const voided = (await admin(`/students/${sid}`)).body.demerits.find((x) => x.voided);
  assert.equal(voided.void_reason, 'Misunderstanding');
});

test('teacher-reported demerits can go straight on the list and show the teacher', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  const sid = s.studentId('Moyo');
  const noTeacher = await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Lateness'), straightToList: true } });
  assert.equal(noTeacher.body.straight, false, 'a prefect alone cannot skip the two-demerit rule');
  const teacher = await p1('/demerits', {
    method: 'POST',
    body: { studentId: sid, offenceId: s.offenceId('Disrespect'), reportedBy: 'Mrs Tester', straightToList: true },
  });
  assert.equal(teacher.body.straight, true);
  const listId = (await admin('/admin/lists', { method: 'POST', body: { listType: 'manual', ...NEXT, title: 'MANUAL LABOUR' } })).body.id;
  const { entries } = (await p1(`/lists/${listId}`)).body;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reported_by, 'Mrs Tester');
  assert.equal(entries[0].reason, 'C2: Disrespect');
});

test('Word export is a valid document for both layouts', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  const sid = s.studentId("O'Connor");
  await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Vaping') } });
  const listId = (await admin('/admin/lists', { method: 'POST', body: { listType: 'manual', ...NEXT, title: 'MANUAL LABOUR' } })).body.id;
  const res = await admin(`/admin/lists/${listId}/export.docx`);
  assert.equal(res.status, 200);
  assert.equal(res.body.subarray(0, 2).toString(), 'PK');
  assert.equal((await p1(`/admin/lists/${listId}/export.docx`)).status, 403);
});

test('CSV export blocks spreadsheet formula injection', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  await p1('/demerits', { method: 'POST', body: { studentId: s.studentId('Moyo'), offenceId: s.offenceId('Lateness'), note: '=HYPERLINK("http://x")' } });
  const csv = (await admin('/admin/demerits.csv')).body.toString();
  assert.match(csv, /"'=HYPERLINK/);
});

test('removing dummy data keeps real students and accounts, and their records', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const p2 = await s.as('p2');
  const admin = await s.as('admin');
  await p1('/demerits', { method: 'POST', body: { studentId: s.studentId('Moyo'), offenceId: s.offenceId('Lateness') } });
  await p1('/demerits', { method: 'POST', body: { studentId: s.studentId('van der Merwe'), offenceId: s.offenceId('Vaping') } });
  await p2('/demerits', { method: 'POST', body: { studentId: s.studentId("O'Connor"), offenceId: s.offenceId('Disrespect') } });
  await admin('/admin/lists', { method: 'POST', body: { listType: 'manual', ...NEXT } });

  assert.equal((await admin('/admin/remove-dummy-data', { method: 'POST', body: { confirm: 'nope' } })).status, 400);
  assert.equal((await admin('/admin/remove-dummy-data', { method: 'POST', body: { confirm: 'DELETE' } })).status, 200);

  const count = (table) => s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  assert.equal(count('students'), 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'p2'").get().n, 0);
  assert.equal(count('demerits'), 1, 'only the real student recorded by a real prefect remains');
  assert.equal(count('lists'), 0, 'the list had only a dummy student on it');
  assert.equal(removeDummyData(s.db).students, 0);
});

test('a missed manual puts the student back on the next manual list, without a new demerit', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  const sid = s.studentId('Moyo');
  await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Lateness') } });
  await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Disrespect') } });
  const first = (await admin('/admin/lists', { method: 'POST', body: { listType: 'manual', ...NEXT } })).body.id;
  await admin(`/admin/lists/${first}/publish`, { method: 'POST', body: {} });
  const entry = (await p1(`/lists/${first}`)).body.entries[0];
  await p1(`/lists/${first}/register`, { method: 'POST', body: { marks: [{ entryId: entry.id, attendance: 'absent' }] } });
  await admin(`/lists/${first}/close`, { method: 'POST', body: {} });

  const second = (await admin('/admin/lists', { method: 'POST', body: { listType: 'manual', ...NEXT, eventDate: '2026-11-12' } })).body.id;
  const { entries } = (await p1(`/lists/${second}`)).body;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].carried, true);
  assert.equal(entries[0].reason, 'C2: Lateness; C2: Disrespect');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM demerits').get().n, 2);
});

test('a new term resets part-way counts only, and can be undone', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  const moyo = s.studentId('Moyo');
  const oconnor = s.studentId("O'Connor");
  const dressCount = async (id) => (await p1(`/students/${id}`)).body.tallies.find((x) => x.key === 'dress');
  const give = (studentId, name) => p1('/demerits', { method: 'POST', body: { studentId, offenceId: s.offenceId(name) } });

  await give(moyo, 'Grooming');
  await give(oconnor, 'Grooming');
  await give(oconnor, 'Uniform');
  const id = (await give(moyo, 'Vaping')).body.id;
  assert.ok(id);

  assert.equal((await p1('/admin/term/start', { method: 'POST', body: {} })).status, 403);
  assert.equal((await admin('/admin/summary')).body.term.leftover, 1);
  assert.equal((await admin('/admin/term/start', { method: 'POST', body: {} })).body.cleared, 1);

  assert.equal((await dressCount(moyo)).count, 0);
  assert.equal((await dressCount(oconnor)).listed, 1, 'reached the limit last term, so still due');
  const record = (await p1(`/students/${moyo}`)).body.demerits.find((d) => d.label === 'Grooming');
  assert.equal(record.expired, true, 'kept in the history');
  assert.equal(record.can_cancel, false);
  assert.equal((await p1(`/demerits/${record.id}/cancel`, { method: 'POST', body: {} })).status, 409);

  // One demerit in the new term does not combine with last term's.
  const fresh = await give(moyo, 'Grooming');
  assert.equal(fresh.status, 201, 'an expired demerit does not trigger the duplicate warning');
  assert.equal(fresh.body.tally.count, 1);
  assert.equal(fresh.body.tally.listed, 0);

  const list = (await admin('/admin/lists', { method: 'POST', body: { listType: 'dress', ...NEXT } })).body.id;
  assert.deepEqual((await p1(`/lists/${list}`)).body.entries.map((e) => e.surname), ["O'Connor"]);
  await admin(`/admin/lists/${list}`, { method: 'DELETE' });

  const csv = (await admin('/admin/demerits.csv')).body.toString();
  assert.match(csv, /Earlier term/);

  assert.equal((await admin('/admin/term/undo', { method: 'POST', body: {} })).body.restored, 1);
  assert.equal((await dressCount(moyo)).listed, 1, 'old and new demerits now combine');
  assert.equal((await admin('/admin/term/undo', { method: 'POST', body: {} })).status, 409, 'cannot undo twice');
});

test('a database from the first version gains the term column and keeps its data', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefects-'));
  const file = path.join(dir, 'old.db');
  let db = openDb(file);
  db.exec("INSERT INTO students (first_name, surname, form) VALUES ('A', 'B', '1 John')");
  db.exec('ALTER TABLE demerits DROP COLUMN expired_at');
  db.close();
  db = openDb(file);
  assert.ok(db.prepare('PRAGMA table_info(demerits)').all().some((c) => c.name === 'expired_at'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM students').get().n, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function publishedList(s, p1, admin) {
  const sid = s.studentId('Moyo');
  await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Grooming') } });
  await p1('/demerits', { method: 'POST', body: { studentId: sid, offenceId: s.offenceId('Uniform') } });
  const id = (await admin('/admin/lists', { method: 'POST', body: { listType: 'dress', ...NEXT } })).body.id;
  await admin(`/admin/lists/${id}/publish`, { method: 'POST', body: {} });
  return { id, entry: (await p1(`/lists/${id}`)).body.entries[0] };
}

const userId = (s, username) => s.db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;

test('only admins can assign duty', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const p2 = await s.as('p2');
  const admin = await s.as('admin');
  const { id } = await publishedList(s, p1, admin);
  const assign = (who, ids) => who(`/admin/lists/${id}/duty`, { method: 'PUT', body: { userIds: ids } });

  assert.equal((await assign(p1, [userId(s, 'p2')])).status, 403);
  assert.equal((await p1('/admin/duty-candidates')).status, 403);
  assert.equal((await p1(`/lists/${id}/duty`, { method: 'PUT', body: { userIds: [userId(s, 'p1')] } })).status, 404);

  assert.ok((await admin('/admin/duty-candidates')).body.some((c) => c.display_name === 'Prefect Two'));
  assert.equal((await assign(admin, [userId(s, 'p2')])).status, 200);
  const seen = (await p2(`/lists/${id}`)).body;
  assert.deepEqual(seen.duty.map((d) => d.display_name), ['Prefect Two']);
  assert.equal(seen.list.on_duty, 1);
  assert.equal((await p1(`/lists/${id}`)).body.list.on_duty, 0);
  assert.equal((await assign(admin, [userId(s, 'admin')])).status, 400, 'admins are not prefects on duty');
  assert.deepEqual((await p2(`/lists/${id}`)).body.duty.map((d) => d.display_name), ['Prefect Two'], 'a failed save changes nothing');
});

test('bulk upload gives one reason to every student, or to none', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const p2 = await s.as('p2');
  const admin = await s.as('admin');
  const [moyo, merwe, connor] = [s.studentId('Moyo'), s.studentId('van der Merwe'), s.studentId("O'Connor")];
  const bulk = (who, listType, name, studentIds, extra = {}) =>
    who('/demerits/bulk', { method: 'POST', body: { listType, offenceId: s.offenceId(name), studentIds, ...extra } });
  const count = () => s.db.prepare('SELECT COUNT(*) AS n FROM demerits').get().n;
  const nameOf = (id) => {
    const row = s.db.prepare('SELECT first_name, surname FROM students WHERE id = ?').get(id);
    return `${row.first_name} ${row.surname}`;
  };

  assert.equal((await s.client().call('/demerits/bulk', { method: 'POST', body: { listType: 'dress', offenceId: s.offenceId('Grooming'), studentIds: [moyo] } })).status, 401);
  assert.equal((await bulk(p1, 'nonsense', 'Grooming', [moyo])).status, 400);
  assert.equal((await bulk(p1, 'dress', 'Grooming', [])).status, 400);
  assert.equal((await bulk(p1, 'dress', 'Grooming', Array(101).fill(moyo))).status, 400);
  assert.equal((await bulk(p1, 'dress', 'Lateness', [moyo])).status, 400, 'a reason from the other list');

  // One bad row stops the whole batch.
  assert.equal((await bulk(p1, 'dress', 'Grooming', [moyo, merwe, moyo])).status, 400);
  assert.equal((await bulk(p1, 'dress', 'Grooming', [moyo, 99999])).status, 404);
  assert.equal(count(), 0);

  // Serious reasons are for admins only, and nothing is saved when a prefect tries one.
  assert.equal((await bulk(p1, 'manual', 'Vaping', [moyo, merwe])).status, 403);
  assert.equal(count(), 0);

  await p1('/demerits', { method: 'POST', body: { studentId: moyo, offenceId: s.offenceId('Uniform') } });
  const first = await bulk(p1, 'dress', 'Grooming', [moyo, merwe]);
  assert.equal(first.status, 201);
  assert.equal(first.body.count, 2);
  assert.equal(first.body.listName, 'Dress Parade');
  assert.deepEqual(first.body.listed, [nameOf(moyo)], 'only the student reaching two is listed');
  const labels = s.db.prepare('SELECT DISTINCT offence_id FROM demerits WHERE student_id IN (?, ?) AND offence_id = ?').all(moyo, merwe, s.offenceId('Grooming'));
  assert.equal(labels.length, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM demerits WHERE created_by = ?').get(userId(s, 'p1')).n, 3);

  // Another prefect reporting the same incident must confirm, and nothing is saved until then.
  const before = count();
  const repeat = await bulk(p2, 'dress', 'Grooming', [merwe, connor]);
  assert.equal(repeat.status, 409);
  assert.equal(repeat.body.code, 'duplicate');
  assert.deepEqual(repeat.body.duplicates, [nameOf(merwe)]);
  assert.equal(count(), before);
  assert.equal((await bulk(p2, 'dress', 'Grooming', [merwe, connor], { confirmDuplicate: true })).status, 201);
  assert.equal(count(), before + 2);

  // An admin can use a serious reason, which lists the student at once.
  const serious = await bulk(admin, 'manual', 'Vaping', [connor]);
  assert.equal(serious.status, 201);
  assert.deepEqual(serious.body.listed, [nameOf(connor)]);
});

test('behind nginx the login limiter tells phones apart, and the cookie can be scoped', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const url = `http://127.0.0.1:${s.server.address().port}/api/login`;
  const attempt = (phone) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'prefects-app', 'X-Forwarded-For': phone },
    body: JSON.stringify({ username: 'p1', password: 'wrong' }),
  });
  for (let i = 0; i < 8; i++) await attempt('10.0.0.1');
  assert.equal((await attempt('10.0.0.1')).status, 429);
  assert.equal((await attempt('10.0.0.2')).status, 401, 'another phone is not locked out');

  const scoped = createApp(s.db, { cookiePath: '/prefect/', secureCookies: true }).listen(0);
  t.after(() => { scoped.close(); scoped.closeAllConnections(); });
  await new Promise((resolve) => scoped.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${scoped.address().port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'prefects-app' },
    body: JSON.stringify({ username: 'p2', password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /Path=\/prefect\//);
  assert.match(cookie, /Secure/);
});

test('opening an older database removes the old assign permission and keeps the accounts', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefects-'));
  const file = path.join(dir, 'old.db');
  let db = openDb(file);
  db.exec("INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES ('p', 'P', 'prefect', 'x', 'now')");
  db.exec('ALTER TABLE users ADD COLUMN can_assign_duty INTEGER NOT NULL DEFAULT 0');
  db.close();
  db = openDb(file);
  assert.ok(!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'can_assign_duty'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('off-duty marking is allowed but alerts admins; on-duty and admin marking does not', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const p2 = await s.as('p2');
  const admin = await s.as('admin');
  const { id, entry } = await publishedList(s, p1, admin);
  await admin(`/admin/lists/${id}/duty`, { method: 'PUT', body: { userIds: [userId(s, 'p2')] } });
  const save = (who, attendance) => who(`/lists/${id}/register`, { method: 'POST', body: { marks: [{ entryId: entry.id, attendance }] } });
  const alerts = async () => (await admin('/admin/summary')).body.alerts;

  assert.equal((await save(p2, 'present')).body.alerted, false);
  assert.equal((await alerts()).length, 0);
  assert.equal((await save(admin, 'absent')).body.alerted, false);
  assert.equal((await alerts()).length, 0);

  const off = await save(p1, 'present');
  assert.equal(off.status, 200);
  assert.equal(off.body.alerted, true);
  assert.equal((await p2(`/lists/${id}`)).body.entries[0].attendance, 'present');
  const [alert] = await alerts();
  assert.equal(alert.display_name, 'Prefect One');
  assert.equal(alert.changes, 1);

  assert.equal((await save(p1, 'absent')).body.alerted, true, 'each tap saves, but stays one alert');
  assert.equal((await alerts()).length, 1);
  assert.equal((await alerts())[0].changes, 2);

  assert.equal((await save(p1, 'absent')).body.alerted, false, 'saving with no real change raises nothing');
  assert.equal((await alerts()).length, 1);
  assert.equal((await admin('/admin/attention')).body.count, 1);
  assert.equal((await p1('/admin/attention')).status, 403);
  await admin(`/admin/alerts/${alert.id}/dismiss`, { method: 'POST', body: {} });
  assert.equal((await alerts()).length, 0);

  assert.equal((await save(p1, 'present')).body.alerted, true);
  assert.equal((await alerts()).length, 1, 'a new alert after dismissing');
  await admin(`/admin/alerts/${(await alerts())[0].id}/dismiss`, { method: 'POST', body: {} });

  assert.equal((await p1(`/lists/${id}/start`, { method: 'POST', body: {} })).body.alerted, true, 'off-duty start');
  assert.equal((await alerts())[0].changes, 0);
});

test('starting a session sets the clock once; marks save before and after', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  const { id, entry } = await publishedList(s, p1, admin);
  const started = async () => (await p1(`/lists/${id}`)).body.list.session_started_at;

  const mark = (attendance, entryId = entry.id) => p1(`/lists/${id}/register`, { method: 'POST', body: { marks: [{ entryId, attendance }] } });
  assert.equal((await mark('present')).status, 200);
  assert.equal(await started(), null, 'marking alone does not start the clock');
  assert.equal((await p1(`/lists/${id}`)).body.entries[0].attendance, 'present');

  assert.equal((await p1(`/lists/${id}/start`, { method: 'POST', body: {} })).status, 200);
  const first = await started();
  assert.ok(first);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await p1(`/lists/${id}/start`, { method: 'POST', body: {} });
  assert.equal(await started(), first, 'starting twice keeps the first time');
  const after = await mark('absent');
  assert.equal(await started(), first);
  assert.equal(after.body.entries[0].attendance, 'absent');
  assert.equal((await p1(`/lists/${id}`)).body.entries[0].attendance, 'absent');

  // Clearing a mark is a change too. An unknown entry is ignored, not fatal.
  await p1(`/lists/${id}/register`, { method: 'POST', body: { marks: [{ entryId: entry.id, attendance: null }, { entryId: 99999, attendance: 'present' }] } });
  assert.equal((await p1(`/lists/${id}`)).body.entries[0].attendance, null);
  assert.equal((await mark('maybe')).status, 400);

  await admin(`/lists/${id}/close`, { method: 'POST', body: {} });
  assert.equal((await p1(`/lists/${id}/start`, { method: 'POST', body: {} })).status, 409);
});

test('the late rule follows the time on the list', () => {
  const dress = { event_date: '2026-11-05', event_time: '6:45 AM' };
  const at = (list, hour, minute, second = 0, attendance = 'present') =>
    lists.isLate(list, { attendance, marked_at: new Date(2026, 10, 5, hour, minute, second).toISOString() });
  assert.equal(at(dress, 6, 30), false);
  assert.equal(at(dress, 6, 45, 59), false, '6:45 itself is on time');
  assert.equal(at(dress, 6, 46), true);
  assert.equal(at(dress, 7, 0, 0, 'absent'), false, 'only present students can be late');
  const manual = { event_date: '2026-11-05', event_time: '14:00 – 16:00' };
  assert.equal(at(manual, 13, 59), false);
  assert.equal(at(manual, 14, 1), true);
  assert.equal(at({ event_date: '2026-11-05', event_time: '2 PM' }, 14, 1), true);
  assert.equal(at({ event_date: '2026-11-05', event_time: '12:30 AM' }, 0, 31), true);
  assert.equal(at({ event_date: '2026-11-05', event_time: 'After break' }, 23, 0), false, 'no time, no flag');
  assert.equal(lists.isLate(dress, { attendance: 'present', marked_at: null }), false);
});

test('a student marked present after the list time comes back flagged late', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const admin = await s.as('admin');
  const { id, entry } = await publishedList(s, p1, admin);
  const mark = (attendance) => p1(`/lists/${id}/register`, { method: 'POST', body: { marks: [{ entryId: entry.id, attendance }] } });

  s.db.prepare("UPDATE lists SET event_date = '2099-01-01', event_time = '6:45 AM' WHERE id = ?").run(id);
  assert.equal((await mark('present')).body.entries[0].late, false, 'before the list time');
  await mark(null);
  s.db.prepare("UPDATE lists SET event_date = '2020-01-01' WHERE id = ?").run(id);
  const late = await mark('present');
  assert.equal(late.body.entries[0].late, true);
  assert.ok(late.body.entries[0].marked_at);
  assert.equal((await p1(`/lists/${id}`)).body.entries[0].late, true);
  assert.equal((await mark('absent')).body.entries[0].late, false);
  assert.equal((await p1(`/lists/${id}`)).body.entries[0].late, false);
});

test('only prefects on duty and admins can end a session; reopening resets the clock', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const p2 = await s.as('p2');
  const admin = await s.as('admin');
  const { id, entry } = await publishedList(s, p1, admin);
  await admin(`/admin/lists/${id}/duty`, { method: 'PUT', body: { userIds: [userId(s, 'p2')] } });
  await p1(`/lists/${id}/register`, { method: 'POST', body: { marks: [{ entryId: entry.id, attendance: 'present' }] } });
  await p1(`/lists/${id}/start`, { method: 'POST', body: {} });
  assert.ok((await p1(`/lists/${id}`)).body.list.session_started_at);

  assert.equal((await p1(`/lists/${id}/close`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await p2(`/lists/${id}/close`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await p1(`/lists/${id}/register`, { method: 'POST', body: { marks: [] } })).status, 409, 'closed registers cannot change');
  assert.equal((await admin(`/admin/lists/${id}/duty`, { method: 'PUT', body: { userIds: [] } })).status, 409);

  await admin(`/admin/lists/${id}/reopen`, { method: 'POST', body: {} });
  assert.equal((await p1(`/lists/${id}`)).body.list.session_started_at, null);
});

test('removing dummy prefects also clears their duty, alerts and session', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const p1 = await s.as('p1');
  const p2 = await s.as('p2');
  const admin = await s.as('admin');
  const { id, entry } = await publishedList(s, p1, admin);
  await admin(`/admin/lists/${id}/duty`, { method: 'PUT', body: { userIds: [userId(s, 'p2')] } });
  await admin(`/admin/lists/${id}/duty`, { method: 'PUT', body: { userIds: [userId(s, 'p2')] } });
  s.db.prepare("UPDATE users SET is_dummy = 1 WHERE username = 'p1'").run();
  s.db.prepare("UPDATE users SET is_dummy = 0 WHERE username = 'p2'").run();
  await p1(`/lists/${id}/register`, { method: 'POST', body: { marks: [{ entryId: entry.id, attendance: 'present' }] } });
  await p1(`/lists/${id}/start`, { method: 'POST', body: {} });
  assert.ok((await p2(`/lists/${id}`)).body.list.session_started_by);
  assert.equal((await admin('/admin/summary')).body.alerts.length, 1);
  assert.equal((await admin('/admin/remove-dummy-data', { method: 'POST', body: { confirm: 'DELETE' } })).status, 200);
  assert.equal((await admin('/admin/summary')).body.alerts.length, 0);
  assert.equal((await p2(`/lists/${id}`)).body.list.session_started_by, null);
});
