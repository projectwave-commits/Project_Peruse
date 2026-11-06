const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  db, tx, now, audit, getSetting, setSetting, seedConfig, backup,
} = require('./src/db');
const {
  allOptions, getOption, getStudent, isEligible, optionCounts, unavailableReason,
  selectionsFor, missingRequirements, syncCompletion, cleanSessions, FORM_ORDER,
} = require('./src/rules');
const { timesFor } = require('./src/timetable');
const { readWorkbook, applyStudents, parseClassName } = require('./src/importer');
const { formWorkbook, rosterWorkbook, allRostersWorkbook, rosterRows } = require('./src/exporter');

const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const HOST = process.env.HOST || '0.0.0.0';
// Staff sign in once, on the home page, with an account from the demerits app. This asks that app whose
// session a request carries. Staff are planned to sign in with their main portal accounts instead.
const SIGN_IN_URL = process.env.SIGN_IN_URL || 'http://127.0.0.1:3080/api/me';
const CLASS_LIST_DIR = process.env.CLASS_LIST_DIR ?? path.join(__dirname, 'class-lists');

const app = express();
app.disable('x-powered-by');
// Only a proxy on this machine, such as nginx, can state the device's address.
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  next();
});
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const intParam = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(404, 'Not found');
  return n;
};
const requireStudent = (id) => {
  const student = getStudent(intParam(id));
  if (!student) fail(404, 'Student not found');
  return student;
};
const requireOption = (id) => {
  const option = getOption(intParam(id));
  if (!option) fail(404, 'Option not found');
  return option;
};

// ---- Student screens ---------------------------------------------------------
// Students are identified by choosing their own name while a teacher supervises,
// so these routes have no login. They reveal only names and done/not-done status,
// and registration can be closed from the staff screens between sessions.

const isOpen = () => getSetting('registration_open') === '1';
const requireOpen = (req, res, next) => {
  if (!isOpen()) return res.status(423).json({ error: 'Registration is closed. Please ask your teacher.' });
  next();
};

const notesForStudents = (text) => text.split('\n').map((l) => l.replace(/\*\*/g, '').trim()).filter(Boolean);

app.get('/api/info', (req, res) => {
  res.json({
    school: getSetting('school_name'),
    term: getSetting('term_label'),
    open: isOpen(),
    sportTimetable: getSetting('sport_timetable_url'),
    clubTimetable: getSetting('club_timetable_url'),
    sportNotes: notesForStudents(getSetting('sport_notes')),
    clubNotes: notesForStudents(getSetting('club_notes')),
    admissionNote: getSetting('club_admission_note'),
  });
});

function classSummary() {
  return db.prepare(`
    SELECT form_label, form_level, class_name, COUNT(*) AS total,
           SUM(CASE WHEN submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS done
    FROM students WHERE active = 1
    GROUP BY class_name ORDER BY form_level, class_name`).all();
}

function groupByForm(classes) {
  const forms = new Map();
  for (const c of classes) {
    if (!forms.has(c.form_label)) forms.set(c.form_label, { label: c.form_label, level: c.form_level, classes: [] });
    forms.get(c.form_label).classes.push(c);
  }
  return [...forms.values()];
}

app.get('/api/classes', requireOpen, (req, res) => {
  res.json(groupByForm(classSummary()));
});

app.get('/api/classes/:name/students', requireOpen, (req, res) => {
  const rows = db.prepare(`SELECT id, name, submitted_at IS NOT NULL AS done
    FROM students WHERE active = 1 AND class_name = ? ORDER BY name`).all(req.params.name);
  if (!rows.length) fail(404, 'Class not found');
  res.json(rows);
});

const optionGroup = (o) => {
  if (o.category === 'sport') return o.is_primary ? 'primary' : 'sport';
  return o.counts_as_club ? 'club' : 'extra';
};

