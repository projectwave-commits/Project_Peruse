// Student flow: form > class > name > choices > check > saved, then back to the class list.
let info = null;
let choosing = null; // the student currently choosing

const GROUPS = [
  ['primary', 'Primary sports', 'Choose at least one.'],
  ['sport', 'Other sports', 'Optional.'],
  ['club', 'Clubs', 'Choose at least one.'],
  ['extra', 'Extras and applications', 'Optional. These do not count as your club.'],
];

function showError(err) {
  if (err.status === 423) {
    render(message('Registration is closed', 'Please ask your teacher.'));
    return;
  }
  render(`${message('Something went wrong', err.message)}<p class="center"><a class="button" href="#/">Start again</a></p>`);
}

async function viewForms() {
  const forms = await api('api/classes');
  render(`
    <h1>Find your class</h1>
    ${forms.map((form) => `
      <section class="form-group">
        <h2>${h(form.label)}</h2>
        <div class="tiles">
          ${form.classes.map((c) => `
            <a class="tile" href="#/class/${encodeURIComponent(c.class_name)}">
              <strong>${h(c.class_name)}</strong>
            </a>`).join('')}
        </div>
      </section>`).join('')}
  `);
}

async function viewClass(className) {
  const students = await api(`api/classes/${encodeURIComponent(className)}/students`);
  const remaining = students.filter((s) => !s.done).length;
  render(`
    <a class="back" href="#/">&larr; All classes</a>
    <h1>${h(className)}</h1>
    <p class="muted">${remaining === 0 ? 'Everyone in this class is done.' : `Tap your name. ${remaining} still to go.`}</p>
    <input id="filter" class="search" type="search" placeholder="Search for your name" aria-label="Search for your name" autocomplete="off">
    <div class="names">
      ${students.map((s) => (s.done
        ? `<span class="name done" data-name="${h(s.name.toLowerCase())}"><span>${h(s.name)}</span><span class="tick">Done</span></span>`
        : `<a class="name" data-name="${h(s.name.toLowerCase())}" href="#/student/${s.id}?class=${encodeURIComponent(className)}">${h(s.name)}</a>`)).join('')}
    </div>
  `);
  document.getElementById('filter').addEventListener('input', (event) => {
    const q = event.target.value.trim().toLowerCase();
    for (const el of app.querySelectorAll('.name')) el.hidden = !el.dataset.name.includes(q);
  });
}

async function viewChoices(id, className) {
  const data = await api(`api/students/${id}/choices`);
  const home = className || data.student.className;

  const answer = await modal(`
    <h2>Is this you?</h2>
    <p class="big">${h(data.student.name)}</p>
    <p class="muted">${h(data.student.className)}</p>
    <div class="row-end">
      <button class="button secondary" data-value="no">No, go back</button>
      <button class="button" data-value="yes" autofocus>Yes, that's me</button>
    </div>`);
  if (answer !== 'yes') {
    location.hash = `#/class/${encodeURIComponent(home)}`;
    return;
  }

  choosing = {
    ...data,
    home,
    picked: new Map(data.options.filter((o) => o.selected).map((o) => [o.id, new Set(o.chosenSessions)])),
  };
  drawChoices(true);
}

function optionCard(option) {
  const picked = choosing.picked.has(option.id);
  const sessions = picked ? choosing.picked.get(option.id) : null;
  return `
    <div class="option ${picked ? 'picked' : ''} ${option.unavailable ? 'disabled' : ''}">
      <button class="option-main" data-option="${option.id}" aria-pressed="${picked}" ${option.unavailable ? 'disabled' : ''}>
        <span class="check" aria-hidden="true">${picked ? '&#10003;' : ''}</span>
        <span class="option-text">
          <strong>${h(option.name)}</strong>
          ${option.unavailable ? `<span class="tag">${h(option.unavailable)}</span>` : ''}
          ${option.times?.length ? `<span class="times">${h(formatTimes(option.times))}</span>` : ''}
          ${option.note ? `<span class="note">${h(option.note)}</span>` : ''}
        </span>
      </button>
      ${picked && option.sessions.length ? `
        <div class="sessions">
          <span>Which session?</span>
          ${option.sessions.map((s) => `
            <button class="chip ${sessions.has(s) ? 'on' : ''}" data-session="${h(s)}" data-for="${option.id}" aria-pressed="${sessions.has(s)}">${h(s)}</button>`).join('')}
        </div>` : ''}
    </div>`;
}

