/* Sets light or dark on <html> (tokens.css reads data-scheme) before the first paint.
 * It follows the system unless this device chose one (src/scheme.ts keeps the choice in localStorage);
 * a choice made in another window of the same origin (the Mac app's presence window) arrives as a storage event.
 * A plain file, not inline: the home node's Content-Security-Policy allows only same-origin scripts. */
(function () {
  var KEY = "alfred.scheme";
  var dark = matchMedia("(prefers-color-scheme: dark)");
  var chosen = function () {
    try { var value = localStorage.getItem(KEY); return value === "light" || value === "dark" ? value : null; } catch (error) { return null; }
  };
  var apply = function () { document.documentElement.dataset.scheme = chosen() || (dark.matches ? "dark" : "light"); };
  apply();
  dark.addEventListener("change", apply);
  addEventListener("storage", function (event) { if (event.key === KEY || event.key === null) apply(); });
})();
