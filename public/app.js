'use strict';

const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
let me = null;
let renderToken = 0;
let toastTimer = null;

// ---- Helpers ----

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'required') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body.error || 'Something went wrong.');
    this.status = status;
    this.code = body.code;
    this.duplicates = body.duplicates;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'prefects-app' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: 'Cannot reach the server. Are you on the school network?' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && me) {
      me = null;
      renderLogin();
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

function toast(message, bad = false) {
  toastEl.textContent = message;
  toastEl.className = bad ? 'toast bad' : 'toast';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

const go = (hash) => { location.hash = hash; };

function fmtDate(value, withYear = false) {
  const date = value.length === 10 ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined });
}

function fmtDateTime(value) {
  const date = new Date(value);
  return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

const fullName = (s) => `${s.first_name} ${s.surname}`;
const listShort = (type) => (type === 'manual' ? 'Manual' : 'Dress');
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

// Runs a button's action once, showing failures as a toast instead of losing them.
function guarded(fn) {
  return async (event) => {
    const button = event?.currentTarget;
    if (button) button.disabled = true;
    try {
      await fn(event);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (button && button.isConnected) button.disabled = false;
    }
  };
}

function sheet(title, build, onClosed) {
  const dialog = h('dialog', { class: 'sheet' });
  const close = () => dialog.close();
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (onClosed) onClosed();
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.append(
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'sheet-body' }, build(close))
  );
  document.body.append(dialog);
  dialog.showModal();
  return close;
}

function confirmSheet({ title, message, action, danger }) {
  return new Promise((resolve) => {
    let answer = false;
    sheet(title, (close) => [
      h('p', { class: 'pre-line' }, message),
      h('button', {
        type: 'button',
        class: `btn block ${danger ? 'danger' : 'primary'}`,
        onclick: () => { answer = true; close(); },
      }, action),
      h('button', { type: 'button', class: 'btn block', onclick: close }, 'Go back'),
    ], () => resolve(answer));
  });
}

function formError() {
  return h('div', { class: 'error', role: 'alert', hidden: true });
}

function submitter(errorEl, fn) {
  return async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    errorEl.hidden = true;
    if (button) button.disabled = true;
    try {
      await fn(new FormData(event.currentTarget));
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      if (button) button.disabled = false;
    }
  };
}

const field = (label, input, hint) => h('label', { class: 'field' }, label, input, hint && h('span', { class: 'hint' }, hint));

// ---- Page frame ----

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  lists: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  mine: '<path d="M12 3v3M5 21h14M7 21V9h10v12M10 13h4"/>',
  admin: '<path d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7z"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const template = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  template.innerHTML = ICONS[name];
  svg.append(...template.childNodes);
  return svg;
}

function page(title, { back, active, actions, mainClass } = {}, ...content) {
  const tabs = [
    ['search', '#/', 'Find', 'search'],
    ['lists', '#/lists', 'Lists', 'lists'],
    ['mine', '#/mine', 'My demerits', 'mine'],
  ];
  if (me.role === 'admin') tabs.push(['admin', '#/admin', 'Admin', 'admin']);
  root.replaceChildren(
    h('header', { class: 'topbar' },
      back && h('a', { class: 'icon-btn back', href: back, 'aria-label': 'Back' }, '‹'),
      h('h1', {}, title),
      actions || null),
    h('main', { class: mainClass }, h('div', { class: 'stack' }, content)),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, tabs.map(([key, href, label, ic]) =>
      h('a', { href, 'aria-current': active === key ? 'page' : null, 'data-tab': key }, icon(ic), label)))
  );
  window.scrollTo(0, 0);
  if (me.role === 'admin') refreshAdminBadge();
}

async function refreshAdminBadge() {
  const { count } = await api('/admin/attention').catch(() => ({ count: 0 }));
  const tab = document.querySelector('.nav a[data-tab="admin"]');
  if (tab && count > 0 && !tab.querySelector('.nav-badge')) tab.append(h('span', { class: 'nav-badge', 'aria-label': `${count} need attention` }, String(count)));
}

function loading(title, opts) {
  page(title, opts, h('p', { class: 'empty' }, 'Loading…'));
}

function failure(title, opts, err) {
  page(title, opts, h('div', { class: 'error' }, err.message));
}

// ---- Login ----

function renderLogin() {
  const error = formError();
  root.replaceChildren(
    h('div', { class: 'login' },
      h('img', { src: 'logo.png', alt: 'Hellenic Academy' }),
      h('h1', {}, 'Prefects'),
      h('form', {
        class: 'stack',
        onsubmit: submitter(error, async (data) => {
          await api('/login', { method: 'POST', body: { username: data.get('username'), password: data.get('password') } });
          me = await api('/me');
          route();
        }),
      },
      error,
      field('Username', h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, autofocus: true })),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      h('button', { class: 'btn primary block', type: 'submit' }, 'Log in')))
  );
}

function passwordForm(onDone) {
  const error = formError();
  return h('form', {
    class: 'stack',
    onsubmit: submitter(error, async (data) => {
      if (data.get('newPassword') !== data.get('repeat')) throw new Error('The two new passwords do not match.');
      await api('/me/password', { method: 'POST', body: { currentPassword: data.get('currentPassword'), newPassword: data.get('newPassword') } });
      me.must_change_password = 0;
      onDone();
    }),
  },
  error,
  field('Current password', h('input', { name: 'currentPassword', type: 'password', autocomplete: 'current-password', required: true })),
  field('New password', h('input', { name: 'newPassword', type: 'password', autocomplete: 'new-password', minlength: 8, required: true }), 'At least 8 characters.'),
  field('Repeat new password', h('input', { name: 'repeat', type: 'password', autocomplete: 'new-password', required: true })),
  h('button', { class: 'btn primary block', type: 'submit' }, 'Save password'));
}

function renderForcePassword() {
  root.replaceChildren(
    h('div', { class: 'login' },
      h('img', { src: 'logo.png', alt: 'Hellenic Academy' }),
      h('h1', {}, `Welcome, ${me.display_name}`),
      h('div', { class: 'stack' },
        h('p', { class: 'notice' }, 'Please choose your own password. Do not share it: every demerit is recorded under your name.'),
        passwordForm(() => route())))
  );
}

function logoutButton() {
  return h('button', {
    class: 'btn block',
    onclick: guarded(async () => {
      await api('/logout', { method: 'POST', body: {} });
      me = null;
      location.hash = '#/';
      renderLogin();
    }),
  }, 'Log out');
}

// ---- Find a student ----

let lastSearch = '';

function renderSearch() {
  const results = h('div', { class: 'stack' });
  let searchToken = 0;

  async function run(value) {
    lastSearch = value;
    const query = value.trim();
    const token = ++searchToken;
    if (!query) {
      results.replaceChildren(h('div', { class: 'find-hero' },
        h('img', { src: 'doodle-hero.svg', alt: '', width: 220, height: 170 }),
        h('h2', {}, 'Who’s been naughty?'),
        h('p', { class: 'muted' }, 'Type a name or class, like “Moyo”, “Tariro 3 Plato” or “4P”.')));
      return;
    }
    try {
      const rows = await api(`/students?q=${encodeURIComponent(query)}`);
      if (token !== searchToken) return;
      results.replaceChildren(
        rows.length
          ? h('div', { class: 'card tight' }, rows.map((s) =>
              h('a', { class: 'result', href: `#/student/${s.id}` },
                h('div', { class: 'grow' }, h('div', { class: 'name' }, `${s.surname}, ${s.first_name}`), h('div', { class: 'muted small' }, s.form)),
                h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))))
          : h('p', { class: 'empty card' }, 'No student found. Check the spelling, or try just the surname.')
      );
    } catch (err) {
      if (token === searchToken) results.replaceChildren(h('div', { class: 'error' }, err.message));
    }
  }

  const input = h('input', {
    type: 'search',
    placeholder: 'Search students…',
    'aria-label': 'Search students',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    value: lastSearch,
    oninput: debounce((e) => run(e.target.value), 140),
  });

  page('Find a student', {
    active: 'search',
    mainClass: 'doodle-page',
    actions: h('a', { class: 'icon-btn account-link', href: '#/account', 'aria-label': `Account: ${me.username}` }, me.username),
  }, h('div', { class: 'search-wrap' }, input),
  results,
  h('a', { class: 'btn primary bulk-link', href: '#/bulk' }, 'Bulk upload'));
  run(lastSearch);
  input.focus();
  input.select();
}

// ---- Bulk upload ----

const bulkKey = () => `bulk-upload-${me.id}`;

// Unsaved work survives leaving the page, for example to check a student's record.
function loadBulk() {
  try {
    return JSON.parse(sessionStorage.getItem(bulkKey())) || { type: null, offenceId: '', rows: [] };
  } catch {
    return { type: null, offenceId: '', rows: [] };
  }
}

