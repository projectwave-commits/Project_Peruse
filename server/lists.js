'use strict';
const { tx } = require('./db');

const PREFECTS_LABEL = 'Hellenic Prefects';

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function localDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function offenceLabel(offence) {
  return offence.class ? `${offence.class}: ${offence.name}` : offence.name;
}

const unique = (values) => [...new Set(values)];

function toEntry(demerits) {
  const last = demerits[demerits.length - 1];
  return {
    studentId: last.student_id,
    demeritIds: demerits.map((d) => d.id),
    date: localDate(last.created_at),
    reason: unique(demerits.map((d) => d.label)).join('; '),
    reportedBy: unique(demerits.map((d) => d.reported_by || PREFECTS_LABEL)).join(', '),
  };
}

/**
 * The core rule. Every `threshold` ordinary demerits becomes one list entry; a straight-to-list
 * demerit always becomes its own. Anything left over stays pending for a later list.
 * `demerits` must be ordered oldest first.
 */
function groupDemerits(demerits, threshold) {
  const byStudent = new Map();
  for (const d of demerits) {
    if (!byStudent.has(d.student_id)) byStudent.set(d.student_id, []);
    byStudent.get(d.student_id).push(d);
  }
  const entries = [];
  const pending = [];
  for (const rows of byStudent.values()) {
    let held = [];
    for (const d of rows) {
      if (d.straight_to_list) {
        entries.push(toEntry([d]));
        continue;
      }
      held.push(d);
      if (held.length >= threshold) {
        entries.push(toEntry(held));
        held = [];
      }
    }
    pending.push(...held);
  }
  return { entries, pending };
}

function unlistedDemerits(db, listType, studentId) {
  const sql = `SELECT id, student_id, label, straight_to_list, reported_by, created_at
    FROM demerits
    WHERE list_type = ? AND list_entry_id IS NULL AND voided_at IS NULL AND expired_at IS NULL ${studentId ? 'AND student_id = ?' : ''}
    ORDER BY created_at, id`;
  const params = studentId ? [listType, studentId] : [listType];
  return db.prepare(sql).all(...params);
}

function carryCandidates(db, listType) {
  return db
    .prepare(
      `SELECT e.* FROM list_entries e
       JOIN lists l ON l.id = e.list_id
       WHERE l.list_type = ? AND l.status = 'closed' AND e.attendance = 'absent' AND e.removed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM list_entries c WHERE c.carried_from_entry_id = e.id)
       ORDER BY e.id`
    )
    .all(listType);
}

function getListType(db, key) {
  const t = db.prepare('SELECT * FROM list_types WHERE key = ?').get(key);
  if (!t) throw new HttpError(404, 'Unknown list type');
  return t;
}

function preview(db, listType) {
  const type = getListType(db, listType);
  const { entries, pending } = groupDemerits(unlistedDemerits(db, listType), type.threshold);
  const draft = db.prepare("SELECT id FROM lists WHERE list_type = ? AND status = 'draft'").get(listType);
  return {
    fromDemerits: entries.length,
    carried: carryCandidates(db, listType).length,
    waiting: pending.length,
    existingDraftId: draft ? draft.id : null,
    type,
  };
}

