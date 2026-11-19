// Chargé avant l'affichage pour appliquer tout de suite le thème choisi (pas de flash).
(function () {
  var known = ['classique', 'nuit', 'douceur', 'crepuscule', 'foret', 'corail'];
  var theme = 'classique';
  try { theme = localStorage.getItem('cm_theme') || theme; } catch (e) {}
  document.documentElement.dataset.theme = known.indexOf(theme) >= 0 ? theme : 'classique';

  // Animation de démarrage : une fois par ouverture de l'application, pas à chaque rechargement.
  try {
    if (sessionStorage.getItem('cm_splash')) document.documentElement.className += ' splash-seen';
    else sessionStorage.setItem('cm_splash', '1');
  } catch (e) {}
})();
