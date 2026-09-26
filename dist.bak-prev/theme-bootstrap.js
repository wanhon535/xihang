// Paints the last-known workspace theme (see workspace-theme.js's
// cacheThemeSnapshot) before first render, avoiding a flash of the default
// dark canvas while the real /api/user/workspace-theme fetch is in flight.
// Loaded as a plain, render-blocking <script src> (no type="module"/defer) from
// every vben-shell page's <head>, before the stylesheet link, so it runs
// synchronously ahead of first paint exactly like an inline script would —
// one shared file instead of the same snippet pasted into five HTML files.
(function () {
  try {
    var snapshot = JSON.parse(localStorage.getItem('tidesail.theme.snapshot'));
    if (snapshot && snapshot.tokens) {
      var style = document.documentElement.style;
      for (var key in snapshot.tokens) {
        style.setProperty(key, snapshot.tokens[key]);
      }
      style.setProperty('background', 'linear-gradient(' + snapshot.overlayColor + ',' + snapshot.overlayColor + '),' + snapshot.background);
      style.setProperty('background-attachment', 'fixed');
    }
  } catch (error) {
    // Best-effort only; a bad/missing snapshot just means no early paint.
  }
})();