function storeBulk(draft) {
  try {
    if (draft.rows.length) sessionStorage.setItem(bulkKey(), JSON.stringify(draft));
    else sessionStorage.removeItem(bulkKey());
  } catch {
    // Private browsing can block storage. The list still works until the page is left.
  }
}

async function renderBulk(done) {
  const token = renderToken;
  const opts = { back: '#/', active: 'search' };
  if (done) {
    return page('Bulk upload', opts,
      h('div', { class: `success ${done.listed.length ? 'alert' : ''} stack`, role: 'status' },
        h('div', { class: 'strong' }, `Uploaded ${done.count} demerit${done.count === 1 ? '' : 's'} for ${done.listName}.`),
        done.listed.length
          ? h('div', {}, `On the next list: ${done.listed.join(', ')}.`)
          : h('div', {}, 'Nobody reached the list with these.')),
      h('button', { class: 'btn primary block', type: 'button', onclick: () => renderBulk() }, 'Upload more'),
      h('a', { class: 'btn block', href: '#/' }, 'Done'));
  }

  loading('Bulk upload', opts);
  let catalogue;
  try {
    catalogue = await loadOffences(true);
  } catch (err) {
    return failure('Bulk upload', opts, err);
  }
  if (token !== renderToken) return;

  const draft = loadBulk();
  if (!catalogue.types.some((t) => t.key === draft.type)) draft.type = lastType;
  // Serious reasons go straight on a list, so in bulk they are for admins only.
  const available = () => catalogue.offences.filter((o) => o.list_type === draft.type && (me.role === 'admin' || !o.straight_to_list));
  if (!available().some((o) => String(o.id) === draft.offenceId)) draft.offenceId = '';

  const typePicker = h('div', { class: 'segments', role: 'group', 'aria-label': 'Which list' });
  const results = h('div', { class: 'stack' });
  const rowsBox = h('div', { class: 'stack' });
  const reasonBox = h('div');
  let searchToken = 0;

  function drawReason() {
    reasonBox.replaceChildren(field('Reason for everyone on this upload', h('select', {
      name: 'bulkReason',
      onchange: (e) => {
        draft.offenceId = e.target.value;
        storeBulk(draft);
      },
    },
    h('option', { value: '' }, 'Choose a reason…'),
    available().map((o) => h('option', { value: String(o.id), selected: draft.offenceId === String(o.id) ? 'selected' : null },
      `${o.class ? `${o.class}: ` : ''}${o.name}${o.straight_to_list ? ' (straight to list)' : ''}`)))));
  }

  function drawTypes() {
    typePicker.replaceChildren(...catalogue.types.map((t) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(t.key === draft.type),
        onclick: () => {
          if (t.key === draft.type) return;
          // Each list has its own reasons.
          draft.type = t.key;
          draft.offenceId = '';
          storeBulk(draft);
          drawTypes();
          drawReason();
        },
      }, t.name)));
  }

  function drawRows() {
    rowsBox.replaceChildren(
      draft.rows.length
        ? h('div', { class: 'card tight' }, draft.rows.map((r) =>
            h('div', { class: 'bulk-row' },
              h('div', { class: 'row' },
                h('div', { class: 'grow' },
                  h('div', { class: 'strong' }, `${r.student.surname}, ${r.student.first_name}`),
                  h('div', { class: 'muted small' }, r.student.form)),
                h('button', {
                  class: 'btn small',
                  type: 'button',
                  'aria-label': `Remove ${fullName(r.student)}`,
                  onclick: () => {
                    draft.rows = draft.rows.filter((x) => x !== r);
                    storeBulk(draft);
                    drawRows();
                  },
                }, 'Remove')))))
        : h('p', { class: 'empty card' }, 'Nobody added yet. Search above and tap a student to add them.'),
      draft.rows.length
        ? h('button', { class: 'btn primary block', type: 'button', onclick: guarded(upload) },
            `Upload ${draft.rows.length} demerit${draft.rows.length === 1 ? '' : 's'}`)
        : ''
    );
  }

  async function upload() {
    const reason = available().find((o) => String(o.id) === draft.offenceId);
    if (!reason) {
      toast('Choose a reason first.', true);
      return;
    }
    const listName = catalogue.types.find((t) => t.key === draft.type).name;
    const count = draft.rows.length;
    const sure = await confirmSheet({
      title: 'Upload all?',
      message: `This gives ${count} demerit${count === 1 ? '' : 's'} for ${listName}: ${reason.name}.`,
      action: 'Upload',
    });
    if (!sure) return;
    const body = {
      listType: draft.type,
      offenceId: reason.id,
      studentIds: draft.rows.map((r) => r.student.id),
    };
    let result;
    try {
      result = await api('/demerits/bulk', { method: 'POST', body });
    } catch (err) {
      if (err.code !== 'duplicate') throw err;
      const yes = await confirmSheet({
        title: 'Already recorded today',
        message: `These students already have the same demerit today, possibly from another prefect:\n\n${err.duplicates.join('\n')}\n\nTwo demerits put a student on the list, so please only continue if these are separate incidents. Otherwise go back and remove them.`,
        action: 'Yes, separate incidents',
      });
      if (!yes) return;
      result = await api('/demerits/bulk', { method: 'POST', body: { ...body, confirmDuplicate: true } });
    }
    lastType = draft.type;
    storeBulk({ type: draft.type, offenceId: '', rows: [] });
    renderBulk(result);
  }

  async function search(value) {
    const query = value.trim();
    const token = ++searchToken;
    if (!query) return results.replaceChildren();
    try {
      const rows = await api(`/students?q=${encodeURIComponent(query)}`);
      if (token !== searchToken) return;
      const added = new Set(draft.rows.map((r) => r.student.id));
      const fresh = rows.filter((s) => !added.has(s.id));
      results.replaceChildren(
        fresh.length
          ? h('div', { class: 'card tight' }, fresh.map((s) =>
              h('button', {
                class: 'result',
                type: 'button',
                onclick: () => {
                  draft.rows.push({ student: { id: s.id, first_name: s.first_name, surname: s.surname, form: s.form } });
                  storeBulk(draft);
                  input.value = '';
                  results.replaceChildren();
                  drawRows();
                  input.focus();
                },
              },
              h('div', { class: 'grow' }, h('div', { class: 'name' }, `${s.surname}, ${s.first_name}`), h('div', { class: 'muted small' }, s.form)),
              h('span', { class: 'chev', 'aria-hidden': 'true' }, '+'))))
          : h('p', { class: 'empty card' }, rows.length ? 'Already added.' : 'No student found. Check the spelling, or try just the surname.')
      );
    } catch (err) {
      if (token === searchToken) results.replaceChildren(h('div', { class: 'error' }, err.message));
    }
  }

  const input = h('input', {
    type: 'search',
    placeholder: 'Add a student…',
    'aria-label': 'Add a student',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    oninput: debounce((e) => search(e.target.value), 140),
  });

  drawTypes();
  drawReason();
  drawRows();
  page('Bulk upload', opts, typePicker, reasonBox, input, results, rowsBox);
}

// ---- Student record and recording a demerit ----

let offenceCache = null;
let lastType = 'dress';

async function loadOffences(force) {
  if (!offenceCache || force) offenceCache = await api('/offences');
  return offenceCache;
}

function tallyCard(t, entries) {
  const onList = entries.filter((e) => e.list_type === t.key);
  const next = t.listed > 0;
  const towards = t.count > 0 ? `Also ${t.count} of ${t.threshold} towards another` : null;
  let headline = h('div', { class: 'num' }, String(t.count), h('span', {}, ` of ${t.threshold}`));
  let state;
  if (next) {
    headline = h('div', { class: 'num' }, 'Next list');
    state = towards || 'Goes on the next list';
  } else if (onList.length) {
    headline = h('div', { class: 'num' }, 'On a list');
    state = `${fmtDate(onList[0].event_date)}${towards ? `. ${towards}` : ''}`;
  } else if (t.threshold - t.count === 1) state = 'One more puts them on the list';
  else state = `${t.threshold - t.count} more puts them on the list`;
  return h('div', { class: `tally ${next || onList.length ? 'alert' : ''}` },
    h('div', { class: 'small strong' }, t.name),
    headline,
    h('div', { class: 'state' }, state));
}

function resultMessage(result) {
  if (result.straight) return `This goes straight on the next ${result.tally.name} list.`;
  if (result.tally.listed > 0 && result.tally.count === 0) return `That makes ${result.tally.threshold}. They go on the next ${result.tally.name} list.`;
  const left = result.tally.threshold - result.tally.count;
  return `${result.tally.count} of ${result.tally.threshold} for ${result.tally.name}. ${left === 1 ? 'One more' : `${left} more`} puts them on the list.`;
}

