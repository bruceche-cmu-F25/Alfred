/* Sets light or dark on <html> (tokens.css reads data-scheme) before the first paint, and follows the system after.
 * A plain file, not inline: the home node's Content-Security-Policy allows only same-origin scripts. */
(function () {
  var dark = matchMedia("(prefers-color-scheme: dark)");
  var apply = function () { document.documentElement.dataset.scheme = dark.matches ? "dark" : "light"; };
  apply();
  dark.addEventListener("change", apply);
})();