function getMissing() {
  const chosen = choosing.options.filter((o) => choosing.picked.has(o.id));
  const missing = [];
  if (!choosing.student.sportExempt && !chosen.some((o) => o.group === 'primary')) missing.push('a primary sport');
  if (!chosen.some((o) => o.group === 'club')) missing.push('a club');
  for (const o of chosen) {
    if (o.sessions.length && !choosing.picked.get(o.id).size) missing.push(`a session for ${o.name}`);
  }
  return missing;
}

function getClashes() {
  const chosen = choosing.options.filter((o) => choosing.picked.has(o.id));
  return findClashes(chosen.map((o) => ({
    name: o.name,
    times: o.times,
    sessions: [...choosing.picked.get(o.id)],
  })));
}

function drawChoices(fromTop = false) {
  const scroll = fromTop ? 0 : window.scrollY;
  const { student, options } = choosing;
  const missing = getMissing();
  const clashes = getClashes();

  render(`
    <div class="choices-head">
      <h1>${h(student.name)}</h1>
      <p class="muted">${h(student.className)}</p>
    </div>
    <p class="links">
      ${info.sportTimetable ? `<a href="${h(info.sportTimetable)}" target="_blank" rel="noopener">Sports timetable</a>` : ''}
      ${info.clubTimetable ? `<a href="${h(info.clubTimetable)}" target="_blank" rel="noopener">Clubs timetable</a>` : ''}
    </p>
    ${student.sportExempt ? '<p class="info">You do not need to choose a primary sport.</p>' : ''}
    ${GROUPS.map(([group, title, hint]) => {
      const list = options.filter((o) => o.group === group);
      if (!list.length) return '';
      const text = group === 'primary' && student.sportExempt ? 'Optional.' : hint;
      return `
        <section class="option-group">
          <h2>${h(title)} <small>${h(text)}</small></h2>
          ${group === 'club' ? `<p class="muted small">${h(info.admissionNote.replace(/\s*\(see more club info below\)/i, ''))}</p>` : ''}
          <div class="options">${list.map(optionCard).join('')}</div>
        </section>`;
    }).join('')}
    <div class="action-bar">
      ${clashes.length ? `<div class="clash-list">${clashes.map((c) => `<div>${h(describeClash(c))}</div>`).join('')}</div>` : ''}
      <div class="action-status ${missing.length ? '' : 'ready'}">
        ${missing.length ? `Still needed: ${h(missing.join(', '))}` : `${choosing.picked.size} selected. Ready to check.`}
      </div>
      <button class="button secondary" id="cancel">Cancel</button>
      <button class="button" id="review" ${missing.length ? 'disabled' : ''}>Check my choices</button>
    </div>
  `);
  window.scrollTo(0, scroll);
}

function showSaved(name, home) {
  const next = `#/class/${encodeURIComponent(home)}`;
  render(`
    <div class="message success">
      <div class="big-tick" aria-hidden="true">&#10003;</div>
      <h1>Saved. Thank you, ${h(name)}.</h1>
      <p>Please pass the device to the next student.</p>
      <p><a class="button" href="${next}">Next student</a></p>
    </div>`);
  const timer = setTimeout(() => { location.hash = next; }, 5000);
  window.addEventListener('hashchange', () => clearTimeout(timer), { once: true });
}

