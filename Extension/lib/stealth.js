

/* global purify */

purify.stealthService = (function (purify) {
  "use strict";

  /**
   * Search engines regexps
   *
   * @type {Array.<string>}
   */
  const SEARCH_ENGINES = [
    /https?:\/\/(www\.)?google\./i,
    /https?:\/\/(www\.)?yandex\./i,
    /https?:\/\/(www\.)?bing\./i,
    /https?:\/\/(www\.)?yahoo\./i,
    /https?:\/\/(www\.)?go\.mail\.ru/i,
    /https?:\/\/(www\.)?ask\.com/i,
    /https?:\/\/(www\.)?aol\.com/i,
    /https?:\/\/(www\.)?baidu\.com/i,
    /https?:\/\/(www\.)?seznam\.cz/i,
  ];

  /**
   * Headers
   */
  const HEADERS = {
    REFERRER: "Referer",
    X_CLIENT_DATA: "X-Client-Data",
    DO_NOT_TRACK: "DNT",
  };

  /**
   * Header values
   */
  const HEADER_VALUES = {
    DO_NOT_TRACK: {
      name: "DNT",
      value: "1",
    },
  };

  const STEALTH_ACTIONS = {
    HIDE_REFERRER: 1 << 0,
    HIDE_SEARCH_QUERIES: 1 << 1,
    BLOCK_CHROME_CLIENT_DATA: 1 << 2,
    SEND_DO_NOT_TRACK: 1 << 3,
    STRIPPED_TRACKING_URL: 1 << 4,
    FIRST_PARTY_COOKIES: 1 << 5,
    THIRD_PARTY_COOKIES: 1 << 6,
  };

  /**
   * Is url search engine
   *
   * @param {string} url
   * @returns {boolean}
   */
  const isSearchEngine = function (url) {
    if (!url) {
      return false;
    }

    for (let i = 0; i < SEARCH_ENGINES.length; i++) {
      if (SEARCH_ENGINES[i].test(url)) {
        return true;
      }
    }

    return false;
  };

  /**
   * Crops url path
   * @param url URL
   * @return {string} URL without path
   */
  const getHiddenRefHeaderUrl = (url) => {
    const host = purify.utils.url.getHost(url);
    return (url.indexOf("https") === 0 ? "https://" : "http://") + host + "/";
  };

  /**
   * Generates rule removing cookies
   *
   * @param {number} maxAgeMinutes Cookie maxAge in minutes
   * @param {number} stealthActions stealth actions to add to the rule
   */
  const generateRemoveRule = function (maxAgeMinutes, stealthActions) {
    const maxAgeOption =
      maxAgeMinutes > 0 ? `;maxAge=${maxAgeMinutes * 60}` : "";
    const rule = new purify.rules.UrlFilterRule(`$cookie=/.+/${maxAgeOption}`);
    rule.addStealthActions(stealthActions);
    return rule;
  };

  /**
   * Checks if stealth mode is disabled
   * @returns {boolean}
   */
  const isStealthModeDisabled = () => {
    return (
      purify.settings.getProperty(purify.settings.DISABLE_STEALTH_MODE) ||
      purify.settings.isFilteringDisabled()
    );
  };

  /**
   * Returns stealth setting current value, considering if global stealth setting is enabled
   * @param stealthSettingName
   * @returns {boolean}
   */
  const getStealthSettingValue = (stealthSettingName) => {
    if (isStealthModeDisabled()) {
      return false;
    }
    return purify.settings.getProperty(stealthSettingName);
  };

  /**
   * Processes request headers
   *
   * @param {string} requestId Request identifier
   * @param {Array} requestHeaders Request headers
   * @return {boolean} True if headers were modified
   */
  const processRequestHeaders = function (requestId, requestHeaders) {
    // If stealth mode is disabled do not process headers
    if (isStealthModeDisabled()) {
      return false;
    }

    const context = purify.requestContextStorage.get(requestId);
    if (!context) {
      return false;
    }

    const tab = context.tab;
    const requestUrl = context.requestUrl;
    const requestType = context.requestType;

    purify.console.debug(
      "Stealth service processing request headers for {0}",
      requestUrl
    );

    if (purify.frames.shouldStopRequestProcess(tab)) {
      purify.console.debug("Tab whitelisted or protection disabled");
      return false;
    }

    let mainFrameUrl = purify.frames.getMainFrameUrl(tab);
    if (!mainFrameUrl) {
      // frame wasn't recorded in onBeforeRequest event
      purify.console.debug("Frame was not recorded in onBeforeRequest event");
      return false;
    }

    const whiteListRule = purify.requestFilter.findWhiteListRule(
      requestUrl,
      mainFrameUrl,
      requestType
    );
    if (whiteListRule && whiteListRule.isDocumentWhiteList()) {
      purify.console.debug("Whitelist rule found");
      return false;
    }

    const stealthWhiteListRule = findStealthWhitelistRule(
      requestUrl,
      mainFrameUrl,
      requestType
    );
    if (stealthWhiteListRule) {
      purify.console.debug("Whitelist stealth rule found");
      purify.requestContextStorage.update(requestId, {
        requestRule: stealthWhiteListRule,
      });
      return false;
    }

    let stealthActions = 0;

    // Remove referrer for third-party requests
    const hideReferrer = getStealthSettingValue(purify.settings.HIDE_REFERRER);
    if (hideReferrer) {
      purify.console.debug("Remove referrer for third-party requests");
      const refHeader = purify.utils.browser.findHeaderByName(
        requestHeaders,
        HEADERS.REFERRER
      );
      if (
        refHeader &&
        purify.utils.url.isThirdPartyRequest(requestUrl, refHeader.value)
      ) {
        refHeader.value = getHiddenRefHeaderUrl(requestUrl);
        stealthActions |= STEALTH_ACTIONS.HIDE_REFERRER;
      }
    }

    // Hide referrer in case of search engine is referrer
    const isMainFrame = requestType === purify.RequestTypes.DOCUMENT;
    const hideSearchQueries = getStealthSettingValue(
      purify.settings.HIDE_SEARCH_QUERIES
    );
    if (hideSearchQueries && isMainFrame) {
      purify.console.debug(
        "Hide referrer in case of search engine is referrer"
      );
      const refHeader = purify.utils.browser.findHeaderByName(
        requestHeaders,
        HEADERS.REFERRER
      );
      if (
        refHeader &&
        isSearchEngine(refHeader.value) &&
        purify.utils.url.isThirdPartyRequest(requestUrl, refHeader.value)
      ) {
        refHeader.value = getHiddenRefHeaderUrl(requestUrl);
        stealthActions |= STEALTH_ACTIONS.HIDE_SEARCH_QUERIES;
      }
    }

    // Remove X-Client-Data header
    const blockChromeClientData = getStealthSettingValue(
      purify.settings.BLOCK_CHROME_CLIENT_DATA
    );
    if (blockChromeClientData) {
      purify.console.debug("Remove X-Client-Data header");
      if (
        purify.utils.browser.removeHeader(
          requestHeaders,
          HEADERS.X_CLIENT_DATA
        )
      ) {
        stealthActions |= STEALTH_ACTIONS.BLOCK_CHROME_CLIENT_DATA;
      }
    }

    // Adding Do-Not-Track (DNT) header
    const sendDoNotTrack = getStealthSettingValue(
      purify.settings.SEND_DO_NOT_TRACK
    );
    if (sendDoNotTrack) {
      purify.console.debug("Adding Do-Not-Track (DNT) header");
      requestHeaders.push(HEADER_VALUES.DO_NOT_TRACK);
      stealthActions |= STEALTH_ACTIONS.SEND_DO_NOT_TRACK;
    }

    if (stealthActions > 0) {
      purify.requestContextStorage.update(requestId, { stealthActions });
    }

    purify.console.debug(
      "Stealth service processed request headers for {0}",
      requestUrl
    );

    return stealthActions > 0;
  };

  /**
   * Returns synthetic set of rules matching the specified request
   *
   * @param requestUrl
   * @param referrerUrl
   * @param requestType
   */
  const getCookieRules = function (requestUrl, referrerUrl, requestType) {
    // if stealth mode is disabled
    if (isStealthModeDisabled()) {
      return null;
    }

    const whiteListRule = purify.requestFilter.findWhiteListRule(
      requestUrl,
      referrerUrl,
      requestType
    );
    if (whiteListRule && whiteListRule.isDocumentWhiteList()) {
      purify.console.debug("Whitelist rule found");
      return false;
    }

    // If stealth is whitelisted
    const stealthWhiteListRule = findStealthWhitelistRule(
      requestUrl,
      referrerUrl,
      requestType
    );
    if (stealthWhiteListRule) {
      purify.console.debug("Whitelist stealth rule found");
      return null;
    }

    const result = [];

    purify.console.debug(
      "Stealth service lookup cookie rules for {0}",
      requestUrl
    );

    // Remove cookie header for first-party requests
    const blockCookies = getStealthSettingValue(
      purify.settings.SELF_DESTRUCT_FIRST_PARTY_COOKIES
    );
    if (blockCookies) {
      result.push(
        generateRemoveRule(
          purify.settings.getProperty(
            purify.settings.SELF_DESTRUCT_FIRST_PARTY_COOKIES_TIME
          ),
          STEALTH_ACTIONS.FIRST_PARTY_COOKIES
        )
      );
    }

    const blockThirdPartyCookies = getStealthSettingValue(
      purify.settings.SELF_DESTRUCT_THIRD_PARTY_COOKIES
    );
    if (!blockThirdPartyCookies) {
      purify.console.debug(
        "Stealth service processed lookup cookie rules for {0}",
        requestUrl
      );
      return result;
    }

    // Marks requests without referrer as first-party.
    // It's important to prevent removing google auth cookies. (for requests in background tab)
    const thirdParty =
      referrerUrl &&
      purify.utils.url.isThirdPartyRequest(requestUrl, referrerUrl);
    const isMainFrame = requestType === purify.RequestTypes.DOCUMENT;

    // Remove cookie header for third-party requests
    if (thirdParty && !isMainFrame) {
      result.push(
        generateRemoveRule(
          purify.settings.getProperty(
            purify.settings.SELF_DESTRUCT_THIRD_PARTY_COOKIES_TIME
          ),
          STEALTH_ACTIONS.THIRD_PARTY_COOKIES
        )
      );
    }

    purify.console.debug(
      "Stealth service processed lookup cookie rules for {0}",
      requestUrl
    );

    return result;
  };

  /**
   * Checks if tab is whitelisted for stealth
   *
   * @param requestUrl
   * @param referrerUrl
   * @param requestType
   * @returns whitelist rule if found
   */
  const findStealthWhitelistRule = function (
    requestUrl,
    referrerUrl,
    requestType
  ) {
    const stealthDocumentWhitelistRule = purify.requestFilter.findStealthWhiteListRule(
      referrerUrl,
      referrerUrl,
      requestType
    );
    if (
      stealthDocumentWhitelistRule &&
      stealthDocumentWhitelistRule.isDocumentWhiteList()
    ) {
      purify.console.debug("Stealth document whitelist rule found.");
      return stealthDocumentWhitelistRule;
    }

    const stealthWhiteListRule = purify.requestFilter.findStealthWhiteListRule(
      requestUrl,
      referrerUrl,
      requestType
    );
    if (stealthWhiteListRule) {
      purify.console.debug("Stealth whitelist rule found.");
      return stealthWhiteListRule;
    }

    return null;
  };

  /**
   * Updates browser privacy.network settings depending on blocking WebRTC or not
   */
  const handleBlockWebRTC = () => {
    // Edge doesn't support privacy api
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy
    if (!browser.privacy) {
      return;
    }

    const resetLastError = () => {
      const ex = browser.runtime.lastError;
      if (ex) {
        purify.console.error(
          "Error updating privacy.network settings: {0}",
          ex
        );
      }
    };

    const webRTCDisabled = getStealthSettingValue(
      purify.settings.BLOCK_WEBRTC
    );

    // Deprecated since Chrome 48
    if (
      typeof browser.privacy.network.webRTCMultipleRoutesEnabled === "object"
    ) {
      if (webRTCDisabled) {
        browser.privacy.network.webRTCMultipleRoutesEnabled.set(
          {
            value: false,
            scope: "regular",
          },
          resetLastError
        );
      } else {
        browser.privacy.network.webRTCMultipleRoutesEnabled.clear(
          {
            scope: "regular",
          },
          resetLastError
        );
      }
    }

    // Since chromium 48
    if (typeof browser.privacy.network.webRTCIPHandlingPolicy === "object") {
      if (webRTCDisabled) {
        browser.privacy.network.webRTCIPHandlingPolicy.set(
          {
            value: "disable_non_proxied_udp",
            scope: "regular",
          },
          resetLastError
        );
      } else {
        browser.privacy.network.webRTCIPHandlingPolicy.clear(
          {
            scope: "regular",
          },
          resetLastError
        );
      }
    }

    if (typeof browser.privacy.network.peerConnectionEnabled === "object") {
      if (webRTCDisabled) {
        browser.privacy.network.peerConnectionEnabled.set(
          {
            value: false,
            scope: "regular",
          },
          resetLastError
        );
      } else {
        browser.privacy.network.peerConnectionEnabled.clear(
          {
            scope: "regular",
          },
          resetLastError
        );
      }
    }
  };

  /**
   * Strips out the tracking codes/parameters from a URL and return the cleansed URL
   *
   * @param requestId
   */
  const removeTrackersFromUrl = (requestId) => {
    if (!getStealthSettingValue(purify.settings.STRIP_TRACKING_PARAMETERS)) {
      return null;
    }

    const context = purify.requestContextStorage.get(requestId);
    if (!context || context.requestType !== purify.RequestTypes.DOCUMENT) {
      return null;
    }

    const { requestUrl, requestType, tab } = context;

    purify.console.debug(
      "Stealth service processing request url for {0}",
      requestUrl
    );

    if (purify.frames.shouldStopRequestProcess(tab)) {
      purify.console.debug("Tab whitelisted or protection disabled");
      return null;
    }

    const mainFrameUrl = purify.frames.getMainFrameUrl(tab);
    if (!mainFrameUrl) {
      // frame wasn't recorded in onBeforeRequest event
      purify.console.debug("Frame was not recorded in onBeforeRequest event");
      return null;
    }

    const whiteListRule = purify.requestFilter.findWhiteListRule(
      requestUrl,
      mainFrameUrl,
      requestType
    );
    if (whiteListRule && whiteListRule.isDocumentWhiteList()) {
      purify.console.debug("Whitelist rule found");
      return null;
    }

    const stealthWhiteListRule = findStealthWhitelistRule(
      requestUrl,
      mainFrameUrl,
      requestType
    );
    if (stealthWhiteListRule) {
      purify.console.debug("Whitelist stealth rule found");
      purify.filteringLog.addHttpRequestEvent(
        tab,
        requestUrl,
        mainFrameUrl,
        requestType,
        stealthWhiteListRule
      );
      return null;
    }

    const urlPieces = requestUrl.split("?");

    // If no params, nothing to modify
    if (urlPieces.length === 1) {
      return null;
    }

    const trackingParameters = purify.settings
      .getProperty(purify.settings.TRACKING_PARAMETERS)
      .trim()
      .split(",")
      .map((x) => x.replace("=", "").replace(/\*/g, "[^&#=]*").trim())
      .filter((x) => x);
    const trackingParametersRegExp = new RegExp(
      "((^|&)(" + trackingParameters.join("|") + ")=[^&#]*)",
      "ig"
    );
    urlPieces[1] = urlPieces[1].replace(trackingParametersRegExp, "");

    // If we've collapsed the URL to the point where there's an '&' against the '?'
    // then we need to get rid of that.
    while (urlPieces[1].charAt(0) === "&") {
      urlPieces[1] = urlPieces[1].substr(1);
    }

    const result = urlPieces[1] ? urlPieces.join("?") : urlPieces[0];

    if (result !== requestUrl) {
      purify.console.debug(
        "Stealth stripped tracking parameters for url: " + requestUrl
      );
      purify.filteringLog.bindStealthActionsToHttpRequestEvent(
        tab,
        STEALTH_ACTIONS.STRIPPED_TRACKING_URL,
        context.eventId
      );

      return result;
    }

    return null;
  };

  const handleWebRTCEnabling = () => {
    purify.utils.browser
      .containsPermissions(["privacy"])
      .then((result) => {
        if (result) {
          return true;
        }
        return purify.utils.browser.requestPermissions(["privacy"]);
      })
      .then((granted) => {
        if (granted) {
          handleBlockWebRTC();
        } else {
          // If privacy permission is not granted set block webrtc value to false
          purify.settings.setProperty(purify.settings.BLOCK_WEBRTC, false);
        }
      })
      .catch((error) => {
        purify.console.error(error);
      });
  };

  const handleWebRTCDisabling = () => {
    purify.utils.browser.containsPermissions(["privacy"]).then((result) => {
      if (result) {
        handleBlockWebRTC();
        return purify.utils.browser.removePermission(["privacy"]);
      }
      return true;
    });
  };

  const handlePrivacyPermissions = () => {
    const webRTCEnabled = getStealthSettingValue(purify.settings.BLOCK_WEBRTC);
    if (webRTCEnabled) {
      handleWebRTCEnabling();
    } else {
      handleWebRTCDisabling();
    }
  };

  /**
   * Browsers api doesn't allow to get optional permissions
   * via chrome.permissions.getAll and we can't check privacy
   * availability via `browser.privacy !== undefined` till permission
   * isn't enabled by the user
   *
   * That's why use edge browser detection
   * Privacy methods are not working at all in the Edge
   * @returns {boolean}
   */
  const canBlockWebRTC = () => {
    return !purify.utils.browser.isEdgeBrowser();
  };

  /**
   * We handle privacy permission only for chromium browsers
   * In the Firefox privacy permission is available by default
   * because they can't be optional there
   * @returns {boolean}
   */
  const shouldHandlePrivacyPermission = () => {
    return purify.utils.browser.isChromium();
  };

  if (canBlockWebRTC()) {
    purify.settings.onUpdated.addListener(function (setting) {
      if (
        setting === purify.settings.BLOCK_WEBRTC ||
        setting === purify.settings.DISABLE_STEALTH_MODE
      ) {
        if (shouldHandlePrivacyPermission()) {
          handlePrivacyPermissions();
        } else {
          handleBlockWebRTC();
        }
      }
    });

    purify.listeners.addListener(function (event) {
      switch (event) {
        case purify.listeners.APPLICATION_INITIALIZED:
          purify.utils.browser
            .containsPermissions(["privacy"])
            .then((result) => {
              if (result) {
                handleBlockWebRTC();
              }
            });
          break;
        default:
          break;
      }
    });
  }

  return {
    processRequestHeaders: processRequestHeaders,
    getCookieRules: getCookieRules,
    removeTrackersFromUrl: removeTrackersFromUrl,
    canBlockWebRTC: canBlockWebRTC,
    STEALTH_ACTIONS,
  };
})(purify);
