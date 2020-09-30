/* global purifyContent */

(function (purify) {
  "use strict";

  window.i18n = purify.i18n;

  window.popupPage = {
    sendMessage: purify.untimeImpl.sendMessage,
    onMessage: purify.untimeImpl.onMessage,
    closePopup() {
      window.close();
    },
    resizePopup() {
      // Doing nothing
    },
  };
})(purifyContent);