async function reviewChoices() {
  const chosen = choosing.options.filter((o) => choosing.picked.has(o.id));
  const line = (o) => {
    const sessions = [...choosing.picked.get(o.id)].sort().join(' & ');
    return `<li>${h(o.name)}${sessions ? ` <span class="muted">(session ${h(sessions)})</span>` : ''}</li>`;
  };
  const sport = chosen.filter((o) => o.group === 'primary' || o.group === 'sport');
  const club = chosen.filter((o) => o.group === 'club' || o.group === 'extra');
  const clashes = getClashes();
  const answer = await modal(`
    <h2>Are these correct?</h2>
    <p class="muted">${h(choosing.student.name)}, once saved, only a teacher can change these.</p>
    ${sport.length ? `<h3>Sports</h3><ul class="summary">${sport.map(line).join('')}</ul>` : ''}
    ${club.length ? `<h3>Clubs</h3><ul class="summary">${club.map(line).join('')}</ul>` : ''}
    ${clashes.length ? `
      <div class="clash-box">
        <strong>Timetable clashes</strong>
        ${clashes.map((c) => `<div>${h(describeClash(c))}</div>`).join('')}
        <p class="small">You can still save. If two sports clash, your primary sport comes first, and you may be able to leave early or arrive late. Check with your teacher.</p>
      </div>` : ''}
    <div class="row-end">
      <button class="button secondary" data-value="back">Go back</button>
      <button class="button" data-value="save" autofocus>Save my choices</button>
    </div>`);
  if (answer !== 'save') return;

  const selections = chosen.map((o) => ({ optionId: o.id, sessions: [...choosing.picked.get(o.id)] }));
  try {
    await api(`api/students/${choosing.student.id}/submit`, { method: 'POST', body: { selections } });
  } catch (err) {
    if (err.status === 423) {
      showError(err);
    } else if (err.status === 409 && /filled up/.test(err.message)) {
      toast(err.message, 'error');
      const fresh = await api(`api/students/${choosing.student.id}/choices`);
      choosing.options = fresh.options;
      for (const o of fresh.options) if (o.unavailable) choosing.picked.delete(o.id);
      drawChoices();
    } else {
      toast(err.message, 'error');
    }
    return;
  }

  const { home, student } = choosing;
  choosing = null;
  showSaved(student.name, home);
}

app.addEventListener('click', async (event) => {
  if (!choosing) return;
  const optionBtn = event.target.closest('[data-option]');
  if (optionBtn) {
    const id = Number(optionBtn.dataset.option);
    if (choosing.picked.has(id)) choosing.picked.delete(id);
    else choosing.picked.set(id, new Set());
    drawChoices();
    return;
  }
  const chip = event.target.closest('[data-session]');
  if (chip) {
    const set = choosing.picked.get(Number(chip.dataset.for));
    if (set.has(chip.dataset.session)) set.delete(chip.dataset.session);
    else set.add(chip.dataset.session);
    drawChoices();
    return;
  }
  if (event.target.closest('#review')) {
    await reviewChoices();
    return;
  }
  if (event.target.closest('#cancel')) {
    const answer = await modal(`
      <h2>Cancel?</h2>
      <p>Your choices have not been saved.</p>
      <div class="row-end">
        <button class="button secondary" data-value="stay">Keep choosing</button>
        <button class="button danger" data-value="leave">Cancel and go back</button>
      </div>`);
    if (answer === 'leave') {
      const { home } = choosing;
      choosing = null;
      location.hash = `#/class/${encodeURIComponent(home)}`;
    }
  }
});

async function route() {
  choosing = null;
  try {
    info = await api('api/info');
    document.getElementById('term').textContent = info.term;
    if (!info.open) {
      render(message('Registration is closed', 'Please ask your teacher.'));
      return;
    }
    const [path, query] = location.hash.replace(/^#/, '').split('?');
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'class' && parts[1]) {
      await viewClass(decodeURIComponent(parts[1]));
    } else if (parts[0] === 'student' && parts[1]) {
      await viewChoices(parts[1], new URLSearchParams(query).get('class') || '');
    } else {
      await viewForms();
    }
  } catch (err) {
    if (err.status === 409) {
      render(`${message('Already saved', err.message)}<p class="center"><a class="button" href="#/">Back</a></p>`);
    } else {
      showError(err);
    }
  }
}

window.addEventListener('hashchange', route);
route();