app.get('/api/students/:id/choices', requireOpen, (req, res) => {
  const student = requireStudent(req.params.id);
  if (!student.active) fail(404, 'Student not found');
  if (student.submitted_at) fail(409, 'These choices have already been saved. Please see your teacher to change them.');

  const counts = optionCounts();
  const current = new Map(selectionsFor(student.id).map((s) => [s.id, s]));
  const options = allOptions()
    .filter((o) => o.active && (isEligible(o, student) || current.has(o.id)))
    .map((o) => ({
      id: o.id,
      name: o.name,
      group: optionGroup(o),
      note: o.note,
      sessions: o.sessions,
      times: timesFor(o, student),
      unavailable: current.has(o.id) ? null : unavailableReason(o, counts.get(o.id) || 0),
      selected: current.has(o.id),
      chosenSessions: current.get(o.id)?.chosen_sessions ? current.get(o.id).chosen_sessions.split(',') : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    student: { id: student.id, name: student.name, className: student.class_name, sportExempt: !!student.sport_exempt },
    options,
  });
});

app.post('/api/students/:id/submit', requireOpen, (req, res) => {
  const submitted = Array.isArray(req.body?.selections) ? req.body.selections : fail(400, 'No choices were sent.');
  const student = requireStudent(req.params.id);
  if (!student.active) fail(404, 'Student not found');

  tx(() => {
    const fresh = getStudent(student.id);
    if (fresh.submitted_at) fail(409, 'These choices have already been saved. Please see your teacher to change them.');

    const before = new Map(selectionsFor(student.id).map((s) => [s.id, s]));
    const counts = optionCounts();
    const chosen = new Map();

    for (const item of submitted) {
      const option = getOption(Number(item?.optionId));
      if (!option || !option.active) fail(400, 'One of your choices is no longer available. Please go back and try again.');
      const alreadyHeld = before.has(option.id);
      if (!alreadyHeld) {
        if (!isEligible(option, student)) fail(400, `${option.name} is not available to you.`);
        const reason = unavailableReason(option, counts.get(option.id) || 0);
        if (reason) fail(409, `${option.name} has just filled up. Please choose something else.`);
      }
      chosen.set(option.id, { ...option, chosen_sessions: cleanSessions(option, item.sessions) });
    }

    const list = [...chosen.values()];
    const missing = missingRequirements(student, list);
    if (missing.length) fail(400, `You still need to choose ${missing.join(' and ')}.`);

    const time = now();
    db.prepare('DELETE FROM selections WHERE student_id = ?').run(student.id);
    const insert = db.prepare(`INSERT INTO selections (student_id, option_id, sessions, added_by, added_at)
      VALUES (?, ?, ?, 'Student', ?)`);
    for (const o of list) insert.run(student.id, o.id, o.chosen_sessions, time);
    db.prepare(`UPDATE students SET submitted_at = ?, submitted_by = 'Student' WHERE id = ?`).run(time, student.id);
    audit('Student', `${student.class_name}: ${student.name}`,
      `Submitted: ${list.map((o) => o.header).join(', ')} (device ${req.ip})`);
  });
  res.json({ ok: true });
});

// ---- Staff sign-in -----------------------------------------------------------
const SIGN_IN_COOKIE = 'prefects_session';
// A short memory of answers, so each click does not ask the demerits app again.
const CHECK_MS = 30 * 1000;
const checked = new Map();

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function signedInUser(req) {
  const token = readCookie(req, SIGN_IN_COOKIE);
  if (!token) return null;
  const known = checked.get(token);
  if (known && known.until > Date.now()) return known.user;
  // Only the sign-in cookie is passed on, never the request's other cookies.
  const res = await fetch(SIGN_IN_URL, { headers: { cookie: `${SIGN_IN_COOKIE}=${token}` }, signal: AbortSignal.timeout(5000) });
  if (res.status === 401) {
    checked.delete(token);
    return null;
  }
  if (!res.ok) throw new Error(`The sign-in check answered ${res.status}.`);
  const user = await res.json();
  if (checked.size > 1000) checked.clear();
  checked.set(token, { user, until: Date.now() + CHECK_MS });
  return user;
}

async function requireStaff(req, res, next) {
  let user;
  try {
    user = await signedInUser(req);
  } catch {
    return res.status(503).json({ error: 'Cannot check your sign-in right now. Please try again in a moment.' });
  }
  if (!user) return res.status(401).json({ error: 'Please sign in on the home page.' });
  if (user.role !== 'admin' || user.must_change_password) return res.status(403).json({ error: 'This page is for staff.' });
  req.staff = user.display_name;
  next();
}

const staff = express.Router();
staff.use(requireStaff);
app.use('/api/staff', staff);

staff.get('/me', (req, res) => res.json({ name: req.staff }));

// ---- Progress ----------------------------------------------------------------
staff.get('/progress', (req, res) => {
  const forms = groupByForm(classSummary());
  res.json({
    open: isOpen(),
    term: getSetting('term_label'),
    forms: forms.map((f) => ({
      ...f,
      total: f.classes.reduce((sum, c) => sum + c.total, 0),
      done: f.classes.reduce((sum, c) => sum + c.done, 0),
    })),
  });
});

function studentRow(s) {
  const selections = selectionsFor(s.id);
  return {
    id: s.id,
    name: s.name,
    gender: s.gender,
    dob: s.dob,
    className: s.class_name,
    formLabel: s.form_label,
    active: !!s.active,
    sportExempt: !!s.sport_exempt,
    note: s.note,
    submittedAt: s.submitted_at,
    submittedBy: s.submitted_by,
    choices: selections.map((o) => ({
      id: o.id,
      header: o.header,
      name: o.name,
      sessions: o.chosen_sessions,
    })),
    missing: missingRequirements(s, selections),
  };
}

staff.get('/classes/:name', (req, res) => {
  const rows = db.prepare('SELECT * FROM students WHERE class_name = ? AND active = 1 ORDER BY name').all(req.params.name);
  if (!rows.length) fail(404, 'Class not found');
  res.json(rows.map(studentRow));
});

staff.get('/students/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const rows = db.prepare(`SELECT * FROM students WHERE active = 1 AND name LIKE ? ESCAPE '\\' ORDER BY ${FORM_ORDER} LIMIT 25`)
    .all(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
  const option = req.query.optionId ? getOption(Number(req.query.optionId)) : null;
  const held = option
    ? new Set(db.prepare('SELECT student_id FROM selections WHERE option_id = ?').all(option.id).map((r) => r.student_id))
    : new Set();
  res.json(rows.map((s) => ({
    id: s.id,
    name: s.name,
    className: s.class_name,
    done: !!s.submitted_at,
    started: selectionsFor(s.id).length > 0,
    eligible: option ? isEligible(option, s) : true,
    alreadyAdded: held.has(s.id),
  })));
});

// ---- One student (staff) -----------------------------------------------------
staff.get('/students/:id', (req, res) => {
  const student = requireStudent(req.params.id);
  const counts = optionCounts();
  res.json({
    student: studentRow(student),
    options: allOptions().filter((o) => o.active).map((o) => ({
      id: o.id,
      header: o.header,
      name: o.name,
      category: o.category,
      gender: o.gender,
      group: optionGroup(o),
      sessions: o.sessions,
      times: timesFor(o, student),
      eligible: isEligible(o, student),
      unavailable: unavailableReason(o, counts.get(o.id) || 0),
    })),
  });
});

/** Replace a student's choices. Staff may override eligibility and limits. */
staff.put('/students/:id/selections', (req, res) => {
  const student = requireStudent(req.params.id);
  const submitted = Array.isArray(req.body?.selections) ? req.body.selections : fail(400, 'No choices were sent.');
  tx(() => {
    const before = new Map(selectionsFor(student.id).map((o) => [o.id, o]));
    const after = new Map();
    for (const item of submitted) {
      const option = getOption(Number(item?.optionId));
      if (!option) fail(400, 'Unknown option.');
      after.set(option.id, { option, sessions: cleanSessions(option, item.sessions) });
    }
    const removed = [...before.values()].filter((o) => !after.has(o.id));
    const added = [...after.values()].filter((a) => !before.has(a.option.id));

    for (const o of removed) {
      db.prepare('DELETE FROM selections WHERE student_id = ? AND option_id = ?').run(student.id, o.id);
    }
    const upsert = db.prepare(`INSERT INTO selections (student_id, option_id, sessions, added_by, added_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (student_id, option_id) DO UPDATE SET sessions = excluded.sessions`);
    for (const { option, sessions } of after.values()) upsert.run(student.id, option.id, sessions, req.staff, now());

    if (removed.length || added.length) {
      const parts = [];
      if (added.length) parts.push(`Added ${added.map((a) => a.option.header).join(', ')}`);
      if (removed.length) parts.push(`Removed ${removed.map((o) => o.header).join(', ')}`);
      audit(req.staff, `${student.class_name}: ${student.name}`, parts.join('; '));
    }
    syncCompletion(student.id, req.staff);
  });
  res.json(studentRow(getStudent(student.id)));
});

staff.post('/students/:id/unlock', (req, res) => {
  const student = requireStudent(req.params.id);
  db.prepare('UPDATE students SET submitted_at = NULL, submitted_by = NULL WHERE id = ?').run(student.id);
  audit(req.staff, `${student.class_name}: ${student.name}`, 'Unlocked so the student can choose again');
  res.json(studentRow(getStudent(student.id)));
});

staff.patch('/students/:id', (req, res) => {
  const student = requireStudent(req.params.id);
  const body = req.body || {};
  const changes = { ...student };

  if (body.name !== undefined) changes.name = String(body.name).trim() || fail(400, 'A name is required.');
  if (body.gender !== undefined) {
    if (!['M', 'F'].includes(body.gender)) fail(400, 'Gender must be M or F.');
    changes.gender = body.gender;
  }
  if (body.dob !== undefined) {
    if (body.dob && !/^\d{4}-\d{2}-\d{2}$/.test(body.dob)) fail(400, 'Date of birth must be a valid date.');
    changes.dob = body.dob || null;
  }
  if (body.className !== undefined) {
    const cls = parseClassName(body.className) || fail(400, 'Class must look like "Form 4B" or "Lower 6G".');
    Object.assign(changes, cls);
  }
  if (body.note !== undefined) changes.note = String(body.note).slice(0, 200);
  if (body.sportExempt !== undefined) changes.sport_exempt = body.sportExempt ? 1 : 0;
  if (body.active !== undefined) changes.active = body.active ? 1 : 0;

  tx(() => {
    try {
      db.prepare(`UPDATE students SET name = ?, gender = ?, dob = ?, form_level = ?, form_label = ?, class_name = ?,
        note = ?, sport_exempt = ?, active = ? WHERE id = ?`)
        .run(changes.name, changes.gender, changes.dob, changes.form_level, changes.form_label, changes.class_name,
          changes.note, changes.sport_exempt, changes.active, student.id);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) fail(409, `${changes.name} is already in ${changes.class_name}.`);
      throw err;
    }
    const changed = Object.keys(body).join(', ');
    audit(req.staff, `${changes.class_name}: ${changes.name}`, `Updated ${changed}`);
    if (body.sportExempt !== undefined) syncCompletion(student.id, req.staff);
  });
  res.json(studentRow(getStudent(student.id)));
});

