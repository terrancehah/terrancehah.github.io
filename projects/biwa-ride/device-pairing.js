/* device-pairing.js — 'Pair devices' dialog wiring, self-contained.
 *
 * Extracted from biwa-ride.js so the application controller only ever sees
 * BiwaDevicePairing.init({store, elements, translate, reload}). Personal
 * trips mean two of the owner's devices only share a trip by claiming the
 * same identity: 'Send' mints a code on this device; 'receive' claims one
 * shown elsewhere and reloads under the adopted id so every module
 * reboots cleanly.
 */
(function (global) {
  'use strict';

  // The elements object last wired — init with the same set is a no-op so
  // a repeated boot can never double-bind the dialog controls.
  var boundElements = null;

  // options: {store, elements, translate, reload}
  //   elements: {open, dialog, show, code, codeNote, input, claim,
  //              status, close} — every entry optional; a partial DOM
  //   simply wires what exists.
  //   translate: the app's t() — display strings stay in biwa-i18n.
  //   reload:    how to reboot under the adopted identity (location.reload
  //              in the page, a spy in tests).
  // Returns a truthy handle, or null when there is nothing to drive.
  function init(options) {
    var store = options && options.store;
    var elements = options && options.elements;
    var translate = options && options.translate
      ? options.translate
      : function (key) { return key; };
    var reload = options && options.reload ? options.reload : function () {};
    if (!store || !elements) return null;
    if (boundElements === elements) return { wired: true };
    boundElements = elements;

    if (elements.open && elements.dialog) {
      elements.open.addEventListener('click', function () {
        if (elements.status) elements.status.textContent = '';
        elements.dialog.showModal();
      });
    }
    if (elements.close && elements.dialog) {
      elements.close.addEventListener('click', function () {
        elements.dialog.close();
      });
    }
    if (elements.show) {
      elements.show.addEventListener('click', function () {
        var btn = elements.show;
        btn.disabled = true;
        if (elements.status) {
          elements.status.textContent = translate('Requesting code…');
        }
        store.createPairCode().then(function (body) {
          btn.disabled = false;
          if (!body || !body.ok || !body.code) {
            if (elements.status) {
              elements.status.textContent =
                translate('Could not create a code — try again.');
            }
            return;
          }
          if (elements.status) elements.status.textContent = '';
          // Characters get individual spans so letter-spacing can be wide
          // without the trailing space inflating the visual center.
          if (elements.code) {
            elements.code.textContent = body.code.split('').join(' ');
            elements.code.hidden = false;
          }
          if (elements.codeNote) elements.codeNote.hidden = false;
        });
      });
    }
    if (elements.claim) {
      elements.claim.addEventListener('click', function () {
        var code = elements.input
          ? (elements.input.value || '').trim().toUpperCase() : '';
        if (code.length !== 6) {
          if (elements.status) {
            elements.status.textContent =
              translate('That code is invalid or expired — check it and try again.');
          }
          return;
        }
        elements.claim.disabled = true;
        if (elements.status) {
          elements.status.textContent = translate('Claiming…');
        }
        store.claimPairCode(code).then(function (body) {
          elements.claim.disabled = false;
          if (body && body.ok && body.ownerId &&
              store.adoptOwner(body.ownerId)) {
            if (elements.status) {
              elements.status.textContent =
                translate('Trip claimed — reloading…');
            }
            // A reload reboots every module under the adopted identity —
            // cleaner than patching live state mid-flight.
            reload();
            return;
          }
          if (elements.status) {
            elements.status.textContent =
              translate('That code is invalid or expired — check it and try again.');
          }
        });
      });
    }
    return { wired: true };
  }

  var api = { init: init };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BiwaDevicePairing = api;
})(typeof window !== 'undefined' ? window : globalThis);