async function renderStudent(id, justRecorded) {
  const token = renderToken;
  const opts = { back: '#/', active: 'search' };
  loading('Student', opts);
  let record;
  let catalogue;
  try {
    [record, catalogue] = await Promise.all([api(`/students/${id}`), loadOffences(true)]);
  } catch (err) {
    return failure('Student', opts, err);
  }
  if (token !== renderToken) return;
  const { student, tallies, demerits, entries } = record;
  const canRecord = student.active === 1;

  const picker = h('div', { class: 'stack' });
  function drawPicker() {
    const offences = catalogue.offences.filter((o) => o.list_type === lastType);
    picker.replaceChildren(
      h('div', { class: 'segments', role: 'group', 'aria-label': 'Which list' }, catalogue.types.map((t) =>
        h('button', {
          type: 'button',
          'aria-pressed': String(t.key === lastType),
          onclick: () => { lastType = t.key; drawPicker(); },
        }, t.name))),
      offences.length
        ? h('div', { class: 'card tight' }, offences.map((o) =>
            h('button', { class: 'offence', type: 'button', onclick: () => openRecord(student, o) },
              h('span', { class: 'grow' }, o.name),
              o.class && h('span', { class: `badge ${o.class === 'C1' ? 'red' : ''}` }, o.class),
              o.straight_to_list ? h('span', { class: 'badge red' }, 'Straight to list') : null)))
        : h('p', { class: 'empty' }, 'No demerit types set up for this list yet.')
    );
  }
  drawPicker();

  page(fullName(student), opts,
    justRecorded && h('div', { class: `success ${justRecorded.result.tally.listed > 0 || justRecorded.result.straight ? 'alert' : ''} stack`, role: 'status' },
      h('div', {},
        h('div', { class: 'strong' }, `Recorded: ${justRecorded.label}`),
        h('div', {}, resultMessage(justRecorded.result))),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary grow', href: '#/' }, 'Next student'),
        h('button', {
          class: 'btn',
          onclick: guarded(async () => {
            await api(`/demerits/${justRecorded.result.id}/cancel`, { method: 'POST', body: { reason: 'Undone straight after recording' } });
            toast('Demerit undone.');
            renderStudent(id);
          }),
        }, 'Undo'))),
    h('div', {},
      h('div', { class: 'row wrap' },
        h('span', { class: 'badge' }, student.form),
        student.student_no && h('span', { class: 'muted small' }, student.student_no),
        !canRecord && h('span', { class: 'badge grey' }, 'No longer active'))),
    h('div', { class: 'tallies' }, tallies.map((t) => tallyCard(t, entries))),
    canRecord && h('h2', { class: 'section-title' }, 'Give a demerit'),
    canRecord && picker,
    h('h2', { class: 'section-title' }, 'History'),
    demerits.length
      ? h('div', { class: 'card tight' }, demerits.map((d) => historyItem(d, id)))
      : h('p', { class: 'empty' }, 'No demerits recorded.'));
}

function historyItem(d, studentId) {
  const who = d.created_by_name || (d.mine ? 'You' : 'Prefects');
  return h('div', { class: 'item' },
    h('div', { class: 'grow' },
      h('div', { class: d.voided ? 'cancelled strong' : 'strong' }, d.label),
      h('div', { class: 'muted small' }, `${listShort(d.list_type)} · ${fmtDateTime(d.created_at)} · ${d.reported_by ? `${d.reported_by} (via ${who})` : who}`),
      d.note && h('div', { class: 'small' }, d.note),
      d.voided && h('div', { class: 'small muted' }, `Cancelled${d.void_reason ? `: ${d.void_reason}` : ''}`),
      !d.voided && d.on_list && h('span', { class: 'badge amber' }, 'On a list'),
      !d.voided && d.expired && h('span', { class: 'badge grey' }, 'Earlier term, no longer counts')),
    d.can_cancel && h('button', {
      class: 'btn small subtle-danger',
      onclick: guarded(async () => {
        const yes = await confirmSheet({ title: 'Cancel this demerit?', message: d.label, action: 'Cancel demerit', danger: true });
        if (!yes) return;
        await api(`/demerits/${d.id}/cancel`, { method: 'POST', body: { reason: 'Cancelled by the person who recorded it' } });
        toast('Demerit cancelled.');
        renderStudent(studentId);
      }),
    }, 'Cancel'));
}

function openRecord(student, offence) {
  const error = formError();
  const teacherInput = h('input', { name: 'reportedBy', placeholder: 'e.g. Mrs Whyte', autocomplete: 'off' });
  const straightWrap = h('label', { class: 'check', hidden: true },
    h('input', { name: 'straightToList', type: 'checkbox' }),
    h('span', {}, 'The teacher asked for this to go straight on the list'));
  teacherInput.addEventListener('input', () => { straightWrap.hidden = !teacherInput.value.trim(); });

  sheet('Confirm demerit', (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        const body = {
          studentId: student.id,
          offenceId: offence.id,
          note: data.get('note'),
          reportedBy: data.get('reportedBy'),
          straightToList: data.get('straightToList') === 'on',
        };
        const send = () => api('/demerits', { method: 'POST', body });
        let result;
        try {
          result = await send();
        } catch (err) {
          if (err.code !== 'duplicate') throw err;
          const yes = await confirmSheet({
            title: 'Already recorded today',
            message: `${fullName(student)} already has “${offence.name}” today, possibly from another prefect. Two demerits put a student on the list, so please only continue if this is a separate incident.`,
            action: 'Yes, separate incident',
          });
          if (!yes) return;
          body.confirmDuplicate = true;
          result = await send();
        }
        close();
        renderStudent(student.id, { label: offence.name, result });
      }),
    },
    error,
    h('div', { class: 'card' },
      h('div', { class: 'strong' }, `${fullName(student)}, ${student.form}`),
      h('div', {}, offence.class ? `${offence.class}: ${offence.name}` : offence.name),
      offence.straight_to_list ? h('div', { class: 'small muted' }, 'This is a serious offence and goes straight on the next list.') : null),
    field('Note (optional)', h('textarea', { name: 'note', maxlength: 500, placeholder: 'What happened?' }), 'Only you and the admins can see this.'),
    h('details', {},
      h('summary', { class: 'small strong' }, 'A teacher asked you to list this'),
      h('div', { class: 'stack' },
        h('div', {}),
        field('Teacher’s name', teacherInput, 'Shown as “Reported by” on the list.'),
        straightWrap)),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Give demerit'))
  );
}

// ---- My demerits and account ----

async function renderMine() {
  const token = renderToken;
  const opts = { active: 'mine' };
  loading('My demerits', opts);
  let rows;
  try {
    rows = await api('/demerits/mine');
  } catch (err) {
    return failure('My demerits', opts, err);
  }
  if (token !== renderToken) return;
  page('My demerits', opts,
    rows.length
      ? h('div', { class: 'card tight' }, rows.map((d) =>
          h('a', { class: 'result', href: `#/student/${d.student_id}` },
            h('div', { class: 'grow' },
              h('div', { class: d.voided_at ? 'name cancelled' : 'name' }, `${d.surname}, ${d.first_name}`),
              h('div', { class: 'small' }, `${d.label} · ${d.form}`),
              h('div', { class: 'muted small' }, `${listShort(d.list_type)} · ${fmtDateTime(d.created_at)}`)),
            d.voided_at ? h('span', { class: 'badge grey' }, 'Cancelled')
              : d.list_entry_id ? h('span', { class: 'badge amber' }, 'On a list')
              : d.expired_at ? h('span', { class: 'badge grey' }, 'Earlier term')
              : h('span', { class: 'badge' }, 'Waiting'))))
      : h('p', { class: 'empty' }, 'You have not recorded any demerits yet.'));
}

function renderAccount() {
  page('Account', { back: '#/', active: 'search' },
    h('div', { class: 'card' },
      h('div', { class: 'strong' }, me.display_name),
      h('div', { class: 'muted small' }, `${me.username} · ${me.role === 'admin' ? 'Admin' : 'Prefect'}`)),
    h('h2', { class: 'section-title' }, 'Change password'),
    h('div', { class: 'card' }, passwordForm(() => { toast('Password changed.'); go('#/'); })),
    logoutButton());
}

// ---- Lists ----

const STATUS = {
  draft: ['Draft', 'amber'],
  published: ['Register open', 'green'],
  closed: ['Closed', 'grey'],
};

const statusBadge = (list) =>
  list.status === 'published' && list.session_started_at
    ? h('span', { class: 'badge green' }, 'In session')
    : h('span', { class: `badge ${STATUS[list.status][1]}` }, STATUS[list.status][0]);

