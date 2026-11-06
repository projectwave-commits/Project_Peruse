'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {
  AlignmentType, Document, ImageRun, Packer, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType,
} = require('docx');

const LOGO = path.join(__dirname, '..', 'public', 'logo.png');
const CELL_FONT = 'Aptos Narrow';
const CELL_SIZE = 22;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parts(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return { year: y, month: m, day: d, dayName: DAYS[date.getDay()], monthName: MONTHS[m - 1] };
}

function ordinal(n) {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
}

const logo = () =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({ type: 'png', data: fs.readFileSync(LOGO), transformation: { width: 211, height: 96 } })],
  });

function cell(text, width, right = false) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    children: [
      new Paragraph({
        alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text, font: CELL_FONT, size: CELL_SIZE })],
      }),
    ],
  });
}

function table(rows, widths, alignment) {
  return new Table({
    alignment,
    layout: TableLayoutType.FIXED,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map(
      (values) =>
        new TableRow({ cantSplit: true, children: values.map((v, i) => cell(v, widths[i], i === 0)) })
    ),
  });
}

function a4(margin, children) {
  return {
    properties: {
      page: { size: { width: 11906, height: 16838 }, margin: { top: margin, right: margin, bottom: margin, left: margin } },
    },
    children,
  };
}

// Same layout as the current Manual Labour document: "Surname, First", who reported it, and why.
function manualSection(list, entries) {
  const when = parts(list.event_date);
  const centred = (children) => new Paragraph({ alignment: AlignmentType.CENTER, children });
  const bold = (text, extra = {}) => new TextRun({ text, bold: true, ...extra });
  const rows = entries.map((e) => {
    const d = parts(e.entry_date);
    return [`${d.day}/${d.month}/${d.year}`, `${e.surname}, ${e.first_name}`, e.form, e.reported_by, e.reason];
  });
  const children = [
    logo(),
    centred([bold(list.title)]),
    centred([
      bold(`${when.dayName} ${when.day}`),
      bold(ordinal(when.day), { superScript: true }),
      bold(` ${when.monthName}`),
    ]),
    centred([bold(list.event_time)]),
    new Paragraph({ spacing: { after: 240 }, children: [bold(list.instructions)] }),
    table(rows, [1400, 2600, 1400, 2115, 2665], AlignmentType.LEFT),
  ];
  return a4(720, children);
}

// Same layout as the current Dress Parade document: large centred heading, "First Surname", no reasons.
function dressSection(list, entries) {
  const when = parts(list.event_date);
  const heading = (text) =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 0 },
      children: [new TextRun({ text, bold: true, size: 40 })],
    });
  const rows = entries.map((e) => {
    const d = parts(e.entry_date);
    const pad = (n) => String(n).padStart(2, '0');
    return [`${pad(d.day)}/${pad(d.month)}/${pad(d.year % 100)}`, `${e.first_name} ${e.surname}`, e.form];
  });
  const children = [
    logo(),
    heading(list.title),
    heading(`${when.dayName} ${when.day} ${when.monthName}`.toUpperCase()),
    heading(list.event_time),
    heading(list.instructions),
    heading(''),
    table(rows, [1244, 2707, 1450], AlignmentType.CENTER),
  ];
  return a4(1440, children);
}

async function buildListDocx(list, entries) {
  const section = list.list_type === 'manual' ? manualSection(list, entries) : dressSection(list, entries);
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Aptos', size: 24 } } } },
    sections: [section],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildListDocx };
