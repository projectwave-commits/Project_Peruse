// Weekly times from the Third Term 2026 Sports and Clubs timetables, keyed by spreadsheet heading.
// Form levels: 1-4 = Form 1-4, 5 = Lower 6, 6 = Upper 6.
//
// Sports timetables use age groups. These are mapped to forms as:
//   U14 = F1, U15 = F2, U16 = F3, Open = F4 and up, U16+ = F3 and up.
//
// Deliberately left out, because they would raise false clash warnings:
//   - Morning swimming and water polo conditioning (students pick a morning, or it clashes with nothing)
//   - Choir (several alternative sessions, and the timetable doesn't say which a student attends)
//   - Sunday events, Boxing (no timetable entry)

const { getSetting } = require('./db');

const MW = ['Mon', 'Wed'];
const TT = ['Tue', 'Thu'];
const ALL = [1, 6];
const F1 = [1, 1];
const F2 = [2, 2];
const F12 = [1, 2];
const F3 = [3, 3];
const F3UP = [3, 6];
const F4UP = [4, 6];

const row = (days, start, end, forms = ALL, session) => ({ days, start, end, forms, session });

const SWIMMING = [row(['Thu'], '17:00', '18:00')];
const CROSS_TRAINING = [row(TT, '15:30', '16:30', F3UP)];

const TIMETABLE = {
  // Sports
  'GIRLS SWIMMING': SWIMMING,
  'BOYS SWIMMING': SWIMMING,
  'GIRLS WATERPOLO': [row(MW, '15:30', '17:00', F1), row(MW, '14:00', '15:30', F2), row(TT, '14:00', '15:30', F3UP)],
  'BOYS WATERPOLO': [row(MW, '15:30', '17:00', F1), row(MW, '14:00', '15:30', F2), row(TT, '15:30', '17:00', F3UP)],
  'GIRLS TENNIS': [row(MW, '14:00', '15:00', F1), row(MW, '15:30', '16:30', F2), row(TT, '14:00', '15:00', F3UP)],
  'BOYS TENNIS': [row(MW, '14:00', '15:00', F1), row(MW, '15:30', '16:30', F2), row(TT, '15:30', '16:30', F3), row(TT, '14:00', '15:00', F4UP)],
  'GIRLS SOCCER': [row(MW, '15:30', '17:00', F12), row(TT, '15:30', '16:30', F3UP)],
  'GIRLS CRICKET F1&F2': [row(MW, '14:00', '15:30', F12)],
  'BOYS CRICKET': [row(MW, '14:00', '15:30', F1), row(MW, '15:30', '17:00', F2), row(TT, '14:00', '15:30', F3), row(TT, '15:30', '17:00', F4UP)],
  'GIRLS CROSS TRAINING F3+': CROSS_TRAINING,
  'BOYS CROSS TRAINING F3+': CROSS_TRAINING,

  // Clubs
  DRAMA: [row(['Tue'], '14:00', '15:00', F12)],
  'FIRST AID': [row(['Mon'], '14:00', '15:00', F3UP), row(['Tue'], '14:00', '15:00', F2)],
  SQUASH: [row(['Mon'], '14:00', '15:00', F3UP), row(['Thu'], '14:00', '15:00', F12)],
  'VOCAL ENSEMBLE': [row(['Mon'], '14:00', '15:00', F3UP)],
  'CHESS (state session A/B/C/D)': [
    row(['Tue'], '14:00', '15:00', ALL, 'A'),
    row(['Tue'], '15:00', '16:00', ALL, 'B'),
    row(['Thu'], '14:00', '15:00', ALL, 'C'),
    row(['Thu'], '15:00', '16:00', ALL, 'D'),
  ],
  ARCHERY: [row(['Tue'], '14:30', '15:30', F12), row(['Wed'], '14:00', '15:00', F3UP)],
  GOLF: [row(['Mon'], '14:00', '16:00', F3UP), row(['Thu'], '14:00', '16:00', F12)],
  'JAZZ BAND': [row(['Fri'], '14:00', '15:00')],
  DEBATE: [row(['Wed'], '15:00', '16:00', F3UP), row(['Thu'], '14:00', '15:00', F12)],
  'EPD F3+': [row(MW, '14:00', '15:30', F3UP)],
  'TOAST MASTERS': [row(['Tue'], '18:00', '19:30')],
  MARIMBAS: [row(['Wed'], '15:00', '16:00', F3UP), row(['Thu'], '15:00', '16:00', F12)],
  QUIZ: [row(['Mon'], '15:00', '16:00', F3UP), row(['Thu'], '15:00', '16:00', F12)],
  DRONE: [row(['Tue', 'Wed'], '06:45', '07:15')],
  ORCHESTRA: [row(['Mon'], '16:30', '18:15')],
  STRINGS: [row(['Tue'], '16:30', '18:00')],
  'BOOK CLUB': [row(['Mon'], '14:00', '15:00', F3UP), row(['Thu'], '14:00', '15:00', F12)],
  'BEGINNER GUITAR': [row(['Tue'], '14:00', '15:00', F12), row(['Wed'], '14:00', '15:00', F3UP)],
  'COOKERY CLUB F2 ONLY': [row(TT, '15:00', '16:30', F2)],
  ENVIRONMENTAL: [row(['Wed'], '14:00', '15:00', F3UP), row(['Thu'], '15:00', '16:00', F12)],
  // The timetable's "F6" for Interact and Toastmasters means sixth form: Lower 6 and Upper 6 both take them.
  INTERACT: [row(['Mon'], '17:00', '18:00')],
  'LIFE DRAWING': [row(['Wed'], '14:00', '15:00')],
  'TIME TRAVELLERS': [row(['Tue'], '15:00', '16:00')],
  'WIND BAND': [row(['Thu'], '16:30', '18:00')],
  'MATHS OLYMPIAD F4+': [row(['Mon'], '14:00', '16:00', F4UP)],
  'MEDIA F4+': [row(['Wed'], '15:00', '16:00', F4UP)],
  'SOCCER - BOYS': [row(['Wed'], '15:00', '16:00', F3UP), row(['Thu'], '16:00', '17:00', F12)],
  MUN: [row(['Wed'], '17:00', '18:30')],
  ROBOTICS: [row(['Mon'], '14:00', '15:00', F3UP), row(['Tue'], '14:00', '15:00', F12)],
  'CRAFTING JNR & SNR': [row(['Tue'], '14:00', '15:00', F12), row(['Wed'], '14:00', '15:00', F3UP)],
  FLIPSIDE: [row(['Fri'], '10:15', '10:50')],
};

/** The weekly sessions of this option for this student's form, or [] if unknown or switched off. */
function timesFor(option, student) {
  if (getSetting('clash_warnings') !== '1') return [];
  const rows = TIMETABLE[option.header] || [];
  return rows
    .filter((r) => student.form_level >= r.forms[0] && student.form_level <= r.forms[1])
    .flatMap((r) => r.days.map((day) => ({ day, start: r.start, end: r.end, session: r.session || null })));
}

module.exports = { timesFor, TIMETABLE };