async function renderLists() {
  const token = renderToken;
  const opts = { active: 'lists' };
  loading('Lists', opts);
  let rows;
  try {
    rows = await api('/lists');
  } catch (err) {
    return failure('Lists', opts, err);
  }
  if (token !== renderToken) return;
  page('Lists', opts,
    me.role === 'admin' && h('button', { class: 'btn primary block', onclick: guarded(openNewList) }, 'Create a new list'),
    rows.length
      ? h('div', { class: 'card tight' }, rows.map((l) =>
          h('a', { class: 'result', href: `#/list/${l.id}` },
            h('div', { class: 'grow' },
              h('div', { class: 'name' }, l.type_name),
              h('div', { class: 'small' }, `${fmtDate(l.event_date, true)}${l.event_time ? ` · ${l.event_time}` : ''}`),
              h('div', { class: 'row wrap small muted' },
                statusBadge(l),
                `${l.entry_count} student${l.entry_count === 1 ? '' : 's'}`,
                l.on_duty ? h('span', { class: 'badge' }, 'You are on duty') : null,
                l.query_count > 0 && h('span', { class: 'badge red' }, `${l.query_count} quer${l.query_count === 1 ? 'y' : 'ies'}`))),
            h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))))
      : h('p', { class: 'empty' }, 'No lists yet.'));
}

function nextThursday() {
  const d = new Date();
  d.setDate(d.getDate() + (((4 - d.getDay() + 7) % 7) || 7));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function listFieldsForm(values) {
  return [
    field('Date', h('input', { name: 'eventDate', type: 'date', value: values.eventDate || '', required: true })),
    field('Time', h('input', { name: 'eventTime', value: values.eventTime || '' })),
    field('Heading', h('input', { name: 'title', value: values.title || '', required: true })),
    field('Instructions to students', h('textarea', { name: 'instructions', rows: 4, value: values.instructions || '' })),
  ];
}

const listBody = (data) => ({
  title: data.get('title'),
  eventDate: data.get('eventDate'),
  eventTime: data.get('eventTime'),
  instructions: data.get('instructions'),
});

async function openNewList() {
  const summary = await api('/admin/summary');
  sheet('Create a new list', (close) =>
    h('div', { class: 'stack' }, summary.previews.map((p) =>
      h('button', {
        class: 'btn block',
        onclick: guarded(async () => {
          close();
          if (p.existingDraftId) {
            toast(`There is already a draft ${p.type.name} list.`, true);
            go(`#/list/${p.existingDraftId}`);
          } else openCreateForm(p);
        }),
      }, `${p.type.name}: ${p.fromDemerits + p.carried} student${p.fromDemerits + p.carried === 1 ? '' : 's'} ready`))));
}

function openCreateForm(p) {
  const error = formError();
  const total = p.fromDemerits + p.carried;
  sheet(`New ${p.type.name} list`, (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        const { id } = await api('/admin/lists', { method: 'POST', body: { listType: p.key, ...listBody(data) } });
        close();
        go(`#/list/${id}`);
      }),
    },
    error,
    h('div', { class: 'notice' },
      `${total} ${total === 1 ? 'entry' : 'entries'} will be added: ${p.fromDemerits} from demerits and ${p.carried} no-show${p.carried === 1 ? '' : 's'} from earlier lists. `,
      `${p.waiting} demerit${p.waiting === 1 ? '' : 's'} will keep waiting because the student has not reached ${p.type.threshold}. Anything recorded after this goes on the next list.`),
    listFieldsForm({
      eventDate: p.key === 'dress' ? nextThursday() : '',
      eventTime: p.type.default_time,
      title: p.type.name.toUpperCase(),
      instructions: p.type.default_instructions,
    }),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Create draft'))
  );
}

function registerRow(entry, list, redraw, onMark) {
  const row = h('div', { class: `reg ${entry.query_note ? 'queried' : ''}` });
  const isAdmin = me.role === 'admin';
  const name = `${entry.first_name} ${entry.surname}`;

  function draw() {
    const set = (value) => () => {
      const previous = entry.attendance;
      entry.attendance = previous === value ? null : value;
      if (entry.attendance !== 'present') entry.late = false;
      draw();
      onMark(entry, entry.attendance, previous, draw);
    };
    row.replaceChildren(
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('a', { class: 'strong link-card reg-name', href: `#/student/${entry.student_id}` }, `${entry.surname}, ${entry.first_name}`),
          list.list_type === 'manual' && h('div', { class: 'small muted' }, `${entry.reason} · ${entry.reported_by}`),
          h('div', { class: 'row wrap' },
            entry.carried && h('span', { class: 'badge amber' }, 'Missed last time'),
            entry.late && h('span', { class: 'badge amber' }, `Late, marked ${fmtTime(entry.marked_at)}`),
            list.status === 'closed' && entry.attendance === 'present' && h('span', { class: 'badge green' }, 'Present'),
            list.status === 'closed' && entry.attendance === 'absent' && h('span', { class: 'badge red' }, 'No-show'))),
        list.status === 'published' && h('div', { class: 'marks' },
          h('button', {
            type: 'button',
            class: `mark mark-present ${entry.attendance === 'present' ? 'on' : ''}`,
            'aria-label': `${name} present`,
            'aria-pressed': String(entry.attendance === 'present'),
            onclick: set('present'),
          }, '✓'),
          h('button', {
            type: 'button',
            class: `mark mark-absent ${entry.attendance === 'absent' ? 'on' : ''}`,
            'aria-label': `${name} absent`,
            'aria-pressed': String(entry.attendance === 'absent'),
            onclick: set('absent'),
          }, '✕')),
        list.status !== 'closed' || isAdmin
          ? h('button', { class: 'btn small', onclick: () => (isAdmin ? openEntryAdmin(entry, redraw) : openQuery(entry, redraw)) }, isAdmin ? 'Manage' : 'Query')
          : null),
      ...(entry.query_note ? [h('div', { class: 'notice small' }, `Query${entry.query_by_name ? ` from ${entry.query_by_name}` : ''}: ${entry.query_note}`)] : [])
    );
  }
  draw();
  return row;
}

function openQuery(entry, redraw) {
  const error = formError();
  sheet(`Query ${entry.first_name} ${entry.surname}`, (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        await api(`/entries/${entry.id}/query`, { method: 'POST', body: { note: data.get('note') } });
        close();
        toast('Sent to the admins.');
        redraw();
      }),
    },
    error,
    h('p', {}, 'Is this student on the list by mistake? Tell the admins here. They would rather hear it from you than from the student.'),
    field('What is wrong?', h('textarea', { name: 'note', required: true, maxlength: 500, value: entry.query_note || '' })),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Send query'))
  );
}

async function openEntryAdmin(entry, redraw) {
  const demerits = await api(`/admin/entries/${entry.id}/demerits`).catch((err) => {
    toast(err.message, true);
    return null;
  });
  if (!demerits) return;
  const error = formError();
  sheet(`${entry.first_name} ${entry.surname}`, (close) => [
    h('div', { class: 'card tight' }, demerits.length
      ? demerits.map((d) => h('div', { class: 'item' },
          h('div', { class: 'grow' },
            h('div', { class: 'strong' }, d.label),
            h('div', { class: 'small muted' }, `${fmtDateTime(d.created_at)} · recorded by ${d.created_by_name}${d.reported_by ? ` for ${d.reported_by}` : ''}`),
            d.note && h('div', { class: 'small' }, d.note))))
      : h('div', { class: 'item muted' }, entry.carried ? `Carried over: ${entry.reason}` : entry.reason)),
    entry.query_note && h('div', { class: 'stack' },
      h('div', { class: 'notice' }, `Query${entry.query_by_name ? ` from ${entry.query_by_name}` : ''}: ${entry.query_note}`),
      h('button', {
        class: 'btn block',
        onclick: guarded(async () => {
          await api(`/admin/entries/${entry.id}/query/dismiss`, { method: 'POST', body: {} });
          close();
          toast('Query dismissed. The student stays on the list.');
          redraw();
        }),
      }, 'Dismiss query, keep on list')),
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        const keepDemeritIds = demerits.filter((d) => data.get(`keep-${d.id}`) === 'on').map((d) => d.id);
        await api(`/admin/entries/${entry.id}/remove`, { method: 'POST', body: { reason: data.get('reason'), keepDemeritIds } });
        close();
        toast('Removed from the list.');
        redraw();
      }),
    },
    h('h3', { class: 'section-title' }, 'Remove from this list'),
    error,
    field('Reason', h('input', { name: 'reason', required: true, maxlength: 300, placeholder: 'e.g. Misunderstanding' })),
    demerits.length > 0 && h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, 'Removing cancels the demerits. Tick any that were correct, to keep them counting towards the next list.'),
      demerits.map((d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `keep-${d.id}` }), h('span', {}, `Keep ${d.label}`)))),
    h('button', { class: 'btn danger block', type: 'submit' }, 'Remove from list')),
  ]);
}

