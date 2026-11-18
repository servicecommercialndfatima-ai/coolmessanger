// Page d'installation : affiche les instructions adaptées à l'appareil.
// Écrit en JavaScript ancien pour fonctionner sur les vieux iPhone.
(function () {
  'use strict';
  var ua = navigator.userAgent;
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /android/i.test(ua);
  // Chrome, Firefox, Edge, ou le navigateur intégré de WhatsApp / Facebook / Instagram sur iPhone
  var isIOSOtherBrowser = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS|GSA|FBAN|FBAV|Instagram|WhatsApp/i.test(ua);
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  var show = standalone ? 'installed'
    : isIOS ? (isIOSOtherBrowser ? 'ios-other' : 'ios-safari')
    : isAndroid ? 'android'
    : 'desktop';
  var section = document.querySelector('[data-show="' + show + '"]');
  if (section) section.hidden = false;

  var url = location.origin + '/installer';
  var urlBox = document.getElementById('page-url');
  if (urlBox) urlBox.textContent = url;

  var toastTimer = null;
  function toast(text) {
    var t = document.getElementById('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function copy() {
    function fallback() {
      var area = document.createElement('textarea');
      area.value = url;
      area.setAttribute('readonly', '');
      area.style.position = 'absolute';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, url.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      toast(ok ? 'Lien copié.' : 'Copiez le lien affiché dans la barre d\'adresse.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast('Lien copié.'); }, fallback);
    } else {
      fallback();
    }
  }
  ['copy-link', 'copy-link-desktop'].forEach(function (id) {
    var button = document.getElementById(id);
    if (button) button.onclick = copy;
  });
})();
