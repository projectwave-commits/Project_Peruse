// The theme button shows the mode it switches to: a sun in dark mode, a moon in light mode.
(function () {
  var SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  var MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>';
  var button = document.getElementById('theme');
  function show() {
    var toLight = window.siteTheme.current() !== 'light';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (toLight ? SUN : MOON) + '</svg>';
    button.setAttribute('aria-label', toLight ? 'Light mode' : 'Dark mode');
    button.title = button.getAttribute('aria-label');
  }
  button.addEventListener('click', function () {
    window.siteTheme.set(window.siteTheme.current() === 'light' ? 'dark' : 'light');
    show();
  });
  show();
})();