function openEditList(list, redraw) {
  const error = formError();
  sheet('Edit list details', (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        await api(`/admin/lists/${list.id}`, { method: 'PATCH', body: listBody(data) });
        close();
        redraw();
      }),
    },
    error,
    listFieldsForm({ eventDate: list.event_date, eventTime: list.event_time, title: list.title, instructions: list.instructions }),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Save'))
  );
}

function adminListActions(list, entries, redraw) {
  const post = (path) => api(`/admin/lists/${list.id}${path}`, { method: 'POST', body: {} });
  const download = h('a', { class: 'btn', href: `api/admin/lists/${list.id}/export.docx` }, 'Download Word');
  const edit = h('button', { class: 'btn', onclick: () => openEditList(list, redraw) }, 'Edit details');
  if (list.status === 'draft') {
    return [
      h('button', {
        class: 'btn primary block',
        onclick: guarded(async () => {
          const yes = await confirmSheet({
            title: 'Publish this list?',
            message: `${entries.length} students. The register opens so prefects can mark attendance.`,
            action: 'Publish',
          });
          if (!yes) return;
          await post('/publish');
          toast('List published.');
          redraw();
        }),
      }, 'Publish list'),
      h('div', { class: 'row wrap' }, download, edit,
        h('button', {
          class: 'btn subtle-danger',
          onclick: guarded(async () => {
            const yes = await confirmSheet({
              title: 'Discard this draft?',
              message: 'The list is deleted. Its demerits go back to waiting, so nothing is lost.',
              action: 'Discard draft',
              danger: true,
            });
            if (!yes) return;
            await api(`/admin/lists/${list.id}`, { method: 'DELETE' });
            toast('Draft discarded.');
            go('#/lists');
          }),
        }, 'Discard')),
    ];
  }
  if (list.status === 'published') {
    return [
      h('div', { class: 'row wrap' }, download, edit),
    ];
  }
  return [
    h('div', { class: 'row wrap' }, download,
      h('button', {
        class: 'btn',
        onclick: guarded(async () => {
          await post('/reopen');
          toast('Register reopened.');
          redraw();
        }),
      }, 'Reopen register')),
  ];
}

// Registers opened again during their session, so a redraw does not fold them away.
const expandedRegisters = new Set();

const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

const FACE_CENTRE = 100;
const FACE_RADIUS = 88;

function facePoint(angle, radius) {
  const a = (angle * Math.PI) / 180;
  return { x: FACE_CENTRE + radius * Math.sin(a), y: FACE_CENTRE - radius * Math.cos(a) };
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const minuteAngle = (d) => ((d.getMinutes() + d.getSeconds() / 60) / 60) * 360;
const hourAngle = (d) => (((d.getHours() % 12) + d.getMinutes() / 60) / 12) * 360;

// A plain clock face. For the first hour the part the minute hand has swept since
// the start is shaded; after that a sweep would overlap itself, so the shading goes.
function clockFace(started) {
  const hand = (width, colour) => svgEl('line', { x1: FACE_CENTRE, y1: FACE_CENTRE, stroke: colour, 'stroke-width': width, 'stroke-linecap': 'round' });
  const spent = svgEl('path', { fill: '#123f7a', 'fill-opacity': '.8' });
  const hourHand = hand(6, '#111827');
  const minuteHand = hand(4, '#0ea5e9');
  const svg = svgEl('svg', { class: 'clock-face', viewBox: '0 0 200 200', 'aria-hidden': 'true' });
  svg.append(
    svgEl('circle', { cx: FACE_CENTRE, cy: FACE_CENTRE, r: FACE_RADIUS + 6, fill: '#fff', stroke: '#d1d5db', 'stroke-width': 2 }),
    spent,
    ...Array.from({ length: 12 }, (_, i) => {
      const outer = facePoint(i * 30, FACE_RADIUS + 2);
      const inner = facePoint(i * 30, i % 3 === 0 ? FACE_RADIUS - 12 : FACE_RADIUS - 7);
      return svgEl('line', { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, stroke: '#6b7280', 'stroke-width': i % 3 === 0 ? 3 : 1.5, 'stroke-linecap': 'round' });
    }),
    hourHand,
    minuteHand,
    svgEl('circle', { cx: FACE_CENTRE, cy: FACE_CENTRE, r: 5, fill: '#111827' })
  );
  const pointHand = (line, angle, length) => {
    const tip = facePoint(angle, length);
    line.setAttribute('x2', tip.x);
    line.setAttribute('y2', tip.y);
  };
  function update(nowMs) {
    const now = new Date(nowMs);
    const sweep = ((nowMs - started) / 3600000) * 360;
    if (sweep > 0 && sweep < 360) {
      const from = minuteAngle(new Date(started));
      const a = facePoint(from, FACE_RADIUS);
      const b = facePoint(from + sweep, FACE_RADIUS);
      spent.setAttribute('d', `M ${FACE_CENTRE} ${FACE_CENTRE} L ${a.x} ${a.y} A ${FACE_RADIUS} ${FACE_RADIUS} 0 ${sweep > 180 ? 1 : 0} 1 ${b.x} ${b.y} Z`);
    } else {
      spent.removeAttribute('d');
    }
    pointHand(hourHand, hourAngle(now), FACE_RADIUS * 0.5);
    pointHand(minuteHand, minuteAngle(now), FACE_RADIUS * 0.85);
  }
  return { svg, update };
}

function sessionClock(list, serverNow) {
  const started = Date.parse(list.session_started_at);
  // Uses the server's time, because a phone's clock can be wrong.
  const offset = Date.parse(serverNow) - Date.now();
  const time = h('div', { class: 'clock-time', role: 'timer', 'aria-label': 'Time in session' });
  const face = clockFace(started);
  const tick = () => {
    time.textContent = fmtDuration(Date.now() + offset - started);
    face.update(Date.now() + offset);
  };
  tick();
  const timer = setInterval(() => {
    if (time.isConnected) tick();
    else clearInterval(timer);
  }, 1000);
  return h('div', { class: 'session' },
    h('div', { class: 'session-label' }, `${list.type_name} is now in session`),
    face.svg,
    time,
    list.event_time && h('div', { class: 'small' }, `Scheduled ${list.event_time}`));
}

function openDutySheet(list, duty, redraw) {
  return guarded(async () => {
    const candidates = await api('/admin/duty-candidates');
    const onDuty = new Set(duty.map((d) => d.id));
    const error = formError();
    sheet(`Who is on duty for ${list.type_name}?`, (close) =>
      h('form', {
        class: 'stack',
        onsubmit: submitter(error, async (data) => {
          const userIds = candidates.filter((c) => data.get(`duty-${c.id}`) === 'on').map((c) => c.id);
          await api(`/admin/lists/${list.id}/duty`, { method: 'PUT', body: { userIds } });
          close();
          toast('Duty saved.');
          redraw();
        }),
      },
      error,
      candidates.map((c) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: `duty-${c.id}`, checked: onDuty.has(c.id) }),
        h('span', {}, c.display_name))),
      h('button', { class: 'btn primary block', type: 'submit' }, 'Save')));
  });
}

