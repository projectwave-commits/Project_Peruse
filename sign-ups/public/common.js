// Shared helpers for the student and staff screens.
const app = document.getElementById('app');

const themeToggle = document.getElementById('theme-toggle');
function labelThemeToggle() {
  themeToggle.textContent = window.siteTheme.current() === 'light' ? 'Dark mode' : 'Light mode';
}
themeToggle.addEventListener('click', () => {
  window.siteTheme.set(window.siteTheme.current() === 'light' ? 'dark' : 'light');
  labelThemeToggle();
});
labelThemeToggle();

/** Escape text for safe use inside HTML. */
function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (options.body !== undefined && !(options.body instanceof ArrayBuffer)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw Object.assign(new Error('Cannot reach the server. Check the Wi-Fi connection and try again.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

function render(html) {
  app.innerHTML = html;
  window.scrollTo(0, 0);
  app.focus({ preventScroll: true });
}

function toast(text, kind = 'ok') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

/** Show a modal and resolve with the value of the button pressed. */
function modal(html) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = html;
    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('[data-value]');
      if (button) dialog.close(button.dataset.value);
    });
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

const debounce = (fn, ms = 200) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

const message = (title, body = '') => `<div class="message"><h1>${h(title)}</h1><p>${h(body)}</p></div>`;
const shortForm = (label) => label.replace('Form ', 'F').replace('Lower 6', 'L6').replace('Upper 6', 'U6');