staff.post('/students', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim() || fail(400, 'A name is required.');
  if (!['M', 'F'].includes(body.gender)) fail(400, 'Gender must be M or F.');
  const cls = parseClassName(body.className) || fail(400, 'Class must look like "Form 4B" or "Lower 6G".');
  if (body.dob && !/^\d{4}-\d{2}-\d{2}$/.test(body.dob)) fail(400, 'Date of birth must be a valid date.');
  const clash = db.prepare('SELECT id FROM students WHERE class_name = ? AND name = ?').get(cls.class_name, name);
  if (clash) fail(409, `${name} is already in ${cls.class_name}.`);
  const result = db.prepare(`INSERT INTO students (name, gender, dob, form_level, form_label, class_name)
    VALUES (?, ?, ?, ?, ?, ?)`).run(name, body.gender, body.dob || null, cls.form_level, cls.form_label, cls.class_name);
  audit(req.staff, `${cls.class_name}: ${name}`, 'Added student');
  res.json(studentRow(getStudent(Number(result.lastInsertRowid))));
});

// ---- Clubs and sports --------------------------------------------------------
staff.get('/options', (req, res) => {
  const counts = optionCounts();
  res.json(allOptions().map((o) => ({ ...o, group: optionGroup(o), count: counts.get(o.id) || 0 })));
});

