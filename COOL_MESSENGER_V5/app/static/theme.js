// Chargé avant l'affichage pour appliquer tout de suite le thème choisi (pas de flash).
(function () {
  var known = ['classique', 'nuit', 'douceur', 'crepuscule', 'foret', 'corail'];
  var theme = 'classique';
  try { theme = localStorage.getItem('cm_theme') || theme; } catch (e) {}
  document.documentElement.dataset.theme = known.indexOf(theme) >= 0 ? theme : 'classique';
})();
