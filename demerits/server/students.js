'use strict';
const { tx } = require('./db');
const { HttpError } = require('./lists');

const normalise = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`.]/g, '');

// Lets prefects type the shorthand already used in the WhatsApp group: "4P", "3 Greg", "L6 John".
function searchWords(student) {
  const formWords = normalise(student.form).split(/\s+/);
  const compact = formWords.join('');
  const initial = formWords.length > 1 ? formWords[0] + formWords[1][0] : compact;
  return [
    ...normalise(`${student.first_name} ${student.surname}`).split(/[\s-]+/),
    ...formWords,
    compact,
    initial,
    normalise(student.student_no || ''),
  ].filter(Boolean);
}

function searchStudents(db, query, limit = 30) {
  const tokens = normalise(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const rows = db
    .prepare('SELECT id, student_no, first_name, surname, form FROM students WHERE active = 1')
    .all();
  const matches = [];
  for (const s of rows) {
    const words = searchWords(s);
    if (!tokens.every((t) => words.some((w) => w.startsWith(t)))) continue;
    const surname = normalise(s.surname);
    const first = normalise(s.first_name);
    const score = surname.startsWith(tokens[0]) ? 0 : first.startsWith(tokens[0]) ? 1 : 2;
    matches.push({ s, score });
  }
  matches.sort(
    (a, b) => a.score - b.score || a.s.surname.localeCompare(b.s.surname) || a.s.first_name.localeCompare(b.s.first_name)
  );
  return matches.slice(0, limit).map((m) => m.s);
}

function parseCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const HEADERS = {
  surname: ['surname', 'lastname', 'familyname'],
  first: ['firstname', 'first', 'firstnames', 'forename', 'forenames', 'givenname'],
  name: ['name', 'fullname', 'student', 'studentname', 'pupil', 'pupilname'],
  form: ['form', 'class', 'formclass', 'tutorgroup', 'formgroup'],
  no: ['studentno', 'studentnumber', 'studentid', 'number', 'no', 'id', 'admissionno', 'admissionnumber', 'pupilid'],
};

function mapColumns(header) {
  const keys = header.map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (names) => keys.findIndex((k) => names.includes(k));
  const cols = {
    surname: find(HEADERS.surname),
    first: find(HEADERS.first),
    name: find(HEADERS.name),
    form: find(HEADERS.form),
    no: find(HEADERS.no),
  };
  const hasName = (cols.surname >= 0 && cols.first >= 0) || cols.name >= 0;
  if (!hasName || cols.form < 0) {
    throw new HttpError(
      400,
      `The file needs a Form column and either Surname + First Name or a Name column. Found: ${header.join(', ')}`
    );
  }
  return cols;
}

function splitName(full) {
  const value = full.trim();
  if (value.includes(',')) {
    const [surname, ...rest] = value.split(',');
    return { surname: surname.trim(), first: rest.join(',').trim() };
  }
  const words = value.split(/\s+/);
  return { first: words.slice(0, -1).join(' '), surname: words[words.length - 1] };
}

function parseStudentRows(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'The file has no student rows.');
  const cols = mapColumns(rows[0]);
  const students = [];
  const skipped = [];
  rows.slice(1).forEach((r, i) => {
    const get = (c) => (c >= 0 ? (r[c] || '').trim() : '');
    const name = cols.surname >= 0 && cols.first >= 0 ? { surname: get(cols.surname), first: get(cols.first) } : splitName(get(cols.name));
    const form = get(cols.form);
    if (!name.surname || !name.first || !form) skipped.push(i + 2);
    else students.push({ first: name.first, surname: name.surname, form, no: get(cols.no) || null });
  });
  return { students, skipped };
}

// Matches on student number when there is one; otherwise on name, so re-importing next
// year's file moves students to their new form and keeps their records.
function importStudents(db, text, { deactivateMissing = false } = {}) {
  const { students, skipped } = parseStudentRows(text);
  return tx(db, () => {
    const byNo = db.prepare('SELECT id FROM students WHERE student_no = ? AND is_dummy = 0');
    const byNameForm = db.prepare(
      'SELECT id FROM students WHERE first_name = ? COLLATE NOCASE AND surname = ? COLLATE NOCASE AND form = ? COLLATE NOCASE AND is_dummy = 0'
    );
    const byName = db.prepare(
      'SELECT id FROM students WHERE first_name = ? COLLATE NOCASE AND surname = ? COLLATE NOCASE AND is_dummy = 0'
    );
    const update = db.prepare(
      'UPDATE students SET first_name = ?, surname = ?, form = ?, student_no = COALESCE(?, student_no), active = 1 WHERE id = ?'
    );
    const insert = db.prepare('INSERT INTO students (first_name, surname, form, student_no) VALUES (?, ?, ?, ?)');
    const seen = new Set();
    let added = 0;
    let updated = 0;
    for (const s of students) {
      let found = s.no ? byNo.get(s.no) : null;
      if (!found) found = byNameForm.get(s.first, s.surname, s.form);
      if (!found) {
        const named = byName.all(s.first, s.surname).filter((row) => !seen.has(row.id));
        if (named.length === 1) found = named[0];
      }
      if (found) {
        update.run(s.first, s.surname, s.form, s.no, found.id);
        seen.add(found.id);
        updated++;
      } else {
        seen.add(Number(insert.run(s.first, s.surname, s.form, s.no).lastInsertRowid));
        added++;
      }
    }
    let deactivated = 0;
    if (deactivateMissing) {
      const stale = db.prepare('SELECT id FROM students WHERE active = 1 AND is_dummy = 0').all().filter((r) => !seen.has(r.id));
      const off = db.prepare('UPDATE students SET active = 0 WHERE id = ?');
      for (const r of stale) off.run(r.id);
      deactivated = stale.length;
    }
    return { added, updated, deactivated, skipped };
  });
}

// Clears everything created by `npm run seed` once the real student list is in.
function removeDummyData(db) {
  return tx(db, () => {
    const dummyUsers = 'SELECT id FROM users WHERE is_dummy = 1';
    const dummyStudents = 'SELECT id FROM students WHERE is_dummy = 1';
    db.exec(`UPDATE demerits SET list_entry_id = NULL
             WHERE list_entry_id IN (SELECT id FROM list_entries WHERE student_id IN (${dummyStudents}))`);
    db.exec(`DELETE FROM demerits WHERE student_id IN (${dummyStudents}) OR created_by IN (${dummyUsers})`);
    db.exec(`UPDATE demerits SET voided_by = NULL WHERE voided_by IN (${dummyUsers})`);
    db.exec(`UPDATE list_entries SET carried_from_entry_id = NULL
             WHERE carried_from_entry_id IN (SELECT id FROM list_entries WHERE student_id IN (${dummyStudents}))`);
    db.exec(`DELETE FROM list_entries WHERE student_id IN (${dummyStudents})`);
    db.exec(`UPDATE list_entries SET marked_by = NULL WHERE marked_by IN (${dummyUsers})`);
    db.exec(`UPDATE list_entries SET query_by = NULL, query_note = NULL WHERE query_by IN (${dummyUsers})`);
    db.exec(`UPDATE list_entries SET removed_by = NULL WHERE removed_by IN (${dummyUsers})`);
    db.exec(`UPDATE lists SET created_by = NULL WHERE created_by IN (${dummyUsers})`);
    db.exec(`UPDATE lists SET session_started_by = NULL WHERE session_started_by IN (${dummyUsers})`);
    db.exec(`UPDATE term_starts SET started_by = NULL WHERE started_by IN (${dummyUsers})`);
    db.exec('DELETE FROM lists WHERE id NOT IN (SELECT list_id FROM list_entries)');
    const students = db.prepare('DELETE FROM students WHERE is_dummy = 1').run();
    const users = db.prepare('DELETE FROM users WHERE is_dummy = 1').run();
    return { students: Number(students.changes), prefects: Number(users.changes) };
  });
}

module.exports = { searchStudents, parseCsv, parseStudentRows, importStudents, removeDummyData };
