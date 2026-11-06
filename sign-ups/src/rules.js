const { db, now } = require('./db');

const parseOption = (o) => ({ ...o, sessions: JSON.parse(o.sessions || '[]') });

const allOptions = () =>
  db.prepare('SELECT * FROM options ORDER BY category DESC, slot').all().map(parseOption);

const getOption = (id) => {
  const o = db.prepare('SELECT * FROM options WHERE id = ?').get(id);
  return o ? parseOption(o) : null;
};

const getStudent = (id) => db.prepare('SELECT * FROM students WHERE id = ?').get(id);

/** Does this student's gender and form allow them to take this option? */
const isEligible = (option, student) =>
  (!option.gender || option.gender === student.gender) &&
  student.form_level >= option.min_form &&
  student.form_level <= option.max_form;

/** How many active students currently hold each option. */
function optionCounts() {
  const rows = db.prepare(`
    SELECT sel.option_id AS id, COUNT(*) AS n
    FROM selections sel JOIN students st ON st.id = sel.student_id
    WHERE st.active = 1 GROUP BY sel.option_id`).all();
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** Why this option cannot be newly chosen, or null if it can. */
function unavailableReason(option, count) {
  if (option.closed) return 'Club fully subscribed';
  if (option.capacity != null && count >= option.capacity) return 'Full';
  return null;
}

const selectionsFor = (studentId) =>
  db.prepare(`
    SELECT sel.sessions AS chosen_sessions, o.*
    FROM selections sel JOIN options o ON o.id = sel.option_id
    WHERE sel.student_id = ? ORDER BY o.category DESC, o.name`).all(studentId)
    .map(parseOption);

/**
 * What is still needed for this set of choices to be complete.
 * `selected` items need is_primary, counts_as_club, sessions and chosen_sessions.
 */
function missingRequirements(student, selected) {
  const missing = [];
  if (!student.sport_exempt && !selected.some((o) => o.is_primary)) missing.push('a primary sport');
  if (!selected.some((o) => o.counts_as_club)) missing.push('a club');
  for (const o of selected) {
    if (o.sessions.length && !o.chosen_sessions) missing.push(`a session for ${o.name}`);
  }
  return missing;
}

/**
 * After staff change a student's choices, mark them complete if the rules are
 * now met, or back to incomplete if they are not.
 */
function syncCompletion(studentId, actor) {
  const student = getStudent(studentId);
  const done = missingRequirements(student, selectionsFor(studentId)).length === 0;
  if (done && !student.submitted_at) {
    db.prepare('UPDATE students SET submitted_at = ?, submitted_by = ? WHERE id = ?').run(now(), actor, studentId);
  } else if (!done && student.submitted_at) {
    db.prepare('UPDATE students SET submitted_at = NULL, submitted_by = NULL WHERE id = ?').run(studentId);
  }
}

/** Keep only recognised session letters, in a consistent order. */
function cleanSessions(option, sessions) {
  const chosen = new Set(Array.isArray(sessions) ? sessions : String(sessions || '').split(','));
  return option.sessions.filter((s) => chosen.has(s)).join(',');
}

const FORM_ORDER = 'form_level, class_name, name';

module.exports = {
  allOptions, getOption, getStudent, isEligible, optionCounts, unavailableReason,
  selectionsFor, missingRequirements, syncCompletion, cleanSessions, FORM_ORDER,
};
