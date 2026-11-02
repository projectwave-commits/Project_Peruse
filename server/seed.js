'use strict';
// Fills the app with made-up students and prefects for testing. Every name here is invented.
// Remove it all later from Admin > Students > "Remove dummy data".
const path = require('node:path');
const { openDb, tx } = require('./db');
const { addUser, ensureFirstAdmin, LOGINS_FILE } = require('./setup');
const lists = require('./lists');

const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data');
const PREFECT_COUNT = 23;
const STUDENTS_PER_FORM = 12;
const DEMERIT_COUNT = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const YEARS = ['1', '2', '3', '4', 'L6', 'U6'];
const STREAMS = ['Basil', 'Gregory', 'John', 'Plato', 'Socrates'];
const FIRST = ['Tariro', 'Kudzai', 'Rutendo', 'Tendai', 'Nyasha', 'Farai', 'Chipo', 'Tatenda', 'Simba', 'Ruvimbo', 'Anesu', 'Takudzwa', 'Noah', 'Ella', 'Liam', 'Mia', 'Ethan', 'Zara', 'Daniel', 'Sophie', 'Adam', 'Grace', 'Nikos', 'Eleni', 'Stavros', 'Katerina', 'Priya', 'Arjun', 'Mei', 'Wei', 'Thabo', 'Lindiwe', 'Sipho', 'Nomsa', 'Joshua', 'Hope'];
const SURNAME = ['Moyo', 'Ncube', 'Sibanda', 'Dziva', 'Mutasa', 'Chikomo', 'Makoni', 'Gumbo', 'Hove', 'Nyoni', 'Zvobgo', 'Marufu', 'Taylor', 'Carter', 'Hughes', 'Foster', 'Bennett', "O'Connor", 'van der Merwe', 'Papadakis', 'Georgiou', 'Nikolaidis', 'Patel', 'Naidoo', 'Zhang', 'Lin', 'Dlamini', 'Khumalo', 'Mokoena', 'Banda'];
const TEACHERS = ['Mr A Tester', 'Mrs B Sample', 'Miss C Example'];

// Fixed sequence, so the test data is the same on every machine.
let state = 20260101;
function random(n) {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return Math.floor((state / 4294967296) * n);
}
const pick = (values) => values[random(values.length)];

const db = openDb(path.join(DATA_DIR, 'prefects.db'));
ensureFirstAdmin(db, DATA_DIR);

if (db.prepare('SELECT 1 AS x FROM students WHERE is_dummy = 1 LIMIT 1').get()) {
  console.log('Dummy data is already loaded. Nothing changed.');
  process.exit(0);
}

const prefects = [];
for (let i = 1; i <= PREFECT_COUNT; i++) {
  const n = String(i).padStart(2, '0');
  addUser(db, { username: `prefect${n}`, displayName: `Test Prefect ${n}`, role: 'prefect', isDummy: true }, DATA_DIR);
  prefects.push(db.prepare('SELECT id FROM users WHERE username = ?').get(`prefect${n}`).id);
}

const studentIds = [];
tx(db, () => {
  const addStudent = db.prepare('INSERT INTO students (student_no, first_name, surname, form, is_dummy) VALUES (?, ?, ?, ?, 1)');
  const seen = new Set();
  let number = 1000;
  for (const year of YEARS) {
    for (const stream of STREAMS) {
      for (let i = 0; i < STUDENTS_PER_FORM; i++) {
        let first;
        let surname;
        do {
          first = pick(FIRST);
          surname = pick(SURNAME);
        } while (seen.has(`${first} ${surname}`));
        seen.add(`${first} ${surname}`);
        number += 1;
        studentIds.push(Number(addStudent.run(`T${number}`, first, surname, `${year} ${stream}`).lastInsertRowid));
      }
    }
  }
});

const offences = db.prepare('SELECT * FROM offences').all();
const ordinary = offences.filter((o) => !o.straight_to_list);
const serious = offences.filter((o) => o.straight_to_list && o.name !== 'Failure to attend manual');
const addDemerit = db.prepare(
  `INSERT INTO demerits (student_id, list_type, offence_id, label, straight_to_list, reported_by, created_by, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
function record(studentId, offence, daysAgo) {
  const when = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  const teacher = random(6) === 0 ? pick(TEACHERS) : null;
  addDemerit.run(studentId, offence.list_type, offence.id, lists.offenceLabel(offence), offence.straight_to_list, teacher, pick(prefects), when);
}

// Each incident is repeated for some students so they cross the two-demerit line.
tx(db, () => {
  for (let i = 0; i < DEMERIT_COUNT; i++) {
    const student = pick(studentIds);
    const offence = pick(ordinary);
    record(student, offence, 2 + random(14));
    if (random(2) === 0) record(student, pick(ordinary.filter((o) => o.list_type === offence.list_type)), 1 + random(2));
  }
  for (let i = 0; i < 5; i++) record(pick(studentIds), pick(serious), 1 + random(10));
});

// One published dress parade, so the phone register can be tried straight away.
const nextThursday = new Date();
nextThursday.setDate(nextThursday.getDate() + ((4 - nextThursday.getDay() + 7) % 7 || 7));
const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
const listId = lists.createDraft(
  db,
  { listType: 'dress', eventDate: lists.localDate(nextThursday.toISOString()), isDummy: true },
  admin
);
lists.publishList(db, listId);

// A few more after that list was made, showing the "goes on the next list" cut-off.
tx(db, () => {
  const dressOffences = ordinary.filter((o) => o.list_type === 'dress');
  for (let i = 0; i < 6; i++) {
    const student = pick(studentIds);
    record(student, pick(dressOffences), 0);
    record(student, pick(dressOffences), 0);
  }
});

console.log(`Loaded ${studentIds.length} dummy students and ${PREFECT_COUNT} dummy prefects.`);
console.log(`Logins are in ${path.join(DATA_DIR, LOGINS_FILE)}`);
db.close();
