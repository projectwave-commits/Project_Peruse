const ExcelJS = require('exceljs');
const { db, tx, audit } = require('./db');

const FORM_LEVELS = { 'Form 1': 1, 'Form 2': 2, 'Form 3': 3, 'Form 4': 4, 'Lower 6': 5, 'Upper 6': 6 };

/** "Form 4B" -> { form_label, form_level, class_name }, or null if it isn't a class name. */
function parseClassName(raw) {
  const m = /^\s*(form|lower|upper)\s*([1-6])\s*([a-z])\s*$/i.exec(String(raw ?? ''));
  if (!m) return null;
  const word = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const form_label = `${word} ${m[2]}`;
  const form_level = FORM_LEVELS[form_label];
  if (!form_level) return null;
  return { form_label, form_level, class_name: `${form_label}${m[3].toUpperCase()}` };
}

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((t) => t.text).join('');
    if (value.text) return String(value.text);
    if (value.result != null) return String(value.result);
    return '';
  }
  return String(value);
}

function toIsoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  }
  const text = cellText(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

const normaliseGender = (value) => {
  const g = cellText(value).trim().toUpperCase()[0];
  if (g === 'M' || g === 'B') return 'M';
  if (g === 'F' || g === 'G') return 'F';
  return null;
};

/**
 * Read students from a workbook. Two layouts are understood:
 *  1. The option-sheet layout: one tab per class ("Form 4B"), class list in columns M/N/O from row 17.
 *  2. A plain list on any tab, with a header row containing Name, Gender and Class (DOB optional).
 * Rows with no gender are reported rather than imported. In the option sheets these are
 * hand-typed annotations such as "Surname, First - events", not class list entries.
 */
function readStudents(workbook) {
  const students = [];
  const skipped = [];

  for (const sheet of workbook.worksheets) {
    const cls = parseClassName(sheet.name);
    if (cls) {
      for (let r = 17; r <= sheet.rowCount; r += 1) {
        const name = cellText(sheet.getCell(`M${r}`).value).trim();
        if (!name) continue;
        const gender = normaliseGender(sheet.getCell(`N${r}`).value);
        if (!gender) {
          skipped.push(`${cls.class_name}: "${name}" (no gender)`);
          continue;
        }
        students.push({ ...cls, name, gender, dob: toIsoDate(sheet.getCell(`O${r}`).value) });
      }
      continue;
    }

    let header = null;
    sheet.eachRow((row, rowNumber) => {
      const values = row.values || [];
      if (!header) {
        const cells = Array.from(values, (v) => cellText(v).trim().toLowerCase());
        const nameCol = cells.findIndex((c) => c === 'name' || c === 'student' || c === 'student name');
        const genderCol = cells.findIndex((c) => c === 'gender' || c === 'sex' || c === 'm/f');
        const classCol = cells.findIndex((c) => c === 'class' || c === 'form');
        if (nameCol > 0 && genderCol > 0 && classCol > 0) {
          const dobCol = cells.findIndex((c) => c === 'dob' || c === 'date of birth' || c === 'birth date');
          header = { nameCol, genderCol, classCol, dobCol };
        }
        return;
      }
      const name = cellText(values[header.nameCol]).trim();
      if (!name) return;
      const klass = parseClassName(cellText(values[header.classCol]));
      const gender = normaliseGender(values[header.genderCol]);
      if (!klass || !gender) {
        skipped.push(`${sheet.name} row ${rowNumber}: "${name}" (${klass ? 'no gender' : 'unknown class'})`);
        return;
      }
      students.push({ ...klass, name, gender, dob: header.dobCol > 0 ? toIsoDate(values[header.dobCol]) : null });
    });
  }
  return { students, skipped };
}

/**
 * Add or update students. A student is matched first in their class, then by name
 * anywhere, so a promoted student keeps their record. With `deactivateMissing`,
 * active students who aren't in the file are hidden (never deleted).
 * When `apply` is false, only reports what would happen.
 */
function applyStudents(incoming, { apply = false, deactivateMissing = false, actor = 'system' } = {}) {
  const existing = db.prepare('SELECT * FROM students').all();
  const byClassName = new Map(existing.map((s) => [`${s.class_name}|${s.name}`, s]));
  const byName = new Map();
  for (const s of existing) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }

  const report = { added: [], moved: [], updated: [], unchanged: 0, missing: [], duplicates: [] };
  const seenIds = new Set();
  const seenKeys = new Set();
  const inserts = [];
  const updates = [];

  for (const s of incoming) {
    const key = `${s.class_name}|${s.name}`;
    if (seenKeys.has(key)) {
      report.duplicates.push(`${s.class_name}: ${s.name}`);
      continue;
    }
    seenKeys.add(key);
    const nameMatches = (byName.get(s.name) || []).filter((m) => !seenIds.has(m.id));
    const match = byClassName.get(key) || (nameMatches.length === 1 ? nameMatches[0] : null);
    if (!match) {
      report.added.push(`${s.class_name}: ${s.name}`);
      inserts.push(s);
      continue;
    }
    seenIds.add(match.id);
    const moved = match.class_name !== s.class_name;
    const changed = moved || !match.active || match.gender !== s.gender || (s.dob && match.dob !== s.dob);
    if (moved) report.moved.push(`${s.name}: ${match.class_name} to ${s.class_name}`);
    else if (changed) report.updated.push(`${s.class_name}: ${s.name}`);
    else report.unchanged += 1;
    if (changed) updates.push({ ...s, id: match.id, dob: s.dob || match.dob });
  }

  const missing = existing.filter((s) => s.active && !seenIds.has(s.id));
  report.missing = missing.map((s) => `${s.class_name}: ${s.name}`);

  if (apply) {
    tx(() => {
      const ins = db.prepare(`INSERT INTO students (name, gender, dob, form_level, form_label, class_name)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const upd = db.prepare(`UPDATE students SET gender = ?, dob = ?, form_level = ?, form_label = ?, class_name = ?, active = 1
        WHERE id = ?`);
      for (const s of inserts) ins.run(s.name, s.gender, s.dob, s.form_level, s.form_label, s.class_name);
      for (const s of updates) upd.run(s.gender, s.dob, s.form_level, s.form_label, s.class_name, s.id);
      if (deactivateMissing) {
        const off = db.prepare('UPDATE students SET active = 0 WHERE id = ?');
        for (const s of missing) off.run(s.id);
      }
      audit(actor, 'Class lists', `Imported: ${report.added.length} added, ${report.moved.length} moved, ${report.updated.length} updated${deactivateMissing ? `, ${missing.length} removed` : ''}`);
    });
  }
  return report;
}

async function readWorkbook(source) {
  const workbook = new ExcelJS.Workbook();
  if (Buffer.isBuffer(source)) await workbook.xlsx.load(source);
  else await workbook.xlsx.readFile(source);
  return readStudents(workbook);
}

module.exports = { readWorkbook, applyStudents, parseClassName };