staff.get('/options/:id/roster', (req, res) => {
  const option = requireOption(req.params.id);
  res.json({
    option: { ...option, group: optionGroup(option) },
    students: rosterRows(option.id, req.query.form || null).map((r) => ({
      id: r.id, name: r.name, gender: r.gender, formLabel: r.form_label, className: r.class_name, sessions: r.sessions,
    })),
  });
});

/** Add a student to a club or sport directly, e.g. when entering paper forms. */
staff.post('/options/:id/students', (req, res) => {
  const option = requireOption(req.params.id);
  const student = requireStudent(req.body?.studentId);
  const sessions = cleanSessions(option, req.body?.sessions);
  tx(() => {
    db.prepare(`INSERT INTO selections (student_id, option_id, sessions, added_by, added_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (student_id, option_id) DO UPDATE SET sessions = excluded.sessions`)
      .run(student.id, option.id, sessions, req.staff, now());
    audit(req.staff, `${student.class_name}: ${student.name}`, `Added ${option.header}${sessions ? ` (${sessions})` : ''}`);
    syncCompletion(student.id, req.staff);
  });
  res.json({ ok: true });
});

staff.delete('/options/:id/students/:studentId', (req, res) => {
  const option = requireOption(req.params.id);
  const student = requireStudent(req.params.studentId);
  tx(() => {
    db.prepare('DELETE FROM selections WHERE student_id = ? AND option_id = ?').run(student.id, option.id);
    audit(req.staff, `${student.class_name}: ${student.name}`, `Removed ${option.header}`);
    syncCompletion(student.id, req.staff);
  });
  res.json({ ok: true });
});