async function renderList(id) {
  const token = renderToken;
  const opts = { back: '#/lists', active: 'lists' };
  loading('List', opts);
  let data;
  try {
    data = await api(`/lists/${id}`);
  } catch (err) {
    return failure('List', opts, err);
  }
  if (token !== renderToken) return;
  const { list, entries, duty, server_now: serverNow } = data;
  const redraw = () => renderList(id);
  const isAdmin = me.role === 'admin';
  const open = list.status === 'published';
  const inSession = Boolean(list.session_started_at);

  // Every tap saves straight away, one at a time and in order.
  const saveState = h('p', { class: 'small muted save-state', role: 'status' }, 'Ticks and crosses save automatically.');
  let saving = Promise.resolve();
  let toldOffDuty = false;
  const onMark = (entry, attendance, previous, drawRow) => {
    saveState.textContent = 'Saving…';
    saving = saving.then(async () => {
      try {
        const result = await api(`/lists/${id}/register`, { method: 'POST', body: { marks: [{ entryId: entry.id, attendance }] } });
        const saved = result.entries.find((e) => e.id === entry.id);
        if (saved && entry.attendance === attendance) {
          entry.marked_at = saved.marked_at;
          entry.late = saved.late;
          drawRow();
        }
        if (result.alerted && !toldOffDuty) {
          toldOffDuty = true;
          toast('Saved. The admins have been told, as you are not on duty.');
        }
        saveState.textContent = 'All changes saved.';
      } catch (err) {
        if (entry.attendance === attendance) {
          entry.attendance = previous;
          drawRow();
        }
        saveState.textContent = 'That last change was not saved.';
        toast(`Not saved: ${err.message}`, true);
      }
    });
  };

  const body = h('div', { class: 'stack' });
  function drawEntries(filter) {
    const q = filter.trim().toLowerCase();
    const shown = entries.filter((e) => !q || `${e.first_name} ${e.surname} ${e.form}`.toLowerCase().includes(q));
    const groups = [];
    for (const e of shown) {
      if (!groups.length || groups[groups.length - 1].form !== e.form) groups.push({ form: e.form, rows: [] });
      groups[groups.length - 1].rows.push(e);
    }
    body.replaceChildren(
      shown.length
        ? h('div', { class: 'card tight' }, groups.map((g) => [
            h('div', { class: 'form-head' }, g.form),
            g.rows.map((e) => registerRow(e, list, redraw, onMark)),
          ]))
        : h('p', { class: 'empty' }, entries.length ? 'Nobody matches that search.' : 'Nobody is on this list.')
    );
  }
  drawEntries('');

  const names = h('div', { class: 'stack' },
    entries.length > 8 && h('input', {
      type: 'search',
      placeholder: 'Find on this list…',
      'aria-label': 'Find on this list',
      oninput: debounce((e) => drawEntries(e.target.value), 100),
    }),
    body,
    open && !isAdmin && !list.on_duty && h('p', { class: 'notice' }, 'You are not on duty for this list. You can still mark the register, but the admins will be told.'),
    open && saveState);

  // The names fold away once the session starts, and can be opened to make changes.
  const collapsible = open && inSession;
  const toggle = h('button', { class: 'btn block register-toggle', type: 'button' });
  const drawToggle = () => {
    const expanded = expandedRegisters.has(String(id));
    names.hidden = collapsible && !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? 'Hide names' : 'Open register to make changes';
  };
  toggle.addEventListener('click', () => {
    const key = String(id);
    if (expandedRegisters.has(key)) expandedRegisters.delete(key);
    else expandedRegisters.add(key);
    drawToggle();
  });
  drawToggle();

  const lasted = list.status === 'closed' && inSession && list.closed_at
    ? fmtDuration(Date.parse(list.closed_at) - Date.parse(list.session_started_at))
    : null;

  page(list.type_name, opts,
    open && inSession && sessionClock(list, serverNow),
    h('div', { class: 'card stack' },
      h('div', { class: 'row wrap' },
        statusBadge(list),
        list.on_duty ? h('span', { class: 'badge' }, 'You are on duty') : null,
        !open && h('span', { class: 'small muted' }, `${entries.length} student${entries.length === 1 ? '' : 's'}`)),
      h('div', { class: 'strong' }, `${fmtDate(list.event_date, true)}${list.event_time ? ` · ${list.event_time}` : ''}`),
      list.instructions && h('p', { class: 'small' }, list.instructions),
      lasted && h('p', { class: 'small muted' }, `Session lasted ${lasted}.`),
      list.status === 'draft' && !isAdmin && h('p', { class: 'notice' }, 'Not sent out yet. Please check the names and use Query if anyone is wrong.'),
      h('div', { class: 'row duty-row' },
        h('div', { class: 'grow small' },
          h('span', { class: 'strong' }, 'On duty: '),
          duty.length ? duty.map((d) => d.display_name).join(', ') : 'Nobody assigned yet'),
        isAdmin && list.status !== 'closed' && h('button', { class: 'btn small', onclick: openDutySheet(list, duty, redraw) }, 'Assign'))),
    isAdmin && adminListActions(list, entries, redraw),
    collapsible && toggle,
    names,
    open && !inSession && h('button', {
      class: 'btn primary block start-session',
      onclick: guarded(async () => {
        await saving;
        const result = await api(`/lists/${id}/start`, { method: 'POST', body: {} });
        expandedRegisters.delete(String(id));
        if (result.alerted) toast('Session started. The admins have been told, as you are not on duty.');
        redraw();
      }),
    }, 'Start session'),
    open && !inSession && h('p', { class: 'small muted' }, 'This starts the clock and folds the names away. You can open them again to make changes.'),
    open && (isAdmin || Boolean(list.on_duty)) && h('button', {
      class: 'btn block',
      onclick: guarded(async () => {
        await saving;
        const unmarked = entries.filter((e) => !e.attendance).length;
        const action = inSession ? 'End session' : 'Close register';
        const yes = await confirmSheet({
          title: `${action}?`,
          message: `${unmarked ? `${unmarked} student${unmarked === 1 ? ' is' : 's are'} not marked and will count as no-shows. ` : ''}No-shows go on the next ${list.type_name} list.`,
          action,
        });
        if (!yes) return;
        await api(`/lists/${id}/close`, { method: 'POST', body: {} });
        toast(inSession ? 'Session ended.' : 'Register closed.');
        redraw();
      }),
    }, inSession ? 'End session' : 'Close register'));
}

// ---- Admin hub ----

