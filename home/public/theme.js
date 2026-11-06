// Picks dark or light before the page draws. Follows the device until someone chooses.
// The choice is kept in this browser and is shared by every app on this address.
(function () {
  var BAR = { dark: '#1a1a2e', light: '#25282d' };
  function stored() {
    try { return localStorage.getItem('theme'); } catch (e) { return null; }
  }
  function current() {
    var t = stored();
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function apply(t) {
    document.documentElement.classList.toggle('light', t === 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BAR[t]);
  }
  function set(t) {
    try { localStorage.setItem('theme', t); } catch (e) { /* storage blocked: lasts for this page only */ }
    apply(t);
  }
  apply(current());
  window.siteTheme = { current: current, set: set };
})();