function readOptionBody(body, existing) {
  const out = { ...existing };
  if (body.header !== undefined) out.header = String(body.header).trim() || fail(400, 'A spreadsheet heading is required.');
  if (body.name !== undefined) out.name = String(body.name).trim() || fail(400, 'A name is required.');
  if (body.note !== undefined) out.note = String(body.note).slice(0, 500);
  if (body.gender !== undefined) {
    if (![null, '', 'M', 'F'].includes(body.gender)) fail(400, 'Gender must be Girls, Boys or Everyone.');
    out.gender = body.gender || null;
  }
  for (const key of ['min_form', 'max_form']) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < 1 || n > 6) fail(400, 'Forms must be between 1 and 6.');
      out[key] = n;
    }
  }
  if (out.min_form > out.max_form) fail(400, 'The lowest form cannot be above the highest form.');
  for (const key of ['is_primary', 'counts_as_club', 'by_application', 'closed', 'active']) {
    if (body[key] !== undefined) out[key] = body[key] ? 1 : 0;
  }
  if (body.capacity !== undefined) {
    if (body.capacity === null || body.capacity === '') out.capacity = null;
    else {
      const n = Number(body.capacity);
      if (!Number.isInteger(n) || n < 0) fail(400, 'The limit must be a whole number.');
      out.capacity = n;
    }
  }
  return out;
}

staff.patch('/options/:id', (req, res) => {
  const existing = requireOption(req.params.id);
  const o = readOptionBody(req.body || {}, existing);
  db.prepare(`UPDATE options SET header = ?, name = ?, note = ?, gender = ?, min_form = ?, max_form = ?, is_primary = ?,
    counts_as_club = ?, by_application = ?, closed = ?, active = ?, capacity = ? WHERE id = ?`)
    .run(o.header, o.name, o.note, o.gender, o.min_form, o.max_form, o.is_primary,
      o.counts_as_club, o.by_application, o.closed, o.active, o.capacity, existing.id);
  audit(req.staff, o.header, `Updated ${Object.keys(req.body || {}).join(', ')}`);
  res.json(getOption(existing.id));
});