async function renderAdmin() {
  const token = renderToken;
  const opts = { active: 'admin' };
  if (me.role !== 'admin') return go('#/');
  loading('Admin', opts);
  let summary;
  try {
    summary = await api('/admin/summary');
  } catch (err) {
    return failure('Admin', opts, err);
  }
  if (token !== renderToken) return;
  const tile = (href, title, detail) =>
    h('a', { class: 'result', href },
      h('div', { class: 'grow' }, h('div', { class: 'name' }, title), h('div', { class: 'small muted' }, detail)),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
  page('Admin', opts,
    summary.hasDummy && h('div', { class: 'notice' }, 'Test data is loaded. Remove it from Students once the real list is in.'),
    summary.queries.length > 0 && h('h2', { class: 'section-title' }, `Queries from prefects (${summary.queries.length})`),
    summary.queries.length > 0 && h('div', { class: 'card tight' }, summary.queries.map((q) =>
      h('a', { class: 'result', href: `#/list/${q.list_id}` },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, `${q.surname}, ${q.first_name} · ${q.form}`),
          h('div', { class: 'small' }, q.query_note),
          h('div', { class: 'small muted' }, `${q.title} · from ${q.query_by_name || 'unknown'}`)),
        h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')))),
    summary.alerts.length > 0 && h('h2', { class: 'section-title' }, `Register alerts (${summary.alerts.length})`),
    summary.alerts.length > 0 && h('div', { class: 'card tight' }, summary.alerts.map((a) =>
      h('div', { class: 'item' },
        h('a', { class: 'grow link-card', href: `#/list/${a.list_id}` },
          h('div', { class: 'strong' }, `${a.display_name} ${a.changes ? 'marked the register' : 'started the session'}`),
          h('div', { class: 'small' }, `${a.type_name}, ${fmtDate(a.event_date)}. Not on duty.${a.changes ? ` ${a.changes} change${a.changes === 1 ? '' : 's'}.` : ''}`),
          h('div', { class: 'small muted' }, fmtDateTime(a.created_at))),
        h('button', {
          class: 'btn small',
          onclick: guarded(async () => {
            await api(`/admin/alerts/${a.id}/dismiss`, { method: 'POST', body: {} });
            renderAdmin();
          }),
        }, 'Dismiss')))),
    h('h2', { class: 'section-title' }, 'Ready for the next list'),
    h('div', { class: 'tallies' }, summary.previews.map((p) =>
      h('div', { class: 'tally' },
        h('div', { class: 'small strong' }, p.type.name),
        h('div', { class: 'num' }, String(p.fromDemerits + p.carried)),
        h('div', { class: 'state' }, `${p.waiting} demerit${p.waiting === 1 ? '' : 's'} waiting`)))),
    h('button', { class: 'btn primary block', onclick: guarded(openNewList) }, 'Create a new list'),
    h('h2', { class: 'section-title' }, 'Term'),
    termCard(summary.term),
    h('h2', { class: 'section-title' }, 'Manage'),
    h('div', { class: 'card tight' },
      tile('#/admin/demerit-types', 'Demerit types', 'What prefects can choose, and list settings'),
      tile('#/admin/students', 'Students', 'Search, add, or import the student list'),
      tile('#/admin/users', 'Prefects and admins', 'Accounts and passwords'),
      tile('#/admin/log', 'All demerits', 'Full record, who recorded what, CSV export')));
}

function termCard(term) {
  const { latest, leftover } = term;
  const canUndo = latest && !latest.undone_at;
  return h('div', { class: 'card stack' },
    h('p', { class: 'small' }, `Starting a new term resets ${leftover} waiting demerit${leftover === 1 ? '' : 's'} to zero. They stay in each student's history.`),
    canUndo && h('p', { class: 'small muted' },
      `Last started ${fmtDate(latest.started_at, true)}${latest.started_by_name ? ` by ${latest.started_by_name}` : ''}, resetting ${latest.demerits_cleared}.`),
    h('button', {
      class: 'btn block',
      onclick: guarded(async () => {
        const yes = await confirmSheet({
          title: 'Start a new term?',
          message: `${leftover} waiting demerit${leftover === 1 ? '' : 's'} will stop counting, so those students start again from zero.\n\nStudents who already reached the limit, and no-shows, still go on the next list.`,
          action: 'Start new term',
          danger: true,
        });
        if (!yes) return;
        const { cleared } = await api('/admin/term/start', { method: 'POST', body: {} });
        toast(`New term started. ${cleared} demerit${cleared === 1 ? '' : 's'} reset.`);
        renderAdmin();
      }),
    }, 'Start new term'),
    canUndo && h('button', {
      class: 'btn block',
      onclick: guarded(async () => {
        const yes = await confirmSheet({
          title: 'Undo the new term?',
          message: `The ${latest.demerits_cleared} demerit${latest.demerits_cleared === 1 ? '' : 's'} reset on ${fmtDate(latest.started_at)} will count again. Demerits recorded since then are not affected.`,
          action: 'Undo new term',
        });
        if (!yes) return;
        await api('/admin/term/undo', { method: 'POST', body: {} });
        toast('New term undone.');
        renderAdmin();
      }),
    }, 'Undo last new term'));
}

// ---- Admin: demerit types ----

async function renderDemeritTypes() {
  const token = renderToken;
  const opts = { back: '#/admin', active: 'admin' };
  loading('Demerit types', opts);
  let data;
  try {
    data = await api('/admin/settings');
  } catch (err) {
    return failure('Demerit types', opts, err);
  }
  if (token !== renderToken) return;
  const redraw = () => renderDemeritTypes();
  page('Demerit types', opts, data.types.map((t) => [
    h('h2', { class: 'section-title' }, t.name),
    h('div', { class: 'card tight' }, data.offences.filter((o) => o.list_type === t.key).map((o) =>
      h('button', { class: 'offence', type: 'button', onclick: () => openOffence(t, o, redraw) },
        h('span', { class: o.active ? 'grow' : 'grow cancelled' }, o.name),
        o.class && h('span', { class: `badge ${o.class === 'C1' ? 'red' : ''}` }, o.class),
        o.straight_to_list ? h('span', { class: 'badge red' }, 'Straight to list') : null,
        !o.active && h('span', { class: 'badge grey' }, 'Hidden')))),
    h('div', { class: 'row' },
      h('button', { class: 'btn grow', onclick: () => openOffence(t, null, redraw) }, 'Add demerit type'),
      h('button', { class: 'btn grow', onclick: () => openListType(t, redraw) }, 'List settings')),
    h('p', { class: 'small muted' }, `${t.threshold} demerits put a student on this list.`),
  ]));
}

function openOffence(type, offence, redraw) {
  const error = formError();
  sheet(offence ? 'Edit demerit type' : `New ${type.name} demerit`, (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        const body = {
          name: data.get('name'),
          class: data.get('class'),
          straightToList: data.get('straight') === 'on',
          active: offence ? data.get('active') === 'on' : true,
          listType: type.key,
        };
        if (offence) await api(`/admin/offences/${offence.id}`, { method: 'PATCH', body });
        else await api('/admin/offences', { method: 'POST', body });
        close();
        redraw();
      }),
    },
    error,
    field('Name', h('input', { name: 'name', required: true, maxlength: 100, value: offence?.name || '' })),
    field('Class', h('select', { name: 'class' },
      [['', 'None'], ['C2', 'C2'], ['C1', 'C1']].map(([value, label]) =>
        h('option', { value, selected: (offence?.class || '') === value ? 'selected' : null }, label)))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'straight', checked: Boolean(offence?.straight_to_list) }),
      h('span', {}, `Serious: goes straight on the list, without waiting for ${type.threshold} demerits`)),
    offence && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(offence.active) }),
      h('span', {}, 'Prefects can choose this')),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Save'))
  );
}

function openListType(type, redraw) {
  const error = formError();
  sheet(`${type.name} settings`, (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        await api(`/admin/list-types/${type.key}`, {
          method: 'PATCH',
          body: { threshold: Number(data.get('threshold')), defaultTime: data.get('time'), defaultInstructions: data.get('instructions') },
        });
        close();
        redraw();
      }),
    },
    error,
    field('Demerits needed to go on the list', h('input', { name: 'threshold', type: 'number', inputmode: 'numeric', min: 1, max: 20, value: type.threshold, required: true })),
    field('Usual time', h('input', { name: 'time', value: type.default_time })),
    field('Usual instructions to students', h('textarea', { name: 'instructions', rows: 5, value: type.default_instructions })),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Save'))
  );
}

// ---- Admin: students ----

async function renderAdminStudents() {
  const token = renderToken;
  const opts = { back: '#/admin', active: 'admin' };
  loading('Students', opts);
  let data;
  try {
    data = await api('/admin/students?q=');
  } catch (err) {
    return failure('Students', opts, err);
  }
  if (token !== renderToken) return;
  const redraw = () => renderAdminStudents();
  const results = h('div', {});
  const search = debounce(async (value) => {
    const found = await api(`/admin/students?q=${encodeURIComponent(value)}`).catch((err) => {
      toast(err.message, true);
      return { results: [] };
    });
    results.replaceChildren(found.results.length
      ? h('div', { class: 'card tight' }, found.results.map((s) =>
          h('button', { class: 'result', type: 'button', onclick: () => openStudentForm(s, redraw) },
            h('div', { class: 'grow' }, h('div', { class: 'name' }, `${s.surname}, ${s.first_name}`), h('div', { class: 'small muted' }, `${s.form}${s.student_no ? ` · ${s.student_no}` : ''}`)),
            h('span', { class: 'small muted' }, 'Edit'))))
      : value.trim() ? h('p', { class: 'empty' }, 'No student found.') : '');
  }, 140);

  page('Students', opts,
    h('p', { class: 'muted small' }, `${data.counts.active} active students${data.counts.dummy ? `, ${data.counts.dummy} of them test data` : ''}.`),
    h('div', { class: 'row' },
      h('button', { class: 'btn grow', onclick: () => openImport(redraw) }, 'Import CSV'),
      h('button', { class: 'btn grow', onclick: () => openStudentForm(null, redraw) }, 'Add student')),
    h('input', { type: 'search', placeholder: 'Search students to edit…', 'aria-label': 'Search students', oninput: (e) => search(e.target.value) }),
    results,
    h('p', { class: 'small muted' }, 'To retire a student, edit them and untick “Active”. Their history is kept.'),
    data.counts.dummy > 0 && h('button', { class: 'btn subtle-danger block', onclick: () => openRemoveDummy() }, 'Remove all test data'));
}

function openStudentForm(student, redraw) {
  const error = formError();
  sheet(student ? 'Edit student' : 'Add student', (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        const body = {
          firstName: data.get('firstName'),
          surname: data.get('surname'),
          form: data.get('form'),
          studentNo: data.get('studentNo'),
          active: student ? data.get('active') === 'on' : true,
        };
        if (student) await api(`/admin/students/${student.id}`, { method: 'PATCH', body });
        else await api('/admin/students', { method: 'POST', body });
        close();
        toast('Saved.');
        redraw();
      }),
    },
    error,
    field('First name', h('input', { name: 'firstName', required: true, value: student?.first_name || '' })),
    field('Surname', h('input', { name: 'surname', required: true, value: student?.surname || '' })),
    field('Form', h('input', { name: 'form', required: true, placeholder: 'e.g. 3 Plato', value: student?.form || '' })),
    field('Student number (optional)', h('input', { name: 'studentNo', value: student?.student_no || '' })),
    student && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: true }), h('span', {}, 'Active')),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Save'))
  );
}

function openImport(redraw) {
  const error = formError();
  sheet('Import student list', (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        const file = data.get('file');
        if (!file || !file.size) throw new Error('Please choose a file.');
        if (/\.xlsx?$/i.test(file.name)) throw new Error('In Excel, use File > Save As > “CSV UTF-8”, then choose that file.');
        const result = await api('/admin/students/import', {
          method: 'POST',
          body: { csv: await file.text(), deactivateMissing: data.get('deactivate') === 'on' },
        });
        close();
        const skipped = result.skipped.length ? ` Skipped incomplete row${result.skipped.length === 1 ? '' : 's'}: ${result.skipped.join(', ')}.` : '';
        sheet('Import finished', () => [
          h('p', {}, `${result.added} added, ${result.updated} updated, ${result.deactivated} marked inactive.${skipped}`),
        ]);
        redraw();
      }),
    },
    error,
    h('p', { class: 'small' }, 'Use a CSV file with a heading row. It needs a Form column, and either Surname and First Name columns or a single Name column. A student number column is optional but helps next year.'),
    field('CSV file', h('input', { name: 'file', type: 'file', accept: '.csv,text/csv', required: true })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'deactivate' }),
      h('span', {}, 'Mark students who are not in this file as inactive (for a full list, such as a new school year)')),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Import'))
  );
}

