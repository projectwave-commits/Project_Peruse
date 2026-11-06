const ExcelJS = require('exceljs');
const { db, getSetting } = require('./db');
const { allOptions, FORM_ORDER } = require('./rules');

const PINK = 'FFF4CCCC';
const BLUE = 'FFCFE2F3';
const GREEN = 'FFB6D7A8';
const RED = 'FFCC0000';
const COLUMN_WIDTHS = [24.88, 27.88, 24.5, 28, 29.25, 28, 30.88, 28, 31, 28.63, 30.5, 5.13, 27.88, 4.25, 13.25, 20];
const GRID_COLUMNS = 11;
const COLS = 'ABCDEFGHIJK';

const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb }, bgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FF000000' } };
const medium = { style: 'medium', color: { argb: 'FF000000' } };
const BOX_THIN = { left: thin, right: thin, top: thin, bottom: thin };
const BOX_MEDIUM = { left: medium, right: medium, top: medium, bottom: medium };

const formatSessions = (s) => (s ? s.split(',').join(' & ') : '');
const safeSheetName = (name) => name.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';

/** "THIRD TERM 2026" -> "T3_2026"; anything else is simply made filename-safe. */
function termCode(label) {
  const words = { FIRST: 1, SECOND: 2, THIRD: 3 };
  const m = /(FIRST|SECOND|THIRD)\s+TERM\s+(\d{4})/i.exec(label || '');
  if (m) return `T${words[m[1].toUpperCase()]}_${m[2]}`;
  return String(label || 'Term').trim().replace(/[^A-Za-z0-9]+/g, '_');
}

/** Selections for one class, as a Map of option id -> sorted array of display names. */
function namesByOption(className) {
  const rows = db.prepare(`
    SELECT sel.option_id, sel.sessions, st.name
    FROM selections sel JOIN students st ON st.id = sel.student_id
    WHERE st.active = 1 AND st.class_name = ?
    ORDER BY st.name`).all(className);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.option_id)) map.set(r.option_id, []);
    map.get(r.option_id).push(r.sessions ? `${r.name} (${formatSessions(r.sessions)})` : r.name);
  }
  return map;
}

/** Split options into rows of up to 11 columns, keeping each option's slot (and any gaps). */
function toBlocks(options) {
  const blocks = new Map();
  for (const o of options) {
    const index = Math.floor(o.slot / GRID_COLUMNS);
    if (!blocks.has(index)) blocks.set(index, new Array(GRID_COLUMNS).fill(null));
    blocks.get(index)[o.slot % GRID_COLUMNS] = o;
  }
  return [...blocks.keys()].sort((a, b) => a - b).map((k) => blocks.get(k));
}

function headerCell(cell, text, fill, size) {
  cell.value = text;
  cell.font = { name: 'Calibri', size, bold: true };
  cell.fill = solid(fill);
  cell.border = BOX_MEDIUM;
  cell.alignment = { horizontal: 'center', vertical: 'bottom', wrapText: true };
}

/** Text shown at the top of a column before the student names (mirrors the notes typed into the sheets). */
function preamble(option) {
  const lines = [];
  if (option.by_application) {
    lines.push('N.B ONLY BY APPLICATION', 'TO MR HONDO', '(dhondo@hellenicacademy.ac.zw)',
      'Students to select an alternative', 'club should they not be accepted');
  }
  if (option.closed) lines.push('NO MORE APPLICATIONS', 'CLUB FULLY SUBSCRIBED');
  return lines;
}

/** Write one grid block. Returns the next free row. */
function writeBlock(ws, startRow, block, names, fillFor, minRows) {
  const longest = Math.max(...block.map((o) => (o ? preamble(o).length + (names.get(o.id)?.length || 0) : 0)));
  const rows = Math.max(minRows, longest);

  block.forEach((option, c) => {
    const col = COLS[c];
    const size = option && option.header.length > 22 ? 17 : 18;
    headerCell(ws.getCell(`${col}${startRow}`), option ? option.header : null, fillFor(option), size);
    const lines = option ? preamble(option) : [];
    const list = option ? names.get(option.id) || [] : [];
    for (let i = 0; i < rows; i += 1) {
      const cell = ws.getCell(`${col}${startRow + 1 + i}`);
      cell.border = BOX_THIN;
      cell.alignment = { vertical: 'top' };
      if (i < lines.length) {
        cell.value = lines[i];
        cell.font = { name: 'Arial', size: 11, italic: true, color: { argb: RED } };
        cell.fill = solid(GREEN);
        cell.alignment = { horizontal: 'center', vertical: 'bottom' };
      } else if (i - lines.length < list.length) {
        cell.value = list[i - lines.length];
        cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: RED } };
      }
    }
  });
  return startRow + 1 + rows;
}

