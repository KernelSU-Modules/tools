// Render-blocking theme bootstrap, loaded as an external same-origin file from <head> (CSP script-src 'self';
// no inline script). Without a stored choice nothing happens: the CSS follows prefers-color-scheme on its own,
// so the default never flashes. A stored explicit choice is applied before first paint.
(function () {
  try {
    var t = localStorage.getItem('kernelsu-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage disabled */
  }
})();