staff.post('/options', (req, res) => {
  const category = req.body?.category;
  if (!['sport', 'club'].includes(category)) fail(400, 'Choose sport or club.');
  const base = { category, header: '', name: '', note: '', gender: null, min_form: 1, max_form: 6,
    is_primary: 0, counts_as_club: category === 'club' ? 1 : 0, by_application: 0, closed: 0, active: 1, capacity: null };
  const name = String(req.body?.name || '').trim() || fail(400, 'A name is required.');
  const o = readOptionBody({ header: name.toUpperCase(), ...req.body, name }, base);
  const usedSlots = new Set(db.prepare('SELECT slot FROM options WHERE category = ?').all(category).map((r) => r.slot));
  let slot = 0;
  while (usedSlots.has(slot)) slot += 1;
  const result = db.prepare(`INSERT INTO options (category, slot, header, name, gender, min_form, max_form, is_primary,
    counts_as_club, by_application, closed, capacity, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(category, slot, o.header, o.name, o.gender, o.min_form, o.max_form, o.is_primary,
      o.counts_as_club, o.by_application, o.closed, o.capacity, o.note);
  audit(req.staff, o.header, 'Added option');
  res.json(getOption(Number(result.lastInsertRowid)));
});

// ---- Excel downloads ---------------------------------------------------------
function sendWorkbook(res, file) {
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${file.filename}"`,
  });
  res.send(Buffer.from(file.buffer));
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

staff.get('/export/form/:label', asyncRoute(async (req, res) => {
  const file = await formWorkbook(req.params.label);
  if (!file) fail(404, 'No students in that form.');
  sendWorkbook(res, file);
}));

staff.get('/export/option/:id', asyncRoute(async (req, res) => {
  sendWorkbook(res, await rosterWorkbook(requireOption(req.params.id), req.query.form || null));
}));

staff.get('/export/all-lists', asyncRoute(async (req, res) => {
  sendWorkbook(res, await allRostersWorkbook());
}));

// ---- Setup -------------------------------------------------------------------
const EDITABLE_SETTINGS = ['term_label', 'clash_warnings', 'sport_timetable_url', 'club_timetable_url', 'sport_notes', 'club_notes', 'club_admission_note'];

staff.get('/settings', (req, res) => {
  const settings = {};
  for (const key of [...EDITABLE_SETTINGS, 'registration_open']) settings[key] = getSetting(key);
  res.json(settings);
});

staff.patch('/settings', (req, res) => {
  const body = req.body || {};
  for (const key of ['sport_timetable_url', 'club_timetable_url']) {
    if (body[key] && !/^https?:\/\//i.test(body[key])) fail(400, 'Timetable links must start with http:// or https://');
  }
  for (const key of EDITABLE_SETTINGS) {
    if (body[key] !== undefined) setSetting(key, String(body[key]));
  }
  if (body.registration_open !== undefined) {
    setSetting('registration_open', body.registration_open ? '1' : '0');
    audit(req.staff, 'Registration', body.registration_open ? 'Opened' : 'Closed');
  }
  res.json({ ok: true });
});

staff.get('/audit', (req, res) => {
  res.json(db.prepare('SELECT at, actor, subject, action FROM audit ORDER BY id DESC LIMIT 300').all());
});

staff.get('/students-removed', (req, res) => {
  res.json(db.prepare(`SELECT id, name, class_name AS className FROM students WHERE active = 0 ORDER BY ${FORM_ORDER}`).all());
});

staff.post('/import', express.raw({ type: 'application/octet-stream', limit: '25mb' }), asyncRoute(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'Please choose an Excel file.');
  let parsed;
  try {
    parsed = await readWorkbook(req.body);
  } catch {
    fail(400, 'That file could not be read. Please use an .xlsx file.');
  }
  if (!parsed.students.length) fail(400, 'No students were found in that file.');
  const apply = req.query.apply === '1';
  const deactivateMissing = req.query.removeMissing === '1';
  if (apply) backup('before-import');
  const report = applyStudents(parsed.students, { apply, deactivateMissing, actor: req.staff });
  res.json({ applied: apply, total: parsed.students.length, skipped: parsed.skipped, ...report });
}));

staff.post('/clear-choices', (req, res) => {
  if (req.body?.confirm !== 'CLEAR') fail(400, 'Please type CLEAR to confirm.');
  const file = backup('before-clear');
  tx(() => {
    db.prepare('DELETE FROM selections').run();
    db.prepare('UPDATE students SET submitted_at = NULL, submitted_by = NULL').run();
    audit(req.staff, 'All students', `Cleared all choices (backup: ${path.basename(file)})`);
  });
  res.json({ ok: true, backup: path.basename(file) });
});

// ---- Errors ------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ---- Start -------------------------------------------------------------------
async function seedStudents() {
  if (db.prepare('SELECT COUNT(*) AS n FROM students').get().n > 0) return;
  if (!CLASS_LIST_DIR || !fs.existsSync(CLASS_LIST_DIR)) return;
  const files = fs.readdirSync(CLASS_LIST_DIR).filter((f) => f.endsWith('.xlsx')).sort();
  const all = [];
  for (const file of files) {
    const { students, skipped } = await readWorkbook(path.join(CLASS_LIST_DIR, file));
    all.push(...students);
    for (const s of skipped) console.log(`  Skipped ${s}`);
  }
  applyStudents(all, { apply: true, actor: 'First-time setup' });
  console.log(`Loaded ${all.length} students from ${files.length} class list files.`);
}

async function start() {
  seedConfig();
  await seedStudents();
  return new Promise((resolve) => {
    const server = app.listen(PORT, HOST, () => {
      const { port } = server.address();
      console.log(`\nSports and Club Options is running on port ${port}.`);
      for (const addresses of Object.values(os.networkInterfaces())) {
        for (const a of addresses || []) {
          if (a.family === 'IPv4' && !a.internal) console.log(`  Students: http://${a.address}:${port}/    Staff: http://${a.address}:${port}/staff`);
        }
      }
      console.log('Staff sign in on the home page, with an admin account from the demerits app.');
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { app, start };
