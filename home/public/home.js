// The one sign-in for every app.
// For now the accounts are the demerits app's: prefects go straight to demerits, and its admins are
// staff, who see the apps. Staff are planned to sign in with their main portal accounts instead; only
// the account functions below would change.
(function () {
  var SIGN_IN = '../demerits/api/';
  var PREFECT_HOME = '../demerits/';

  var status = document.getElementById('status');
  var signin = document.getElementById('signin');
  var form = document.getElementById('signin-form');
  var formError = document.getElementById('signin-error');
  var apps = document.getElementById('apps');

  function call(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', credentials: 'same-origin', headers: { 'X-Requested-With': 'prefects-app' } };
    if (options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    if (window.AbortSignal && AbortSignal.timeout) init.signal = AbortSignal.timeout(10000);
    return fetch(SIGN_IN + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status });
        return data;
      });
    }, function () {
      throw Object.assign(new Error('Cannot reach the server. Are you on the school network?'), { status: 0 });
    });
  }

  // Account functions: the parts to replace when staff move to their main portal accounts.
  function currentUser() { return call('me'); }
  function signIn(username, password) { return call('login', { method: 'POST', body: { username: username, password: password } }); }
  function signOut() { return call('logout', { method: 'POST', body: {} }); }

  function show(section) {
    status.hidden = section !== status;
    signin.hidden = section !== signin;
    apps.hidden = section !== apps;
  }

  function showSignIn(message) {
    formError.hidden = !message;
    formError.textContent = message || '';
    show(signin);
    form.username.focus();
  }

  // Prefects, and anyone who must still choose a password, carry on in demerits.
  function land(user) {
    if (user.role !== 'admin' || user.must_change_password) {
      location.replace(PREFECT_HOME);
      return;
    }
    document.getElementById('who').textContent = user.display_name;
    show(apps);
  }

  function failed(err) {
    status.textContent = err.message;
    status.className = 'status error';
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = 'Try again';
    retry.addEventListener('click', start);
    status.append(document.createElement('br'), retry);
    show(status);
  }

  function start() {
    status.textContent = 'Loading…';
    status.className = 'status';
    show(status);
    currentUser().then(land, function (err) {
      // Only a 401 means signed out. A network fault must not look like one.
      if (err.status === 401) showSignIn();
      else failed(err);
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = form.querySelector('button');
    button.disabled = true;
    formError.hidden = true;
    signIn(form.username.value.trim(), form.password.value)
      .then(currentUser)
      .then(function (user) {
        form.password.value = '';
        land(user);
      }, function (err) { showSignIn(err.message); })
      .then(function () { button.disabled = false; });
  });

  document.getElementById('signout').addEventListener('click', function () {
    signOut().then(function () { showSignIn(); }, function (err) { failed(err); });
  });

  // The theme button shows the mode it switches to: a sun in dark mode, a moon in light mode.
  var SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  var MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>';
  var themeButton = document.getElementById('theme');
  function showTheme() {
    var toLight = window.siteTheme.current() !== 'light';
    themeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (toLight ? SUN : MOON) + '</svg>';
    themeButton.setAttribute('aria-label', toLight ? 'Light mode' : 'Dark mode');
    themeButton.title = themeButton.getAttribute('aria-label');
  }
  themeButton.addEventListener('click', function () {
    window.siteTheme.set(window.siteTheme.current() === 'light' ? 'dark' : 'light');
    showTheme();
  });
  showTheme();

  start();
})();