function createDraft(db, { listType, eventDate, eventTime, instructions, title, isDummy = false }, user) {
  const type = getListType(db, listType);
  return tx(db, () => {
    const existing = db.prepare("SELECT id FROM lists WHERE list_type = ? AND status = 'draft'").get(listType);
    if (existing) throw new HttpError(409, `There is already a draft ${type.name} list. Publish or discard it first.`);

    const now = new Date().toISOString();
    const listId = Number(
      db
        .prepare(
          `INSERT INTO lists (list_type, title, event_date, event_time, instructions, created_by, created_at, is_dummy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(listType, title || type.name.toUpperCase(), eventDate, eventTime ?? type.default_time,
          instructions ?? type.default_instructions, user.id, now, isDummy ? 1 : 0).lastInsertRowid
    );

    const addEntry = db.prepare(
      `INSERT INTO list_entries (list_id, student_id, entry_date, reported_by, reason, carried_from_entry_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const claim = db.prepare('UPDATE demerits SET list_entry_id = ? WHERE id = ?');
    const { entries } = groupDemerits(unlistedDemerits(db, listType), type.threshold);
    for (const e of entries) {
      const entryId = addEntry.run(listId, e.studentId, e.date, e.reportedBy, e.reason, null).lastInsertRowid;
      for (const id of e.demeritIds) claim.run(entryId, id);
    }
    for (const e of carryCandidates(db, listType)) {
      addEntry.run(listId, e.student_id, e.entry_date, e.reported_by, e.reason, e.id);
    }
    return listId;
  });
}

function getList(db, id) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  if (!list) throw new HttpError(404, 'List not found');
  return list;
}

function requireStatus(list, ...allowed) {
  if (!allowed.includes(list.status)) throw new HttpError(409, `This list is ${list.status}, so that cannot be done.`);
}

function discardDraft(db, id) {
  const list = getList(db, id);
  requireStatus(list, 'draft');
  tx(db, () => {
    db.prepare('UPDATE demerits SET list_entry_id = NULL WHERE list_entry_id IN (SELECT id FROM list_entries WHERE list_id = ?)').run(id);
    db.prepare('DELETE FROM list_entries WHERE list_id = ?').run(id);
    db.prepare('DELETE FROM lists WHERE id = ?').run(id);
  });
}

function publishList(db, id) {
  requireStatus(getList(db, id), 'draft');
  db.prepare("UPDATE lists SET status = 'published', published_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

// Anyone not ticked present by the time the register closes counts as a no-show.
function closeList(db, id, user) {
  requireStatus(getList(db, id), 'published');
  const now = new Date().toISOString();
  return tx(db, () => {
    const absent = db
      .prepare(
        `UPDATE list_entries SET attendance = 'absent', marked_by = ?, marked_at = ?
         WHERE list_id = ? AND attendance IS NULL AND removed_at IS NULL`
      )
      .run(user.id, now, id);
    db.prepare("UPDATE lists SET status = 'closed', closed_at = ? WHERE id = ?").run(now, id);
    return Number(absent.changes);
  });
}

function reopenList(db, id) {
  requireStatus(getList(db, id), 'closed');
  const carried = db
    .prepare(
      `SELECT COUNT(*) AS n FROM list_entries c JOIN list_entries e ON e.id = c.carried_from_entry_id
       WHERE e.list_id = ?`
    )
    .get(id);
  if (carried.n > 0) {
    throw new HttpError(409, 'No-shows from this register are already on a later list, so it cannot be reopened.');
  }
  // The clock starts again when the session is next started.
  db.prepare("UPDATE lists SET status = 'published', closed_at = NULL, session_started_at = NULL, session_started_by = NULL WHERE id = ?").run(id);
}

function getEntry(db, id) {
  const entry = db.prepare('SELECT * FROM list_entries WHERE id = ?').get(id);
  if (!entry) throw new HttpError(404, 'Entry not found');
  if (entry.removed_at) throw new HttpError(409, 'This student has already been removed from the list.');
  return entry;
}

function isOnDuty(db, listId, userId) {
  return Boolean(db.prepare('SELECT 1 AS x FROM list_duty WHERE list_id = ? AND user_id = ?').get(listId, userId));
}

function setDuty(db, listId, userIds) {
  requireStatus(getList(db, listId), 'draft', 'published');
  const ids = [...new Set(userIds)];
  tx(db, () => {
    const isPrefect = db.prepare("SELECT 1 AS x FROM users WHERE id = ? AND role = 'prefect' AND active = 1");
    db.prepare('DELETE FROM list_duty WHERE list_id = ?').run(listId);
    const add = db.prepare('INSERT INTO list_duty (list_id, user_id) VALUES (?, ?)');
    for (const id of ids) {
      if (!isPrefect.get(id)) throw new HttpError(400, 'Only active prefects can be put on duty.');
      add.run(listId, id);
    }
  });
}

/**
 * Saves the register. The first save starts the session clock. Any prefect may do this, but
 * changes from a prefect who is not on duty raise an alert for the admins.
 */
// One alert per prefect per list until an admin dismisses it, as every tap now saves.
function alertOffDuty(db, listId, user, changes, now) {
  if (user.role === 'admin' || isOnDuty(db, listId, user.id)) return false;
  const existing = db.prepare('SELECT id FROM register_alerts WHERE list_id = ? AND user_id = ? AND dismissed_at IS NULL').get(listId, user.id);
  if (existing) {
    db.prepare('UPDATE register_alerts SET changes = changes + ?, created_at = ? WHERE id = ?').run(changes, now, existing.id);
  } else {
    db.prepare('INSERT INTO register_alerts (list_id, user_id, changes, created_at) VALUES (?, ?, ?, ?)').run(listId, user.id, changes, now);
  }
  return true;
}

// The first time in "6:45 AM" or "14:00 – 16:00" is when the list starts.
function listStartsAt(list) {
  const match = /(\d{1,2})(?:[:.](\d{2}))?\s*([ap])?\.?m?\b/i.exec(list.event_time || '');
  if (!match || (!match[2] && !match[3])) return null;
  let hour = Number(match[1]);
  if (match[3]) hour = (hour % 12) + (match[3].toLowerCase() === 'p' ? 12 : 0);
  if (hour > 23 || Number(match[2] || 0) > 59) return null;
  const [year, month, day] = list.event_date.split('-').map(Number);
  return new Date(year, month - 1, day, hour, Number(match[2] || 0));
}

// Marked at 6:45 is on time; 6:46 is late.
function isLate(list, entry) {
  if (entry.attendance !== 'present' || !entry.marked_at) return false;
  const start = listStartsAt(list);
  return Boolean(start) && Date.parse(entry.marked_at) >= start.getTime() + 60000;
}

function saveRegister(db, listId, marks, user) {
  const list = getList(db, listId);
  requireStatus(list, 'published');
  return tx(db, () => {
    const now = new Date().toISOString();
    const current = new Map(
      db.prepare('SELECT id, attendance FROM list_entries WHERE list_id = ? AND removed_at IS NULL').all(listId).map((e) => [e.id, e.attendance])
    );
    const update = db.prepare('UPDATE list_entries SET attendance = ?, marked_by = ?, marked_at = ? WHERE id = ?');
    let changes = 0;
    for (const { entryId, attendance } of marks) {
      if (![null, 'present', 'absent'].includes(attendance)) throw new HttpError(400, 'Invalid attendance');
      // Someone may have been taken off the list since this phone loaded it.
      if (!current.has(entryId) || current.get(entryId) === attendance) continue;
      update.run(attendance, attendance ? user.id : null, attendance ? now : null, entryId);
      current.set(entryId, attendance);
      changes += 1;
    }
    const alerted = changes > 0 && alertOffDuty(db, listId, user, changes, now);
    const entries = marks.filter((m) => current.has(m.entryId)).map((m) => {
      const entry = db.prepare('SELECT id, attendance, marked_at FROM list_entries WHERE id = ?').get(m.entryId);
      return { ...entry, late: isLate(list, entry) };
    });
    return { changes, alerted, entries };
  });
}

function startSession(db, listId, user) {
  const list = getList(db, listId);
  requireStatus(list, 'published');
  if (list.session_started_at) return { alerted: false };
  return tx(db, () => {
    const now = new Date().toISOString();
    db.prepare('UPDATE lists SET session_started_at = ?, session_started_by = ? WHERE id = ?').run(now, user.id, listId);
    return { alerted: alertOffDuty(db, listId, user, 0, now) };
  });
}

function queryEntry(db, entryId, note, user) {
  const entry = getEntry(db, entryId);
  requireStatus(getList(db, entry.list_id), 'draft', 'published');
  db.prepare('UPDATE list_entries SET query_note = ?, query_by = ?, query_at = ? WHERE id = ?').run(
    note, user.id, new Date().toISOString(), entryId
  );
}

function dismissQuery(db, entryId) {
  getEntry(db, entryId);
  db.prepare('UPDATE list_entries SET query_note = NULL, query_by = NULL, query_at = NULL WHERE id = ?').run(entryId);
}

/**
 * Takes a student off a list. Their demerits are cancelled, except any in `keepDemeritIds`,
 * which go back to waiting (for when only one of the two demerits was the mistake).
 */
function removeEntry(db, entryId, reason, keepDemeritIds, user) {
  const entry = getEntry(db, entryId);
  const later = db.prepare('SELECT COUNT(*) AS n FROM list_entries WHERE carried_from_entry_id = ?').get(entryId);
  if (later.n > 0) throw new HttpError(409, 'This no-show is already on a later list. Remove the student from that list instead.');
  const keep = new Set(keepDemeritIds || []);
  const now = new Date().toISOString();
  tx(db, () => {
    db.prepare('UPDATE list_entries SET removed_at = ?, removed_by = ?, removed_reason = ?, query_note = NULL WHERE id = ?').run(
      now, user.id, reason, entryId
    );
    const release = db.prepare('UPDATE demerits SET list_entry_id = NULL WHERE id = ?');
    const cancel = db.prepare('UPDATE demerits SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?');
    for (const { id } of db.prepare('SELECT id FROM demerits WHERE list_entry_id = ?').all(entry.id)) {
      if (keep.has(id)) release.run(id);
      else cancel.run(now, user.id, reason, id);
    }
  });
}

function voidDemerit(db, demeritId, reason, user) {
  const d = db.prepare('SELECT * FROM demerits WHERE id = ?').get(demeritId);
  if (!d) throw new HttpError(404, 'Demerit not found');
  if (d.voided_at) throw new HttpError(409, 'This demerit has already been cancelled.');
  if (user.role !== 'admin' && d.created_by !== user.id) throw new HttpError(403, 'You can only cancel demerits you recorded.');
  if (d.list_entry_id) throw new HttpError(409, 'This demerit is already on a list. Use "Query" on the list instead.');
  if (d.expired_at) throw new HttpError(409, 'This demerit is from an earlier term and no longer counts.');
  db.prepare('UPDATE demerits SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?').run(
    new Date().toISOString(), user.id, reason, demeritId
  );
}

function leftoverDemerits(db) {
  return db.prepare('SELECT key, threshold FROM list_types').all().flatMap(
    (type) => groupDemerits(unlistedDemerits(db, type.key), type.threshold).pending
  );
}

/**
 * Part-way counts go back to zero, and those demerits stay in the history. Students who already
 * reached the limit stay due for the next list, as do no-shows: they owe that from last term.
 */
function startNewTerm(db, user) {
  return tx(db, () => {
    const now = new Date().toISOString();
    const leftovers = leftoverDemerits(db);
    const expire = db.prepare('UPDATE demerits SET expired_at = ? WHERE id = ?');
    for (const d of leftovers) expire.run(now, d.id);
    db.prepare('INSERT INTO term_starts (started_at, started_by, demerits_cleared) VALUES (?, ?, ?)').run(now, user.id, leftovers.length);
    return leftovers.length;
  });
}

function undoNewTerm(db) {
  return tx(db, () => {
    const latest = db.prepare('SELECT * FROM term_starts ORDER BY id DESC LIMIT 1').get();
    if (!latest || latest.undone_at) throw new HttpError(409, 'There is no new term to undo.');
    const restored = db.prepare('UPDATE demerits SET expired_at = NULL WHERE expired_at = ?').run(latest.started_at);
    db.prepare('UPDATE term_starts SET undone_at = ? WHERE id = ?').run(new Date().toISOString(), latest.id);
    return Number(restored.changes);
  });
}

function termStatus(db) {
  const latest = db
    .prepare(
      `SELECT t.started_at, t.demerits_cleared, t.undone_at, u.display_name AS started_by_name
       FROM term_starts t LEFT JOIN users u ON u.id = t.started_by ORDER BY t.id DESC LIMIT 1`
    )
    .get();
  return { latest: latest || null, leftover: leftoverDemerits(db).length };
}

function tally(db, studentId, type) {
  const rows = unlistedDemerits(db, type.key, studentId);
  const { entries, pending } = groupDemerits(rows, type.threshold);
  return { key: type.key, name: type.name, threshold: type.threshold, count: pending.length, listed: entries.length };
}

// 1 Gregory, 2 Basil ... 4 Plato, L6 Basil, U6 Plato: the order used on the current lists.
function formRank(form) {
  const year = String(form).trim().split(/\s+/)[0].toUpperCase();
  if (/^\d+$/.test(year)) return Number(year);
  return { L6: 100, U6: 101 }[year] ?? 200;
}

function compareEntries(a, b) {
  return (
    formRank(a.form) - formRank(b.form) ||
    a.form.localeCompare(b.form) ||
    a.entry_date.localeCompare(b.entry_date) ||
    a.surname.localeCompare(b.surname) ||
    a.first_name.localeCompare(b.first_name)
  );
}

function listEntries(db, listId) {
  return db
    .prepare(
      `SELECT e.*, s.first_name, s.surname, s.form,
              q.display_name AS query_by_name, m.display_name AS marked_by_name
       FROM list_entries e
       JOIN students s ON s.id = e.student_id
       LEFT JOIN users q ON q.id = e.query_by
       LEFT JOIN users m ON m.id = e.marked_by
       WHERE e.list_id = ? AND e.removed_at IS NULL`
    )
    .all(listId)
    .sort(compareEntries);
}

module.exports = {
  HttpError,
  PREFECTS_LABEL,
  localDate,
  offenceLabel,
  groupDemerits,
  preview,
  createDraft,
  getList,
  discardDraft,
  publishList,
  closeList,
  reopenList,
  getEntry,
  isOnDuty,
  setDuty,
  saveRegister,
  startSession,
  isLate,
  queryEntry,
  dismissQuery,
  removeEntry,
  voidDemerit,
  startNewTerm,
  undoNewTerm,
  termStatus,
  tally,
  listEntries,
  compareEntries,
  formRank,
};
