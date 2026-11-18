// Compléments pour les anciens iPhone (iOS 12 à 15) : ajoutent les fonctions récentes
// dont l'application a besoin. Écrit volontairement en JavaScript ancien.
(function () {
  'use strict';

  // replaceChildren : iOS 14+
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      for (var i = 0; i < arguments.length; i++) {
        var node = arguments[i];
        this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
      }
    };
  }

  // requestSubmit : iOS 16+
  if (!HTMLFormElement.prototype.requestSubmit) {
    HTMLFormElement.prototype.requestSubmit = function () {
      var button = document.createElement('button');
      button.type = 'submit';
      button.style.display = 'none';
      this.appendChild(button);
      button.click();
      this.removeChild(button);
    };
  }

  // Fenêtres <dialog> : iOS 15.4+
  function patchDialogs() {
    if (window.HTMLDialogElement && HTMLDialogElement.prototype.showModal) return;
    var dialogs = document.querySelectorAll('dialog');
    for (var i = 0; i < dialogs.length; i++) {
      (function (dialog) {
        dialog.showModal = function () {
          dialog.setAttribute('open', '');
          dialog.classList.add('dlg-fallback');
          document.body.classList.add('dlg-open');
        };
        dialog.close = function () {
          dialog.removeAttribute('open');
          document.body.classList.remove('dlg-open');
        };
      })(dialogs[i]);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', patchDialogs);
  else patchDialogs();
})();
