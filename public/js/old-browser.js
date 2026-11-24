// Runs only in browsers that cannot load ES modules. They are too old for the
// app, so this says so instead of leaving the owner at a blank page.
(function () {
  var line = document.getElementById('boot-line');
  var boot = document.getElementById('boot');
  if (boot) boot.className = 'boot is-error';
  if (line) line.textContent = 'This browser is too old for the app. Please open it in Chrome, Edge or Samsung Internet.';
})();