function openRemoveDummy() {
  const error = formError();
  sheet('Remove all test data', (close) =>
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        const result = await api('/admin/remove-dummy-data', { method: 'POST', body: { confirm: data.get('confirm') } });
        close();
        toast(`Removed ${result.students} test students and ${result.prefects} test prefects.`);
        go('#/admin');
      }),
    },
    error,
    h('p', {}, 'This permanently deletes the test students, the Test Prefect accounts, and every demerit and list entry linked to them. Real students and accounts are kept.'),
    field('Type DELETE to confirm', h('input', { name: 'confirm', required: true, autocomplete: 'off' })),
    h('button', { class: 'btn danger block', type: 'submit' }, 'Delete test data'))
  );
}

// ---- Admin: accounts ----

function showTempPassword(user, password, isNew) {
  sheet(isNew ? 'First login password' : 'Temporary password', () => [
    h('p', {}, `Give this to ${user}. They will be asked to choose their own password when they log in.${isNew ? '' : ' It will not be shown again.'}`),
    h('div', { class: 'temp-password' }, password),
  ]);
}

async function renderUsers() {
  const token = renderToken;
  const opts = { back: '#/admin', active: 'admin' };
  loading('Prefects and admins', opts);
  let users;
  try {
    users = await api('/admin/users');
  } catch (err) {
    return failure('Prefects and admins', opts, err);
  }
  if (token !== renderToken) return;
  const redraw = () => renderUsers();
  const activePrefects = users.filter((u) => u.role === 'prefect' && u.active).length;
  page('Prefects and admins', opts,
    h('p', { class: 'small muted' }, `${activePrefects} active prefects.`),
    h('button', { class: 'btn primary block', onclick: () => openUserForm(null, redraw) }, 'Add account'),
    h('div', { class: 'card tight' }, users.map((u) =>
      h('button', { class: 'result', type: 'button', onclick: () => openUserForm(u, redraw) },
        h('div', { class: 'grow' },
          h('div', { class: u.active ? 'name' : 'name cancelled' }, u.display_name),
          h('div', { class: 'small muted' }, `${u.username} · ${u.demerit_count} demerit${u.demerit_count === 1 ? '' : 's'}${u.last_demerit_at ? ` · last ${fmtDateTime(u.last_demerit_at)}` : ''}`)),
        u.role === 'admin' && h('span', { class: 'badge' }, 'Admin'),
        !u.active && h('span', { class: 'badge grey' }, 'Inactive')))));
}

function openUserForm(user, redraw) {
  const error = formError();
  sheet(user ? user.display_name : 'Add account', (close) => [
    h('form', {
      class: 'stack',
      onsubmit: submitter(error, async (data) => {
        const body = {
          displayName: data.get('displayName'),
          role: data.get('role'),
          active: user ? data.get('active') === 'on' : true,
        };
        if (user) {
          await api(`/admin/users/${user.id}`, { method: 'PATCH', body });
          close();
          toast('Saved.');
        } else {
          const result = await api('/admin/users', { method: 'POST', body: { ...body, username: data.get('username') } });
          close();
          showTempPassword(body.displayName, result.tempPassword, true);
        }
        redraw();
      }),
    },
    error,
    field('Name', h('input', { name: 'displayName', required: true, value: user?.display_name || '' })),
    !user && field('Username', h('input', { name: 'username', required: true, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' })),
    field('Role', h('select', { name: 'role' }, [['prefect', 'Prefect'], ['admin', 'Admin']].map(([value, label]) =>
      h('option', { value, selected: (user?.role || 'prefect') === value ? 'selected' : null }, label)))),
    user && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(user.active) }),
      h('span', {}, 'Active (untick when a prefect steps down; their records are kept)')),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Save')),
    user && h('button', {
      class: 'btn block',
      onclick: guarded(async () => {
        const result = await api(`/admin/users/${user.id}/reset-password`, { method: 'POST', body: {} });
        close();
        showTempPassword(user.display_name, result.tempPassword);
      }),
    }, 'Reset password'),
    user && user.demerit_count > 0 && h('a', { class: 'btn block', href: `#/admin/log?prefect=${user.id}`, onclick: close }, 'See their demerits'),
  ]);
}

// ---- Admin: demerit log ----

async function renderLog(params) {
  const opts = { back: '#/admin', active: 'admin' };
  const filters = { type: '', status: '', q: '', prefect: params.get('prefect') || '' };
  const results = h('div', {});
  const queryString = () => new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const csv = h('a', { class: 'btn block', href: 'api/admin/demerits.csv' }, 'Download as CSV');
  let token = 0;

  async function load() {
    const mine = ++token;
    const qs = queryString();
    csv.href = `api/admin/demerits.csv${qs ? `?${qs}` : ''}`;
    try {
      const rows = await api(`/admin/demerits${qs ? `?${qs}` : ''}`);
      if (mine !== token) return;
      results.replaceChildren(rows.length
        ? h('div', { class: 'card tight' }, rows.map((d) =>
            h('a', { class: 'result', href: `#/student/${d.student_id}` },
              h('div', { class: 'grow' },
                h('div', { class: d.voided_at ? 'name cancelled' : 'name' }, `${d.surname}, ${d.first_name} · ${d.form}`),
                h('div', { class: 'small' }, d.label),
                h('div', { class: 'small muted' }, `${fmtDateTime(d.created_at)} · ${d.created_by_name}${d.reported_by ? ` for ${d.reported_by}` : ''}`),
                d.note && h('div', { class: 'small' }, d.note)),
              h('span', { class: `badge ${d.voided_at || (d.expired_at && !d.list_entry_id) ? 'grey' : d.list_entry_id ? 'amber' : ''}` },
                d.voided_at ? 'Cancelled' : d.list_entry_id ? 'On a list' : d.expired_at ? 'Earlier term' : 'Waiting'))))
        : h('p', { class: 'empty' }, 'No demerits match.'));
    } catch (err) {
      results.replaceChildren(h('div', { class: 'error' }, err.message));
    }
  }

  const choose = (key, label, options) =>
    h('select', { 'aria-label': label, onchange: (e) => { filters[key] = e.target.value; load(); } },
      options.map(([value, text]) => h('option', { value }, text)));

  page('All demerits', opts,
    h('input', {
      type: 'search',
      placeholder: 'Student, prefect or demerit…',
      'aria-label': 'Search demerits',
      oninput: debounce((e) => { filters.q = e.target.value; load(); }, 200),
    }),
    h('div', { class: 'tallies' },
      choose('type', 'List', [['', 'Both lists'], ['dress', 'Dress Parade'], ['manual', 'Manual Labour']]),
      choose('status', 'Status', [['', 'Any status'], ['waiting', 'Waiting'], ['listed', 'On a list'], ['earlier', 'Earlier term'], ['cancelled', 'Cancelled']])),
    filters.prefect && h('a', { class: 'btn small', href: '#/admin/log' }, 'Showing one prefect. Show everyone'),
    csv,
    results,
    h('p', { class: 'small muted' }, 'Shows the latest 300. The CSV has everything.'));
  load();
}

// ---- Routing ----

function route() {
  renderToken += 1;
  document.querySelectorAll('dialog.sheet').forEach((d) => d.close());
  if (!me) return renderLogin();
  if (me.must_change_password) return renderForcePassword();

  const [path, queryString] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(queryString || '');
  const parts = path.split('/').filter(Boolean);
  const [first, second] = parts;

  if (!first) return renderSearch();
  if (first === 'bulk') return renderBulk();
  if (first === 'student' && second) return renderStudent(second);
  if (first === 'lists') return renderLists();
  if (first === 'list' && second) return renderList(second);
  if (first === 'mine') return renderMine();
  if (first === 'account') return renderAccount();
  if (first === 'admin' && me.role === 'admin') {
    if (!second) return renderAdmin();
    if (second === 'demerit-types') return renderDemeritTypes();
    if (second === 'students') return renderAdminStudents();
    if (second === 'users') return renderUsers();
    if (second === 'log') return renderLog(params);
  }
  return go('#/');
}

window.addEventListener('hashchange', route);

(async function start() {
  try {
    me = await api('/me');
  } catch {
    me = null;
  }
  route();
})();
