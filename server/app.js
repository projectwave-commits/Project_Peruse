'use strict';
const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const lists = require('./lists');
const studentsLib = require('./students');
const { buildListDocx } = require('./docx');
const { tx } = require('./db');

const { HttpError } = lists;
const COOKIE = 'prefects_session';
const MIN_PASSWORD = 8;
const LOG_LIMIT = 300;
const BULK_LIMIT = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function text(value, field, { required = true, max = 500 } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v && required) throw new HttpError(400, `${field} is required.`);
  if (v.length > max) throw new HttpError(400, `${field} is too long.`);
  return v || null;
}

function intParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'Not found');
  return n;
}

function eventDate(value) {
  if (!ISO_DATE.test(value || '') || Number.isNaN(Date.parse(value))) throw new HttpError(400, 'Please choose a valid date.');
  return value;
}

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // A leading = + - @ would run as a formula when the export is opened in Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createApp(db, { secureCookies = false, cookiePath = '/' } = {}) {
  const app = express();
  const limiter = new auth.LoginLimiter();
  app.disable('x-powered-by');
  // Only a proxy on this machine, such as nginx, can state the phone's address.
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
    })
  );

  const api = express.Router();
  api.use(express.json({ limit: '10mb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Browsers will not attach this header to a cross-site form post, which blocks CSRF.
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'prefects-app') {
      throw new HttpError(403, 'Bad request origin');
    }
    req.token = readCookie(req, COOKIE);
    req.user = auth.userForToken(db, req.token);
    next();
  });

  const setCookie = (res, token) =>
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: auth.SESSION_MS, path: cookiePath });

  api.post('/login', (req, res) => {
    const username = text(req.body.username, 'Username', { max: 100 });
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const key = `${username.toLowerCase()}|${req.ip}`;
    if (limiter.isLocked(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 10 minutes.');
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      limiter.fail(key);
      throw new HttpError(401, 'Wrong username or password.');
    }
    limiter.clear(key);
    setCookie(res, auth.createSession(db, user.id));
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    if (req.token) auth.deleteSession(db, req.token);
    res.clearCookie(COOKIE, { path: cookiePath });
    res.json({ ok: true });
  });

  const requireUser = (req, res, next) => {
    if (!req.user) throw new HttpError(401, 'Please log in.');
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Admins only.');
    next();
  };

  api.use(requireUser);

  api.get('/me', (req, res) => res.json(req.user));

  api.post('/me/password', (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!auth.verifyPassword(String(currentPassword || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong.');
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
      throw new HttpError(400, `The new password needs at least ${MIN_PASSWORD} characters.`);
    }
    if (newPassword === currentPassword || newPassword.toLowerCase() === auth.DEFAULT_PASSWORD.toLowerCase()) {
      throw new HttpError(400, 'Please choose a different password.');
    }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(newPassword), req.user.id);
    auth.deleteUserSessions(db, req.user.id);
    setCookie(res, auth.createSession(db, req.user.id));
    res.json({ ok: true });
  });

  // Temporary passwords are written on paper, so nothing else works until they are replaced.
  api.use((req, res, next) => {
    if (req.user.must_change_password) throw new HttpError(403, 'Please change your password first.');
    next();
  });

  // ---- Students and recording demerits ----

  api.get('/students', (req, res) => {
    res.json(studentsLib.searchStudents(db, String(req.query.q || '')));
  });

  function studentRecord(studentId, user) {
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    if (!student) throw new HttpError(404, 'Student not found');
    const types = db.prepare('SELECT * FROM list_types ORDER BY key').all();
    const isAdmin = user.role === 'admin';
    const demerits = db
      .prepare(
        `SELECT d.*, u.display_name AS created_by_name FROM demerits d JOIN users u ON u.id = d.created_by
         WHERE d.student_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 50`
      )
      .all(studentId)
      .filter((d) => isAdmin || !d.voided_at || d.created_by === user.id)
      .map((d) => {
        const mine = d.created_by === user.id;
        return {
          id: d.id,
          list_type: d.list_type,
          label: d.label,
          created_at: d.created_at,
          reported_by: d.reported_by,
          on_list: Boolean(d.list_entry_id),
          voided: Boolean(d.voided_at),
          expired: Boolean(d.expired_at),
          void_reason: isAdmin || mine ? d.void_reason : null,
          mine,
          // Other prefects' identity and notes are kept from prefects; the student may be their friend.
          note: isAdmin || mine ? d.note : null,
          created_by_name: isAdmin ? d.created_by_name : null,
          can_cancel: !d.voided_at && !d.list_entry_id && !d.expired_at && (isAdmin || mine),
        };
      });
    const entries = db
      .prepare(
        `SELECT e.id, e.list_id, e.reason, e.attendance, l.title, l.event_date, l.event_time, l.status, l.list_type
         FROM list_entries e JOIN lists l ON l.id = e.list_id
         WHERE e.student_id = ? AND e.removed_at IS NULL AND l.status IN ('draft','published')
         ORDER BY l.event_date`
      )
      .all(studentId);
    return { student, tallies: types.map((t) => lists.tally(db, studentId, t)), demerits, entries };
  }

  api.get('/students/:id', (req, res) => {
    res.json(studentRecord(intParam(req.params.id), req.user));
  });

  api.get('/offences', (req, res) => {
    res.json({
      types: db.prepare('SELECT key, name, threshold FROM list_types ORDER BY key').all(),
      offences: db
        .prepare('SELECT id, list_type, class, name, straight_to_list FROM offences WHERE active = 1 ORDER BY list_type, sort_order, name')
        .all(),
    });
  });

  // Two reports put a student on the list, so two prefects reporting one incident would be enough.
  function hasDemeritToday(studentId, offenceId, now) {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    return Boolean(
      db
        .prepare(
          `SELECT id FROM demerits WHERE student_id = ? AND offence_id = ? AND created_at >= ? AND voided_at IS NULL AND expired_at IS NULL LIMIT 1`
        )
        .get(studentId, offenceId, midnight)
    );
  }

  function addDemerit(studentId, offence, { straight, note = null, reportedBy = null }, user, now) {
    return Number(
      db
        .prepare(
          `INSERT INTO demerits (student_id, list_type, offence_id, label, straight_to_list, note, reported_by, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(studentId, offence.list_type, offence.id, lists.offenceLabel(offence), straight, note, reportedBy, user.id, now.toISOString())
        .lastInsertRowid
    );
  }

  api.post('/demerits', (req, res) => {
    const studentId = intParam(req.body.studentId);
    const student = db.prepare('SELECT id FROM students WHERE id = ? AND active = 1').get(studentId);
    if (!student) throw new HttpError(404, 'Student not found');
    const offence = db.prepare('SELECT * FROM offences WHERE id = ? AND active = 1').get(intParam(req.body.offenceId));
    if (!offence) throw new HttpError(404, 'That demerit type is no longer available.');
    const note = text(req.body.note, 'Note', { required: false });
    const reportedBy = text(req.body.reportedBy, 'Teacher name', { required: false, max: 100 });

    const now = new Date();
    if (hasDemeritToday(studentId, offence.id, now) && !req.body.confirmDuplicate) {
      throw new HttpError(409, 'This student already has this demerit today. Is this a separate incident?', { code: 'duplicate' });
    }

    const straight = offence.straight_to_list || (reportedBy && req.body.straightToList) ? 1 : 0;
    const id = addDemerit(studentId, offence, { straight, note, reportedBy }, req.user, now);
    const type = db.prepare('SELECT * FROM list_types WHERE key = ?').get(offence.list_type);
    res.status(201).json({ id, straight: Boolean(straight), tally: lists.tally(db, studentId, type) });
  });

  // All or nothing, so a problem with one student never leaves a batch half recorded.
  api.post('/demerits/bulk', (req, res) => {
    const type = db.prepare('SELECT * FROM list_types WHERE key = ?').get(String(req.body.listType));
    if (!type) throw new HttpError(400, 'Choose Dress Parade or Manual Labour.');
    const offence = db.prepare('SELECT * FROM offences WHERE id = ? AND active = 1 AND list_type = ?').get(intParam(req.body.offenceId), type.key);
    if (!offence) throw new HttpError(400, `Choose a ${type.name} reason.`);
    if (offence.straight_to_list && req.user.role !== 'admin') throw new HttpError(403, 'Only admins can bulk upload that reason.');
    const studentIds = Array.isArray(req.body.studentIds) ? req.body.studentIds : [];
    if (!studentIds.length) throw new HttpError(400, 'Add at least one student.');
    if (studentIds.length > BULK_LIMIT) throw new HttpError(400, `Please upload at most ${BULK_LIMIT} students at a time.`);

    const seen = new Set();
    const rows = studentIds.map((studentId) => {
      const student = db.prepare('SELECT id, first_name, surname FROM students WHERE id = ? AND active = 1').get(intParam(studentId));
      if (!student) throw new HttpError(404, 'One of these students is no longer active. Please remove them and try again.');
      const name = `${student.first_name} ${student.surname}`;
      if (seen.has(student.id)) throw new HttpError(400, `${name} is listed twice.`);
      seen.add(student.id);
      return { student, name };
    });

    const now = new Date();
    const duplicates = rows.filter((r) => hasDemeritToday(r.student.id, offence.id, now)).map((r) => r.name);
    if (duplicates.length && !req.body.confirmDuplicate) {
      throw new HttpError(409, 'Some of these students already have this demerit today.', { code: 'duplicate', duplicates });
    }

    const listed = tx(db, () => rows.filter((r) => {
      const before = lists.tally(db, r.student.id, type).listed;
      addDemerit(r.student.id, offence, { straight: offence.straight_to_list }, req.user, now);
      return lists.tally(db, r.student.id, type).listed > before;
    })).map((r) => r.name);
    res.status(201).json({ count: rows.length, listed, listName: type.name });
  });

  api.post('/demerits/:id/cancel', (req, res) => {
    const reason = text(req.body.reason, 'Reason', { required: false }) || 'Cancelled';
    lists.voidDemerit(db, intParam(req.params.id), reason, req.user);
    res.json({ ok: true });
  });

  api.get('/demerits/mine', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT d.id, d.student_id, d.list_type, d.label, d.created_at, d.voided_at, d.expired_at, d.list_entry_id, d.reported_by,
                  s.first_name, s.surname, s.form
           FROM demerits d JOIN students s ON s.id = d.student_id
           WHERE d.created_by = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 50`
        )
        .all(req.user.id)
    );
  });

  // ---- Lists and registers ----

  // The first bound parameter is always the viewer's user id, for on_duty.
  const listSummary = `SELECT l.*, t.name AS type_name,
      EXISTS (SELECT 1 FROM list_duty x WHERE x.list_id = l.id AND x.user_id = ?) AS on_duty,
      (SELECT COUNT(*) FROM list_entries e WHERE e.list_id = l.id AND e.removed_at IS NULL) AS entry_count,
      (SELECT COUNT(*) FROM list_entries e WHERE e.list_id = l.id AND e.removed_at IS NULL AND e.query_note IS NOT NULL) AS query_count
    FROM lists l JOIN list_types t ON t.key = l.list_type`;

  api.get('/lists', (req, res) => {
    res.json(
      db.prepare(`${listSummary} ORDER BY CASE l.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, l.event_date DESC, l.id DESC LIMIT 60`).all(req.user.id)
    );
  });

  api.get('/lists/:id', (req, res) => {
    const id = intParam(req.params.id);
    const list = db.prepare(`${listSummary} WHERE l.id = ?`).get(req.user.id, id);
    if (!list) throw new HttpError(404, 'List not found');
    const isAdmin = req.user.role === 'admin';
    const entries = lists.listEntries(db, id).map((e) => ({
      id: e.id,
      student_id: e.student_id,
      first_name: e.first_name,
      surname: e.surname,
      form: e.form,
      entry_date: e.entry_date,
      reported_by: e.reported_by,
      reason: e.reason,
      carried: Boolean(e.carried_from_entry_id),
      attendance: e.attendance,
      marked_at: e.marked_at,
      late: lists.isLate(list, e),
      query_note: e.query_note,
      query_by_name: isAdmin ? e.query_by_name : null,
      marked_by_name: isAdmin ? e.marked_by_name : null,
    }));
    const duty = db
      .prepare('SELECT u.id, u.display_name FROM list_duty d JOIN users u ON u.id = d.user_id WHERE d.list_id = ? ORDER BY u.display_name')
      .all(id);
    res.json({ list, entries, duty, server_now: new Date().toISOString() });
  });

  api.post('/lists/:id/register', (req, res) => {
    const marks = Array.isArray(req.body.marks) ? req.body.marks : [];
    res.json(
      lists.saveRegister(
        db,
        intParam(req.params.id),
        marks.map((m) => ({ entryId: Number(m.entryId), attendance: m.attendance ?? null })),
        req.user
      )
    );
  });

  api.post('/lists/:id/start', (req, res) => {
    res.json(lists.startSession(db, intParam(req.params.id), req.user));
  });

  api.post('/lists/:id/close', (req, res) => {
    const id = intParam(req.params.id);
    if (req.user.role !== 'admin' && !lists.isOnDuty(db, id, req.user.id)) {
      throw new HttpError(403, 'Only prefects on duty or admins can end a session.');
    }
    res.json({ absent: lists.closeList(db, id, req.user) });
  });

  api.post('/entries/:id/query', (req, res) => {
    lists.queryEntry(db, intParam(req.params.id), text(req.body.note, 'Your query'), req.user);
    res.json({ ok: true });
  });

  // ---- Admin ----

  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/summary', (req, res) => {
    res.json({
      queries: db
        .prepare(
          `SELECT e.id, e.list_id, e.query_note, s.first_name, s.surname, s.form, l.title, u.display_name AS query_by_name
           FROM list_entries e
           JOIN students s ON s.id = e.student_id
           JOIN lists l ON l.id = e.list_id
           LEFT JOIN users u ON u.id = e.query_by
           WHERE e.query_note IS NOT NULL AND e.removed_at IS NULL
           ORDER BY e.query_at`
        )
        .all(),
      previews: db.prepare('SELECT key FROM list_types ORDER BY key').all().map(({ key }) => ({ key, ...lists.preview(db, key) })),
      term: lists.termStatus(db),
      alerts: db
        .prepare(
          `SELECT a.id, a.list_id, a.changes, a.created_at, u.display_name, t.name AS type_name, l.event_date
           FROM register_alerts a
           JOIN users u ON u.id = a.user_id
           JOIN lists l ON l.id = a.list_id
           JOIN list_types t ON t.key = l.list_type
           WHERE a.dismissed_at IS NULL ORDER BY a.created_at DESC`
        )
        .all(),
      hasDummy: Boolean(
        db.prepare('SELECT 1 AS x FROM students WHERE is_dummy = 1 UNION SELECT 1 FROM users WHERE is_dummy = 1 LIMIT 1').get()
      ),
    });
  });

  admin.get('/attention', (req, res) => {
    const { n } = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM register_alerts WHERE dismissed_at IS NULL)
              + (SELECT COUNT(*) FROM list_entries WHERE query_note IS NOT NULL AND removed_at IS NULL) AS n`
      )
      .get();
    res.json({ count: n });
  });

  admin.post('/alerts/:id/dismiss', (req, res) => {
    db.prepare('UPDATE register_alerts SET dismissed_at = ? WHERE id = ?').run(new Date().toISOString(), intParam(req.params.id));
    res.json({ ok: true });
  });

  admin.post('/term/start', (req, res) => {
    res.json({ cleared: lists.startNewTerm(db, req.user) });
  });

  admin.post('/term/undo', (req, res) => {
    res.json({ restored: lists.undoNewTerm(db) });
  });

  function listFields(body) {
    return {
      title: text(body.title, 'Title', { max: 100 }),
      eventDate: eventDate(body.eventDate),
      eventTime: text(body.eventTime, 'Time', { required: false, max: 100 }) || '',
      instructions: text(body.instructions, 'Instructions', { required: false, max: 2000 }) || '',
    };
  }

  admin.get('/lists/preview', (req, res) => {
    res.json(lists.preview(db, String(req.query.type)));
  });

  admin.post('/lists', (req, res) => {
    const id = lists.createDraft(db, { listType: String(req.body.listType), ...listFields(req.body) }, req.user);
    res.status(201).json({ id });
  });

  admin.patch('/lists/:id', (req, res) => {
    const id = intParam(req.params.id);
    lists.getList(db, id);
    const f = listFields(req.body);
    db.prepare('UPDATE lists SET title = ?, event_date = ?, event_time = ?, instructions = ? WHERE id = ?').run(
      f.title, f.eventDate, f.eventTime, f.instructions, id
    );
    res.json({ ok: true });
  });

  admin.delete('/lists/:id', (req, res) => {
    lists.discardDraft(db, intParam(req.params.id));
    res.json({ ok: true });
  });

  admin.post('/lists/:id/publish', (req, res) => {
    lists.publishList(db, intParam(req.params.id));
    res.json({ ok: true });
  });

  admin.post('/lists/:id/reopen', (req, res) => {
    lists.reopenList(db, intParam(req.params.id));
    res.json({ ok: true });
  });

  admin.get('/lists/:id/export.docx', async (req, res) => {
    const id = intParam(req.params.id);
    const list = lists.getList(db, id);
    const buffer = await buildListDocx(list, lists.listEntries(db, id));
    const name = `${list.title} ${list.event_date}`.replace(/[^\w -]+/g, '').replace(/\s+/g, '_');
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${name}.docx"`);
    res.send(buffer);
  });

  admin.get('/entries/:id/demerits', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT d.id, d.label, d.note, d.reported_by, d.created_at, u.display_name AS created_by_name
           FROM demerits d JOIN users u ON u.id = d.created_by WHERE d.list_entry_id = ? ORDER BY d.created_at`
        )
        .all(intParam(req.params.id))
    );
  });

  admin.post('/entries/:id/remove', (req, res) => {
    const keep = Array.isArray(req.body.keepDemeritIds) ? req.body.keepDemeritIds.map(Number) : [];
    lists.removeEntry(db, intParam(req.params.id), text(req.body.reason, 'Reason'), keep, req.user);
    res.json({ ok: true });
  });

  admin.post('/entries/:id/query/dismiss', (req, res) => {
    lists.dismissQuery(db, intParam(req.params.id));
    res.json({ ok: true });
  });

  // Demerit types and list settings

  admin.get('/settings', (req, res) => {
    res.json({
      types: db.prepare('SELECT * FROM list_types ORDER BY key').all(),
      offences: db.prepare('SELECT * FROM offences ORDER BY list_type, active DESC, sort_order, name').all(),
    });
  });

  admin.patch('/list-types/:key', (req, res) => {
    const threshold = Number(req.body.threshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 20) throw new HttpError(400, 'Demerits needed must be between 1 and 20.');
    const result = db
      .prepare('UPDATE list_types SET threshold = ?, default_time = ?, default_instructions = ? WHERE key = ?')
      .run(threshold, text(req.body.defaultTime, 'Time', { required: false, max: 100 }) || '',
        text(req.body.defaultInstructions, 'Instructions', { required: false, max: 2000 }) || '', req.params.key);
    if (!result.changes) throw new HttpError(404, 'Unknown list type');
    res.json({ ok: true });
  });

  function offenceFields(body) {
    const cls = body.class || null;
    if (cls !== null && !['C1', 'C2'].includes(cls)) throw new HttpError(400, 'Class must be C1 or C2.');
    return { name: text(body.name, 'Name', { max: 100 }), cls, straight: body.straightToList ? 1 : 0 };
  }

  function uniqueOffence(fn) {
    try {
      return fn();
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'That demerit type already exists on this list.');
      throw err;
    }
  }

  admin.post('/offences', (req, res) => {
    const f = offenceFields(req.body);
    const listType = String(req.body.listType);
    if (!db.prepare('SELECT 1 AS x FROM list_types WHERE key = ?').get(listType)) throw new HttpError(400, 'Unknown list type');
    const { next } = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM offences').get();
    uniqueOffence(() =>
      db.prepare('INSERT INTO offences (list_type, class, name, straight_to_list, sort_order) VALUES (?, ?, ?, ?, ?)').run(
        listType, f.cls, f.name, f.straight, next
      )
    );
    res.status(201).json({ ok: true });
  });

  admin.patch('/offences/:id', (req, res) => {
    const f = offenceFields(req.body);
    const result = uniqueOffence(() =>
      db.prepare('UPDATE offences SET class = ?, name = ?, straight_to_list = ?, active = ? WHERE id = ?').run(
        f.cls, f.name, f.straight, req.body.active === false ? 0 : 1, intParam(req.params.id)
      )
    );
    if (!result.changes) throw new HttpError(404, 'Not found');
    res.json({ ok: true });
  });

  // Students

  admin.get('/students', (req, res) => {
    const counts = db
      .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active, COALESCE(SUM(is_dummy), 0) AS dummy FROM students')
      .get();
    res.json({ counts, results: studentsLib.searchStudents(db, String(req.query.q || '')) });
  });

  function studentFields(body) {
    return {
      first: text(body.firstName, 'First name', { max: 100 }),
      surname: text(body.surname, 'Surname', { max: 100 }),
      form: text(body.form, 'Form', { max: 50 }),
      no: text(body.studentNo, 'Student number', { required: false, max: 50 }),
    };
  }

  function uniqueStudentNo(fn) {
    try {
      return fn();
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'Another student already has that student number.');
      throw err;
    }
  }

  admin.post('/students', (req, res) => {
    const s = studentFields(req.body);
    const result = uniqueStudentNo(() =>
      db.prepare('INSERT INTO students (first_name, surname, form, student_no) VALUES (?, ?, ?, ?)').run(s.first, s.surname, s.form, s.no)
    );
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  admin.patch('/students/:id', (req, res) => {
    const s = studentFields(req.body);
    const result = uniqueStudentNo(() =>
      db.prepare('UPDATE students SET first_name = ?, surname = ?, form = ?, student_no = ?, active = ? WHERE id = ?').run(
        s.first, s.surname, s.form, s.no, req.body.active === false ? 0 : 1, intParam(req.params.id)
      )
    );
    if (!result.changes) throw new HttpError(404, 'Not found');
    res.json({ ok: true });
  });

  admin.post('/students/import', (req, res) => {
    const csv = typeof req.body.csv === 'string' ? req.body.csv : '';
    res.json(studentsLib.importStudents(db, csv, { deactivateMissing: Boolean(req.body.deactivateMissing) }));
  });

  admin.post('/remove-dummy-data', (req, res) => {
    if (req.body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
    res.json(studentsLib.removeDummyData(db));
  });

  // Prefect and admin accounts

  admin.get('/users', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT u.id, u.username, u.display_name, u.role, u.active, u.must_change_password,
             (SELECT COUNT(*) FROM demerits d WHERE d.created_by = u.id AND d.voided_at IS NULL) AS demerit_count,
             (SELECT MAX(d.created_at) FROM demerits d WHERE d.created_by = u.id) AS last_demerit_at
           FROM users u ORDER BY u.active DESC, u.role, u.display_name`
        )
        .all()
    );
  });

  admin.get('/duty-candidates', (req, res) => {
    res.json(db.prepare("SELECT id, display_name FROM users WHERE role = 'prefect' AND active = 1 ORDER BY display_name").all());
  });

  admin.put('/lists/:id/duty', (req, res) => {
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number) : [];
    lists.setDuty(db, intParam(req.params.id), userIds);
    res.json({ ok: true });
  });

  const roleOf = (value) => {
    if (!['prefect', 'admin'].includes(value)) throw new HttpError(400, 'Invalid role');
    return value;
  };

  admin.post('/users', (req, res) => {
    const password = auth.DEFAULT_PASSWORD;
    try {
      db.prepare(
        `INSERT INTO users (username, display_name, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)`
      ).run(
        text(req.body.username, 'Username', { max: 50 }),
        text(req.body.displayName, 'Name', { max: 100 }),
        roleOf(req.body.role),
        auth.hashPassword(password),
        new Date().toISOString()
      );
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'That username is already taken.');
      throw err;
    }
    res.status(201).json({ tempPassword: password });
  });

  admin.patch('/users/:id', (req, res) => {
    const id = intParam(req.params.id);
    const active = req.body.active === false ? 0 : 1;
    const role = roleOf(req.body.role);
    if (id === req.user.id && (!active || role !== 'admin')) {
      throw new HttpError(400, 'You cannot remove your own admin access.');
    }
    const result = db
      .prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?')
      .run(text(req.body.displayName, 'Name', { max: 100 }), role, active, id);
    if (!result.changes) throw new HttpError(404, 'Not found');
    if (!active) auth.deleteUserSessions(db, id);
    res.json({ ok: true });
  });

  admin.post('/users/:id/reset-password', (req, res) => {
    const id = intParam(req.params.id);
    const password = auth.tempPassword();
    const result = tx(db, () => {
      auth.deleteUserSessions(db, id);
      return db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(password), id);
    });
    if (!result.changes) throw new HttpError(404, 'Not found');
    res.json({ tempPassword: password });
  });

  // Full demerit log

  function logQuery(query, limit) {
    const where = [];
    const params = [];
    if (['dress', 'manual'].includes(query.type)) {
      where.push('d.list_type = ?');
      params.push(query.type);
    }
    if (query.status === 'waiting') where.push('d.voided_at IS NULL AND d.expired_at IS NULL AND d.list_entry_id IS NULL');
    if (query.status === 'earlier') where.push('d.voided_at IS NULL AND d.expired_at IS NOT NULL');
    if (query.status === 'listed') where.push('d.voided_at IS NULL AND d.list_entry_id IS NOT NULL');
    if (query.status === 'cancelled') where.push('d.voided_at IS NOT NULL');
    if (query.prefect) {
      where.push('d.created_by = ?');
      params.push(Number(query.prefect));
    }
    if (query.q) {
      where.push("(s.first_name || ' ' || s.surname || ' ' || s.form LIKE ? OR u.display_name LIKE ? OR d.label LIKE ?)");
      const like = `%${String(query.q).replace(/[%_]/g, '')}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT d.id, d.student_id, d.list_type, d.label, d.note, d.reported_by, d.created_at, d.list_entry_id,
        d.voided_at, d.void_reason, d.expired_at, s.first_name, s.surname, s.form, u.display_name AS created_by_name
      FROM demerits d JOIN students s ON s.id = d.student_id JOIN users u ON u.id = d.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.created_at DESC, d.id DESC ${limit ? `LIMIT ${limit}` : ''}`;
    return db.prepare(sql).all(...params);
  }

  const statusOf = (d) => (d.voided_at ? 'Cancelled' : d.list_entry_id ? 'On a list' : d.expired_at ? 'Earlier term' : 'Waiting');

  admin.get('/demerits', (req, res) => res.json(logQuery(req.query, LOG_LIMIT)));

  admin.get('/demerits.csv', (req, res) => {
    const head = ['Date', 'Surname', 'First name', 'Form', 'List', 'Demerit', 'Recorded by', 'Reported by teacher', 'Note', 'Status', 'Cancel reason'];
    const lines = logQuery(req.query).map((d) =>
      [lists.localDate(d.created_at), d.surname, d.first_name, d.form, d.list_type === 'manual' ? 'Manual Labour' : 'Dress Parade',
        d.label, d.created_by_name, d.reported_by, d.note, statusOf(d), d.void_reason].map(csvCell).join(',')
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="demerits.csv"');
    res.send(`﻿${[head.join(','), ...lines].join('\r\n')}\r\n`);
  });

  api.use('/admin', admin);
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong on the server.' : err.message;
    res.status(status).json({ error: message, ...(err.extra || {}) });
  });

  return app;
}

module.exports = { createApp };