function titleLink(cell, text, url) {
  cell.value = url ? { text, hyperlink: url } : text;
  cell.font = { name: 'Arial', size: 18, bold: true, underline: true, color: { argb: 'FF1155CC' } };
}

function fillBand(ws, row, from, to, argb) {
  for (let c = from; c <= to; c += 1) ws.getCell(row, c).fill = solid(argb);
}

function writeClassSheet(workbook, className, students, options) {
  const ws = workbook.addWorksheet(safeSheetName(className), {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  COLUMN_WIDTHS.forEach((width, i) => { ws.getColumn(i + 1).width = width; });

  const school = getSetting('school_name');
  const term = getSetting('term_label');
  const names = namesByOption(className);
  const sports = options.filter((o) => o.category === 'sport');
  const clubs = options.filter((o) => o.category === 'club');

  // Sports heading and notes (rows 1-11)
  ws.getCell('A1').value = `${school} - SPORTS OPTIONS - ${term}`;
  ws.getCell('A1').font = { name: 'Calibri', size: 19, bold: true, underline: true };
  titleLink(ws.getCell('E1'), 'Sport Activities Timetable.pdf', getSetting('sport_timetable_url'));
  ws.getRow(2).height = 8.25;

  const NOTE_STYLES = [
    { name: 'Arial', size: 15, bold: true, italic: true },
    { name: 'Calibri', size: 16, bold: true },
    { name: 'Calibri', size: 16 },
  ];
  getSetting('sport_notes').split('\n').slice(0, 9).forEach((line, i) => {
    const cell = ws.getCell(`A${3 + i}`);
    cell.value = line || null;
    cell.font = NOTE_STYLES[i] || { name: 'Arial', size: 13 };
  });

  // Sports grid (row 14 banner, row 16 headers, names from row 17)
  fillBand(ws, 14, 1, 6, PINK);
  fillBand(ws, 14, 7, 11, BLUE);
  ws.getCell('A14').value = `SPORTS OPTIONS - GIRLS ${term}`;
  ws.getCell('G14').value = `SPORTS OPTIONS - BOYS ${term}`;
  for (const a of ['A14', 'G14']) ws.getCell(a).font = { name: 'Calibri', size: 20, bold: true, underline: true };

  const sportFill = (o) => (o && o.gender === 'M' ? BLUE : PINK);
  let row = 16;
  for (const block of toBlocks(sports)) row = writeBlock(ws, row, block, names, sportFill, 21);

  // Clubs banner
  for (let offset = 0; offset < 6; offset += 1) fillBand(ws, row + offset, 1, 11, GREEN);
  ws.getCell(`A${row}`).value = `${school} - CLUBS OPTIONS - ${term}`;
  ws.getCell(`A${row}`).font = { name: 'Calibri', size: 20, bold: true, underline: true };
  titleLink(ws.getCell(`E${row}`), 'Clubs and Society Activities Timetable.pdf', getSetting('club_timetable_url'));
  ws.getCell(`A${row + 4}`).value = getSetting('club_admission_note');
  ws.getCell(`A${row + 4}`).font = { name: 'Calibri', size: 16, bold: true, underline: true };

  // Club grid
  row += 6;
  const MIN_ROWS = [21, 21, 19];
  toBlocks(clubs).forEach((block, i) => {
    row = writeBlock(ws, row, block, names, () => GREEN, MIN_ROWS[i] ?? 10);
  });

  // Club notes
  getSetting('club_notes').split('\n').forEach((line, i) => {
    const cell = ws.getCell(`A${row + i}`);
    cell.value = line || null;
    cell.font = i === 0 ? { name: 'Arial', size: 14, bold: true, italic: true } : { name: 'Arial', size: 13 };
  });

  // Class list on the right: X = no sport, then name, gender, date of birth and any staff note
  const sportIds = sports.map((o) => o.id).join(',') || '0';
  const hasSport = new Set(db.prepare(`SELECT DISTINCT student_id FROM selections WHERE option_id IN (${sportIds})`)
    .all().map((r) => r.student_id));

  students.forEach((s, i) => {
    const r = 17 + i;
    if (!hasSport.has(s.id)) ws.getCell(`L${r}`).value = 'X';
    const cells = [
      [`M${r}`, s.name],
      [`N${r}`, s.gender],
      [`O${r}`, s.dob ? new Date(`${s.dob}T00:00:00Z`) : null],
    ];
    for (const [address, value] of cells) {
      const cell = ws.getCell(address);
      cell.value = value;
      cell.font = { name: 'Arial', size: 12 };
      cell.border = BOX_THIN;
      cell.alignment = { vertical: 'top' };
    }
    ws.getCell(`O${r}`).numFmt = 'yyyy-mm-dd';
    if (s.note) {
      ws.getCell(`P${r}`).value = s.note;
      ws.getCell(`P${r}`).font = { name: 'Arial', size: 10 };
    }
  });
}

/** The class-by-class workbook for one form, in the same layout as the original sheets. */
async function formWorkbook(formLabel) {
  const students = db.prepare(`SELECT * FROM students WHERE active = 1 AND form_label = ? ORDER BY ${FORM_ORDER}`).all(formLabel);
  if (!students.length) return null;
  const options = allOptions().filter((o) => o.active);
  const workbook = new ExcelJS.Workbook();
  const byClass = new Map();
  for (const s of students) {
    if (!byClass.has(s.class_name)) byClass.set(s.class_name, []);
    byClass.get(s.class_name).push(s);
  }
  for (const [className, list] of byClass) writeClassSheet(workbook, className, list, options);
  return {
    buffer: await workbook.xlsx.writeBuffer(),
    filename: `${formLabel.replace(' ', '_')}_Sports_and_Club_Options_${termCode(getSetting('term_label'))}.xlsx`,
  };
}

function rosterRows(optionId, formLabel) {
  return db.prepare(`
    SELECT st.id, st.name, st.gender, st.form_label, st.form_level, st.class_name, sel.sessions
    FROM selections sel JOIN students st ON st.id = sel.student_id
    WHERE sel.option_id = ? AND st.active = 1 ${formLabel ? 'AND st.form_label = ?' : ''}
    ORDER BY ${FORM_ORDER}`).all(...(formLabel ? [optionId, formLabel] : [optionId]));
}

function writeRosterSheet(workbook, option, rows, sheetName) {
  const ws = workbook.addWorksheet(sheetName, {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: 'frozen', ySplit: 3 }],
  });
  const hasSessions = option.sessions.length > 0;
  [36, 12, 12, 9, ...(hasSessions ? [12] : [])].forEach((width, i) => { ws.getColumn(i + 1).width = width; });
  ws.getCell('A1').value = `${option.header} - ${getSetting('term_label')}`;
  ws.getCell('A1').font = { size: 14, bold: true };
  ws.getCell('A2').value = `${rows.length} student${rows.length === 1 ? '' : 's'}`;
  const header = ws.getRow(3);
  header.values = ['Name', 'Form', 'Class', 'Gender', ...(hasSessions ? ['Session'] : [])];
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = solid('FFE7ECF3');
    cell.border = BOX_THIN;
  });
  for (const r of rows) {
    const added = ws.addRow([r.name, r.form_label, r.class_name, r.gender, ...(hasSessions ? [formatSessions(r.sessions)] : [])]);
    added.eachCell({ includeEmpty: true }, (cell) => { cell.border = BOX_THIN; });
  }
}

/** Student list for one club or sport, optionally for just one form. */
async function rosterWorkbook(option, formLabel) {
  const workbook = new ExcelJS.Workbook();
  writeRosterSheet(workbook, option, rosterRows(option.id, formLabel), safeSheetName(option.header));
  const label = option.header.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return {
    buffer: await workbook.xlsx.writeBuffer(),
    filename: `${label}${formLabel ? `_${formLabel.replace(/[^A-Za-z0-9]+/g, '_')}` : ''}_${termCode(getSetting('term_label'))}.xlsx`,
  };
}

/** Every club and sport list, one tab each. */
async function allRostersWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const used = new Set();
  for (const option of allOptions().filter((o) => o.active)) {
    const base = safeSheetName(option.header);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    writeRosterSheet(workbook, option, rosterRows(option.id), name);
  }
  return {
    buffer: await workbook.xlsx.writeBuffer(),
    filename: `All_Club_and_Sport_Lists_${termCode(getSetting('term_label'))}.xlsx`,
  };
}

module.exports = { formWorkbook, rosterWorkbook, allRostersWorkbook, rosterRows };
