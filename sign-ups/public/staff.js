// Staff screens: progress, club and sport lists, downloads and setup.
let staffName = null;

const GROUP_TITLES = { primary: 'Primary sports', sport: 'Other sports', club: 'Clubs', extra: 'Extras and applications' };
const genderWord = (g) => (g === 'F' ? 'Girls' : g === 'M' ? 'Boys' : 'All');
const optionLabel = (o) => (o.category === 'sport' ? `${genderWord(o.gender)} ${o.name}` : o.name);
const formatTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const sessionText = (s) => (s ? s.split(',').join(' & ') : '');

function setActiveTab(tab) {
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.dataset.tab === tab);
  }
}

// ---- Login -------------------------------------------------------------------
function viewLogin() {
  document.getElementById('nav').hidden = true;
  document.getElementById('logout').hidden = true;
  render(`
    <form id="login" class="card narrow">
      <h1>Staff sign in</h1>
      <label>Your name <input name="name" required autocomplete="name"></label>
      <label>Staff password <input name="password" type="password" required autocomplete="current-password"></label>
      <button class="button" type="submit">Sign in</button>
    </form>`);
  document.getElementById('login').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const me = await api('api/staff/login', { method: 'POST', body: Object.fromEntries(new FormData(event.target)) });
      staffName = me.name;
      route();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---- Progress ----------------------------------------------------------------
async function viewProgress() {
  const data = await api('api/staff/progress');
  const total = data.forms.reduce((n, f) => n + f.total, 0);
  const done = data.forms.reduce((n, f) => n + f.done, 0);
  render(`
    <div class="page-head">
      <div>
        <h1>Progress</h1>
        <p class="muted">${done} of ${total} students done. Registration is <strong>${data.open ? 'open' : 'closed'}</strong>.</p>
      </div>
      <button class="button ${data.open ? 'secondary' : ''}" id="toggle-open">${data.open ? 'Close registration' : 'Open registration'}</button>
    </div>
    <input id="student-search" class="search" type="search" placeholder="Search for a student" aria-label="Search for a student" autocomplete="off">
    <div id="search-results" hidden></div>
    <div id="class-lists">
      ${data.forms.map((form) => `
        <section class="card">
          <h2>${h(form.label)}</h2>
          <div class="tiles">
            ${form.classes.map((c) => `<a class="tile compact" href="#/class/${encodeURIComponent(c.class_name)}"><strong>${h(c.class_name)}</strong></a>`).join('')}
          </div>
        </section>`).join('')}
    </div>
  `);
  document.getElementById('toggle-open').addEventListener('click', async () => {
    await api('api/staff/settings', { method: 'PATCH', body: { registration_open: !data.open } });
    viewProgress();
  });

  const search = document.getElementById('student-search');
  const results = document.getElementById('search-results');
  const lists = document.getElementById('class-lists');
  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    results.hidden = q.length < 2;
    lists.hidden = q.length >= 2;
    if (q.length < 2) return;
    try {
      const found = await api(`api/staff/students/search?q=${encodeURIComponent(q)}`);
      if (search.value.trim() !== q) return;
      results.innerHTML = found.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Student</th><th>Class</th><th>Status</th></tr></thead>
            <tbody>
              ${found.map((s) => `
                <tr class="row-link" data-href="#/student/${s.id}" tabindex="0" role="link">
                  <td>${h(s.name)}</td>
                  <td>${h(s.className)}</td>
                  <td>${s.done ? '<span class="status ok">Done</span>' : `<span class="status ${s.started ? 'warn' : 'none'}">${s.started ? 'Incomplete' : 'Not started'}</span>`}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="muted card">No students found.</p>';
    } catch (err) {
      toast(err.message, 'error');
    }
  }));
}

async function viewClass(className) {
  const students = await api(`api/staff/classes/${encodeURIComponent(className)}`);
  const outstanding = students.filter((s) => !s.submittedAt);
  const draw = (onlyOutstanding) => {
    const list = onlyOutstanding ? outstanding : students;
    render(`
      <a class="back" href="#/">&larr; Progress</a>
      <div class="page-head">
        <div>
          <h1>${h(className)}</h1>
          <p class="muted">${students.length - outstanding.length} of ${students.length} done</p>
        </div>
        <button class="button secondary no-print" id="filter">${onlyOutstanding ? 'Show everyone' : `Show ${outstanding.length} not done`}</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Student</th><th>Status</th></tr></thead>
          <tbody>
            ${list.map((s) => `
              <tr class="row-link" data-href="#/student/${s.id}" tabindex="0" role="link">
                <td>${h(s.name)}${s.note ? `<br><span class="tag">${h(s.note)}</span>` : ''}</td>
                <td>${s.submittedAt
                  ? `<span class="status ok">Done</span><br><span class="muted small">${h(s.submittedBy)}</span>`
                  : `<span class="status ${s.choices.length ? 'warn' : 'none'}">${s.choices.length ? 'Incomplete' : 'Not started'}</span>${s.choices.length && s.missing.length ? `<br><span class="muted small">Needs ${h(s.missing.join(', '))}</span>` : ''}`}</td>
              </tr>`).join('') || '<tr><td colspan="2" class="muted">Everyone is done.</td></tr>'}
          </tbody>
        </table>
      </div>`);
    document.getElementById('filter').addEventListener('click', () => draw(!onlyOutstanding));
  };
  draw(false);
}

// ---- One student -------------------------------------------------------------
async function viewStudent(id) {
  const { student, options } = await api(`api/staff/students/${id}`);
  const picked = new Map(student.choices.map((c) => [c.id, new Set(c.sessions ? c.sessions.split(',') : [])]));
  const backHash = `#/class/${encodeURIComponent(student.className)}`;

  const optionRow = (o) => `
    <div class="check-row">
      <label>
        <input type="checkbox" data-opt="${o.id}" ${picked.has(o.id) ? 'checked' : ''}>
        <span>${h(o.category === 'sport' ? optionLabel(o) : o.name)}
          ${!o.eligible ? '<span class="tag">Not normally eligible</span>' : ''}
          ${o.unavailable ? `<span class="tag">${h(o.unavailable)}</span>` : ''}
          ${o.times?.length ? `<span class="times">${h(formatTimes(o.times))}</span>` : ''}
        </span>
      </label>
      ${o.sessions.length ? `<span class="inline-sessions" data-sessions-for="${o.id}">
        ${o.sessions.map((s) => `<label><input type="checkbox" data-session="${h(s)}" ${picked.get(o.id)?.has(s) ? 'checked' : ''}> ${h(s)}</label>`).join('')}
      </span>` : ''}
    </div>`;

  const status = student.submittedAt
    ? `Done, by ${h(student.submittedBy)}, ${h(formatTime(student.submittedAt))}`
    : student.missing.length ? `Not complete: needs ${h(student.missing.join(', '))}` : 'Not complete';

  render(`
    <a class="back" href="${backHash}">&larr; ${h(student.className)}</a>
    <div class="page-head">
      <div>
        <h1>${h(student.name)}</h1>
        <p class="muted">${h(student.className)} &middot; ${status}</p>
      </div>
      <div class="actions">
        ${student.submittedAt ? '<button class="button secondary" id="unlock">Let student choose again</button>' : ''}
        <button class="button" id="save">Save choices</button>
      </div>
    </div>
    <div id="clash-box"></div>
    <div class="columns">
      <section class="card" id="choice-list">
        ${['primary', 'sport', 'club', 'extra'].map((g) => {
          const list = options.filter((o) => o.group === g).sort((a, b) => a.name.localeCompare(b.name));
          const usual = list.filter((o) => o.eligible || picked.has(o.id));
          const others = list.filter((o) => !o.eligible && !picked.has(o.id));
          return `<h2>${GROUP_TITLES[g]}</h2>${usual.map(optionRow).join('')}
            ${others.length ? `<details class="others"><summary>Show ${others.length} not normally available to this student</summary>${others.map(optionRow).join('')}</details>` : ''}`;
        }).join('')}
      </section>
      <section class="card side">
        <h2>Student details</h2>
        <form id="details">
          <label>Name <input name="name" value="${h(student.name)}" required></label>
          <label>Class <input name="className" value="${h(student.className)}" required></label>
          <label>Gender
            <select name="gender">
              <option value="F" ${student.gender === 'F' ? 'selected' : ''}>Girl</option>
              <option value="M" ${student.gender === 'M' ? 'selected' : ''}>Boy</option>
            </select>
          </label>
          <label>Date of birth <input name="dob" type="date" value="${h(student.dob || '')}"></label>
          <label>Note for the spreadsheet <input name="note" value="${h(student.note)}" maxlength="200" placeholder="For example MED EXC"></label>
          <label class="inline"><input type="checkbox" name="sportExempt" ${student.sportExempt ? 'checked' : ''}> Exempt from the primary sport rule</label>
          <button class="button secondary" type="submit">Save details</button>
        </form>
        <hr>
        <button class="button danger" id="remove">${student.active ? 'Remove from class list' : 'Restore to class list'}</button>
        <p class="muted small">${student.active ? 'For students who have left. Their record is kept, and they no longer appear on any list.' : 'This student is currently hidden from all lists.'}</p>
      </section>
    </div>`);

  const readSelections = () => [...app.querySelectorAll('[data-opt]:checked')].map((box) => {
    const optionId = Number(box.dataset.opt);
    const group = app.querySelector(`[data-sessions-for="${optionId}"]`);
    const sessions = group ? [...group.querySelectorAll('[data-session]:checked')].map((s) => s.dataset.session) : [];
    return { optionId, sessions };
  });

  const showClashes = () => {
    const clashes = findClashes(readSelections().map(({ optionId, sessions }) => {
      const o = options.find((x) => x.id === optionId);
      return { name: o.category === 'sport' ? optionLabel(o) : o.name, times: o.times, sessions };
    }));
    document.getElementById('clash-box').innerHTML = clashes.length ? `
      <div class="clash-box">
        <strong>Timetable clashes</strong>
        ${clashes.map((c) => `<div>${h(describeClash(c))}</div>`).join('')}
      </div>` : '';
  };
  showClashes();
  document.getElementById('choice-list').addEventListener('change', showClashes);

  document.getElementById('save').addEventListener('click', async () => {
    const selections = readSelections();
    try {
      const saved = await api(`api/staff/students/${id}/selections`, { method: 'PUT', body: { selections } });
      toast(saved.submittedAt ? 'Saved.' : `Saved, but still needs ${saved.missing.join(', ')}.`, saved.submittedAt ? 'ok' : 'error');
      viewStudent(id);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('unlock')?.addEventListener('click', async () => {
    await api(`api/staff/students/${id}/unlock`, { method: 'POST' });
    toast('The student can now choose again.');
    viewStudent(id);
  });

  document.getElementById('details').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api(`api/staff/students/${id}`, {
        method: 'PATCH',
        body: {
          name: form.get('name'),
          className: form.get('className'),
          gender: form.get('gender'),
          dob: form.get('dob'),
          note: form.get('note'),
          sportExempt: form.get('sportExempt') === 'on',
        },
      });
      toast('Details saved.');
      viewStudent(id);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('remove').addEventListener('click', async () => {
    if (student.active) {
      const answer = await modal(`
        <h2>Remove ${h(student.name)}?</h2>
        <p>They will no longer appear on class, club or sport lists, or in exports. You can restore them from Setup.</p>
        <div class="row-end">
          <button class="button secondary" data-value="no">Keep</button>
          <button class="button danger" data-value="yes">Remove</button>
        </div>`);
      if (answer !== 'yes') return;
    }
    await api(`api/staff/students/${id}`, { method: 'PATCH', body: { active: !student.active } });
    toast(student.active ? 'Removed from the class list.' : 'Restored.');
    if (student.active) location.hash = backHash;
    else viewStudent(id);
  });
}

// ---- Club and sport lists ----------------------------------------------------
async function viewLists(optionId, form) {
  const [options, progress] = await Promise.all([api('api/staff/options'), api('api/staff/progress')]);
  const active = options.filter((o) => o.active);
  const forms = progress.forms.map((f) => f.label);
  const selected = optionId ? options.find((o) => o.id === Number(optionId)) : null;

  const picker = ['primary', 'sport', 'club', 'extra'].map((g) => {
    const list = active.filter((o) => o.group === g).sort((a, b) => optionLabel(a).localeCompare(optionLabel(b)));
    return `<optgroup label="${GROUP_TITLES[g]}">${list.map((o) => `
      <option value="${o.id}" ${selected?.id === o.id ? 'selected' : ''}>${h(optionLabel(o))} (${o.count})</option>`).join('')}</optgroup>`;
  }).join('');

  let body = '<p class="muted card">Choose a club or sport above to see who has chosen it.</p>';
  if (selected) {
    const query = form ? `?form=${encodeURIComponent(form)}` : '';
    const roster = await api(`api/staff/options/${selected.id}/roster${query}`);
    const byForm = new Map();
    for (const s of roster.students) {
      if (!byForm.has(s.formLabel)) byForm.set(s.formLabel, []);
      byForm.get(s.formLabel).push(s);
    }
    const flags = [];
    if (selected.closed) flags.push('Closed to students');
    if (selected.capacity != null) flags.push(`Limit ${selected.capacity}`);
    const listUrl = (f) => `#/lists/${selected.id}${f ? `/${encodeURIComponent(f)}` : ''}`;
    const hasSessions = selected.sessions.length > 0;

    body = `
      <div class="page-head">
        <div>
          <h2 class="roster-title">${h(selected.header)}</h2>
          <p class="muted">${roster.students.length} student${roster.students.length === 1 ? '' : 's'}${form ? ` in ${h(form)}` : ''}${flags.length ? ` &middot; ${h(flags.join(', '))}` : ''}</p>
        </div>
        <div class="actions no-print">
          <button class="button secondary" id="print">Print</button>
          <a class="button secondary" href="api/staff/export/option/${selected.id}${query}">Download Excel</a>
        </div>
      </div>
      <div class="chips no-print">
        <a class="chip ${form ? '' : 'on'}" href="${listUrl()}">All forms</a>
        ${forms.map((f) => `<a class="chip ${form === f ? 'on' : ''}" href="${listUrl(f)}">${h(shortForm(f))}</a>`).join('')}
      </div>
      <section class="card no-print add-box">
        <h3>Add a student</h3>
        <input id="add-search" type="search" placeholder="Start typing a name" autocomplete="off" aria-label="Search for a student to add">
        ${hasSessions ? `<div class="inline-sessions" id="add-sessions"><span>Session:</span>${selected.sessions.map((s) => `<label><input type="checkbox" value="${h(s)}"> ${h(s)}</label>`).join('')}</div>` : ''}
        <div id="add-results"></div>
      </section>
      ${[...byForm.entries()].map(([label, list]) => `
        <section class="card roster-form">
          <h3>${h(label)} <small>${list.length}</small></h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Name</th><th>Class</th><th>Gender</th>${hasSessions ? '<th>Session</th>' : ''}<th class="no-print"></th></tr></thead>
            <tbody>${list.map((s) => `
              <tr class="row-link" data-href="#/student/${s.id}" tabindex="0" role="link">
                <td>${h(s.name)}</td>
                <td>${h(s.className)}</td>
                <td>${h(s.gender)}</td>
                ${hasSessions ? `<td>${h(sessionText(s.sessions) || 'Not set')}</td>` : ''}
                <td class="no-print right"><button class="link-danger" data-remove="${s.id}" data-name="${h(s.name)}">Remove</button></td>
              </tr>`).join('')}</tbody>
          </table></div>
        </section>`).join('') || '<p class="muted card">No students yet.</p>'}`;
  }

  render(`
    <div class="page-head no-print"><h1>Clubs &amp; Sports</h1></div>
    <label class="picker no-print">Club or sport
      <select id="option-picker"><option value="">Choose...</option>${picker}</select>
    </label>
    ${body}`);

  document.getElementById('option-picker').addEventListener('change', (event) => {
    location.hash = event.target.value ? `#/lists/${event.target.value}${form ? `/${encodeURIComponent(form)}` : ''}` : '#/lists';
  });
  if (!selected) return;

  document.getElementById('print').addEventListener('click', () => window.print());
  const search = document.getElementById('add-search');
  const results = document.getElementById('add-results');

  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    if (q.length < 2) {
      results.innerHTML = '';
      return;
    }
    const found = await api(`api/staff/students/search?q=${encodeURIComponent(q)}&optionId=${selected.id}`);
    results.innerHTML = found.length ? found.map((s) => `
      <button class="result" data-add="${s.id}" ${s.alreadyAdded ? 'disabled' : ''}>
        <span>${h(s.name)} <span class="muted">${h(s.className)}</span></span>
        <span class="tag">${s.alreadyAdded ? 'Already added' : s.eligible ? 'Add' : 'Not normally eligible: add anyway'}</span>
      </button>`).join('') : '<p class="muted">No students found.</p>';
  }));

  results.addEventListener('click', async (event) => {
    const add = event.target.closest('[data-add]');
    if (!add) return;
    const sessions = [...app.querySelectorAll('#add-sessions input:checked')].map((b) => b.value);
    try {
      await api(`api/staff/options/${selected.id}/students`, {
        method: 'POST',
        body: { studentId: Number(add.dataset.add), sessions },
      });
      toast('Added.');
      await viewLists(selected.id, form);
      document.getElementById('add-search')?.focus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  for (const remove of app.querySelectorAll('[data-remove]')) {
    remove.addEventListener('click', async () => {
      const answer = await modal(`
        <h2>Remove ${h(remove.dataset.name)}?</h2>
        <p>They will be taken off ${h(selected.header)}.</p>
        <div class="row-end">
          <button class="button secondary" data-value="no">Keep</button>
          <button class="button danger" data-value="yes">Remove</button>
        </div>`);
      if (answer !== 'yes') return;
      await api(`api/staff/options/${selected.id}/students/${remove.dataset.remove}`, { method: 'DELETE' });
      toast('Removed.');
      viewLists(selected.id, form);
    });
  }
}

// ---- Downloads ---------------------------------------------------------------
async function viewDownloads() {
  const { forms } = await api('api/staff/progress');
  render(`
    <h1>Downloads</h1>
    <section class="card">
      <h2>Option sheets by form</h2>
      <p class="muted">One workbook per form, with a tab per class, in the same layout as the original sheets.</p>
      <div class="tiles">
        ${forms.map((f) => `
          <a class="tile" href="api/staff/export/form/${encodeURIComponent(f.label)}">
            <strong>${h(f.label)}</strong>
          </a>`).join('')}
      </div>
    </section>
    <section class="card">
      <h2>Club and sport lists</h2>
      <p class="muted">Every club and sport, one tab each, with all forms from F1 to U6.</p>
      <p><a class="button" href="api/staff/export/all-lists">Download all lists</a></p>
      <p class="muted small">To print or download a single list, use <a href="#/lists">Clubs &amp; Sports</a>.</p>
    </section>`);
}

// ---- Setup -------------------------------------------------------------------
async function viewSetup() {
  const [settings, options, removed, log] = await Promise.all([
    api('api/staff/settings'),
    api('api/staff/options'),
    api('api/staff/students-removed'),
    api('api/staff/audit'),
  ]);

  const FORM_CHOICES = [[1, 'F1'], [2, 'F2'], [3, 'F3'], [4, 'F4'], [5, 'L6'], [6, 'U6']];
  const formPick = (name, value) => `<select name="${name}" aria-label="${name === 'min_form' ? 'From form' : 'To form'}">
    ${FORM_CHOICES.map(([v, l]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${l}</option>`).join('')}
  </select>`;

  const optionForm = (o) => `
    <details class="option-edit ${o.active ? '' : 'inactive'}">
      <summary>
        <span>${h(o.header)}</span>
        <span class="muted small">${o.count} chosen${o.closed ? ', closed' : ''}${o.capacity != null ? `, limit ${o.capacity}` : ''}${o.active ? '' : ', not offered'}</span>
      </summary>
      <form data-option-form="${o.id}" class="grid-form">
        <label>Name students see <input name="name" value="${h(o.name)}" required></label>
        <label>Spreadsheet heading <input name="header" value="${h(o.header)}" required></label>
        <label>Who can choose it
          <select name="gender">
            <option value="" ${!o.gender ? 'selected' : ''}>Everyone</option>
            <option value="F" ${o.gender === 'F' ? 'selected' : ''}>Girls</option>
            <option value="M" ${o.gender === 'M' ? 'selected' : ''}>Boys</option>
          </select>
        </label>
        <label>Forms <span class="pair">${formPick('min_form', o.min_form)} to ${formPick('max_form', o.max_form)}</span></label>
        <label>Limit <input name="capacity" type="number" min="0" value="${o.capacity ?? ''}" placeholder="No limit"></label>
        <label class="wide-field">Note for students <textarea name="note" rows="2">${h(o.note)}</textarea></label>
        <div class="wide-field flags">
          <label class="inline"><input type="checkbox" name="closed" ${o.closed ? 'checked' : ''}> Closed (fully subscribed)</label>
          ${o.category === 'sport'
            ? `<label class="inline"><input type="checkbox" name="is_primary" ${o.is_primary ? 'checked' : ''}> Primary sport</label>`
            : `<label class="inline"><input type="checkbox" name="counts_as_club" ${o.counts_as_club ? 'checked' : ''}> Counts as the student's club</label>`}
          <label class="inline"><input type="checkbox" name="active" ${o.active ? 'checked' : ''}> Offered this term</label>
        </div>
        <div class="wide-field"><button class="button secondary" type="submit">Save</button></div>
      </form>
    </details>`;

  const byCategory = (cat) => options.filter((o) => o.category === cat)
    .sort((a, b) => a.header.localeCompare(b.header)).map(optionForm).join('');

  render(`
    <h1>Setup</h1>

    <section class="card">
      <h2>Term and notes</h2>
      <form id="settings" class="stack">
        <label>Term <input name="term_label" value="${h(settings.term_label)}" placeholder="FIRST TERM 2027"></label>
        <label class="inline"><input type="checkbox" name="clash_warnings" ${settings.clash_warnings === '1' ? 'checked' : ''}> Show session times and clash warnings (uses the Third Term 2026 timetables, so turn this off if the timetable changes)</label>
        <label>Sports timetable link <input name="sport_timetable_url" type="url" value="${h(settings.sport_timetable_url)}"></label>
        <label>Clubs timetable link <input name="club_timetable_url" type="url" value="${h(settings.club_timetable_url)}"></label>
        <label>Sports notes, printed at the top of each sheet <textarea name="sport_notes" rows="8">${h(settings.sport_notes)}</textarea></label>
        <label>Clubs admission note <textarea name="club_admission_note" rows="2">${h(settings.club_admission_note)}</textarea></label>
        <label>Clubs notes, printed at the bottom of each sheet <textarea name="club_notes" rows="8">${h(settings.club_notes)}</textarea></label>
        <div><button class="button secondary" type="submit">Save</button></div>
      </form>
    </section>

    <section class="card">
      <h2>Sports</h2>
      ${byCategory('sport')}
      <h2>Clubs</h2>
      ${byCategory('club')}
      <h3>Add a club or sport</h3>
      <form id="add-option" class="inline-form">
        <select name="category" aria-label="Type"><option value="club">Club</option><option value="sport">Sport</option></select>
        <input name="name" placeholder="Name" required aria-label="Name">
        <button class="button secondary" type="submit">Add</button>
      </form>
    </section>

    <section class="card">
      <h2>Class lists</h2>
      <p class="muted">Upload an .xlsx in the same layout as the option sheets, or any sheet with Name, Gender and Class columns (Date of birth optional). You will see the changes before anything is saved.</p>
      <form id="import" class="stack">
        <input type="file" name="file" accept=".xlsx" required aria-label="Class list file">
        <label class="inline"><input type="checkbox" name="removeMissing"> Remove students who are not in this file (use only with the complete school list)</label>
        <div><button class="button secondary" type="submit">Check file</button></div>
      </form>
      <div id="import-report"></div>
      <h3>Add one student</h3>
      <form id="add-student" class="inline-form">
        <input name="name" placeholder="Surname, First name" required aria-label="Name">
        <input name="className" placeholder="Form 4B" required aria-label="Class">
        <select name="gender" aria-label="Gender"><option value="F">Girl</option><option value="M">Boy</option></select>
        <input name="dob" type="date" aria-label="Date of birth">
        <button class="button secondary" type="submit">Add</button>
      </form>
      ${removed.length ? `<details class="others"><summary>${removed.length} removed student${removed.length === 1 ? '' : 's'}</summary>
        <ul class="plain">${removed.map((s) => `<li><a href="#/student/${s.id}">${h(s.name)}</a> <span class="muted">${h(s.className)}</span></li>`).join('')}</ul></details>` : ''}
    </section>

    <section class="card">
      <h2>Staff password</h2>
      <form id="password" class="inline-form">
        <input name="password" type="password" minlength="8" required placeholder="New password" autocomplete="new-password" aria-label="New password">
        <button class="button secondary" type="submit">Change</button>
      </form>
    </section>

    <section class="card">
      <h2>Start a new term</h2>
      <p class="muted">Download this term's sheets first. This clears everyone's choices so they can register again. A backup of the database is saved first in the data/backups folder.</p>
      <form id="clear" class="inline-form">
        <input name="confirm" placeholder="Type CLEAR" required autocomplete="off" aria-label="Type CLEAR to confirm">
        <button class="button danger" type="submit">Clear all choices</button>
      </form>
    </section>

    <section class="card">
      <h2>Change log</h2>
      <details class="others"><summary>Show the latest ${log.length} changes</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Who</th><th>Student or item</th><th>What</th></tr></thead>
          <tbody>${log.map((l) => `<tr><td class="nowrap">${h(formatTime(l.at))}</td><td>${h(l.actor)}</td><td>${h(l.subject)}</td><td>${h(l.action)}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>
    </section>
  `);

  const guarded = (fn) => async (event) => {
    event.preventDefault();
    try {
      await fn(new FormData(event.target), event.target);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  document.getElementById('settings').addEventListener('submit', guarded(async (form) => {
    const body = { ...Object.fromEntries(form), clash_warnings: form.get('clash_warnings') === 'on' ? '1' : '0' };
    await api('api/staff/settings', { method: 'PATCH', body });
    document.getElementById('term').textContent = form.get('term_label');
    toast('Saved.');
  }));

  for (const el of app.querySelectorAll('[data-option-form]')) {
    el.addEventListener('submit', guarded(async (form, target) => {
      const body = {
        name: form.get('name'),
        header: form.get('header'),
        gender: form.get('gender'),
        min_form: Number(form.get('min_form')),
        max_form: Number(form.get('max_form')),
        capacity: form.get('capacity'),
        note: form.get('note'),
        closed: form.get('closed') === 'on',
        active: form.get('active') === 'on',
      };
      if (target.elements.is_primary) body.is_primary = form.get('is_primary') === 'on';
      if (target.elements.counts_as_club) body.counts_as_club = form.get('counts_as_club') === 'on';
      await api(`api/staff/options/${target.dataset.optionForm}`, { method: 'PATCH', body });
      toast('Saved.');
    }));
  }

  document.getElementById('add-option').addEventListener('submit', guarded(async (form) => {
    await api('api/staff/options', { method: 'POST', body: Object.fromEntries(form) });
    toast('Added.');
    viewSetup();
  }));

  document.getElementById('add-student').addEventListener('submit', guarded(async (form, target) => {
    await api('api/staff/students', { method: 'POST', body: Object.fromEntries(form) });
    toast('Student added.');
    target.reset();
  }));

  document.getElementById('password').addEventListener('submit', guarded(async (form, target) => {
    await api('api/staff/password', { method: 'POST', body: Object.fromEntries(form) });
    toast('Password changed.');
    target.reset();
  }));

  document.getElementById('clear').addEventListener('submit', guarded(async (form, target) => {
    const result = await api('api/staff/clear-choices', { method: 'POST', body: { confirm: form.get('confirm') } });
    toast(`All choices cleared. Backup saved as ${result.backup}.`);
    target.reset();
  }));

  document.getElementById('import').addEventListener('submit', guarded(async (form) => {
    const buffer = await form.get('file').arrayBuffer();
    const removeMissing = form.get('removeMissing') === 'on';
    const send = (apply) => api(`api/staff/import?apply=${apply ? 1 : 0}&removeMissing=${removeMissing ? 1 : 0}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    const report = await send(false);
    const section = (title, items) => (items.length ? `
      <details class="others"><summary>${h(title)}: ${items.length}</summary>
        <ul class="plain">${items.map((i) => `<li>${h(i)}</li>`).join('')}</ul>
      </details>` : '');
    document.getElementById('import-report').innerHTML = `
      <div class="report">
        <h3>${report.total} students found</h3>
        <p class="muted">${report.unchanged} unchanged. Nothing has been saved yet.</p>
        ${section('New students', report.added)}
        ${section('Moved class', report.moved)}
        ${section('Updated details', report.updated)}
        ${section(removeMissing ? 'Will be removed (not in this file)' : 'Not in this file (will stay as they are)', report.missing)}
        ${section('Rows skipped', report.skipped)}
        ${section('Listed twice (first kept)', report.duplicates)}
        <button class="button" id="apply-import">Apply these changes</button>
      </div>`;
    document.getElementById('apply-import').addEventListener('click', async () => {
      try {
        await send(true);
        toast('Class lists updated.');
        viewSetup();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }));
}

// ---- Routing -----------------------------------------------------------------
async function route() {
  try {
    if (!staffName) {
      const me = await api('api/staff/me');
      staffName = me.name;
    }
    if (!staffName) {
      viewLogin();
      return;
    }

    document.getElementById('nav').hidden = false;
    document.getElementById('logout').hidden = false;
    const termEl = document.getElementById('term');
    if (!termEl.textContent) termEl.textContent = (await api('api/info')).term;

    const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const [page, a, b] = parts;
    if (page === 'class' && a) {
      setActiveTab('progress');
      await viewClass(a);
    } else if (page === 'student' && a) {
      setActiveTab('progress');
      await viewStudent(a);
    } else if (page === 'lists') {
      setActiveTab('lists');
      await viewLists(a, b);
    } else if (page === 'downloads') {
      setActiveTab('downloads');
      await viewDownloads();
    } else if (page === 'setup') {
      setActiveTab('setup');
      await viewSetup();
    } else {
      setActiveTab('progress');
      await viewProgress();
    }
  } catch (err) {
    if (err.status === 401) {
      staffName = null;
      viewLogin();
      return;
    }
    render(message('Something went wrong', err.message));
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('api/staff/logout', { method: 'POST' });
  staffName = null;
  location.hash = '#/';
  viewLogin();
});

// Whole table rows open the student. Buttons inside a row (such as Remove) keep their own action.
app.addEventListener('click', (event) => {
  if (event.target.closest('button, a, input, select, label')) return;
  const row = event.target.closest('[data-href]');
  if (row) location.hash = row.dataset.href;
});
app.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('[data-href]')) location.hash = event.target.dataset.href;
});

window.addEventListener('hashchange', route);
route();
