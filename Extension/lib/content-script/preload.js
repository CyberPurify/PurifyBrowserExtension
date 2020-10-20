/**
 * ----------------------------------------------------------------------------------
 * PurifyBrowserExtension preload.js
 * Licensed under MIT (https://github.com/CyberPurify/CyberPurify/blob/main/LICENSE)
 * ----------------------------------------------------------------------------------
 */

/* global contentPage, ExtendedCss, HTMLDocument, XMLDocument, ElementCollapser, CssHitsCounter, purifyContent */
(function () {
  var requestTypeMap = {
    img: "IMAGE",
    input: "IMAGE",
    audio: "MEDIA",
    video: "MEDIA",
    object: "OBJECT",
    frame: "SUBDOCUMENT",
    iframe: "SUBDOCUMENT",
    embed: "OBJECT",
  };

  var collapseRequests = Object.create(null);
  var collapseRequestId = 1;
  var isFirefox = false;
  var isOpera = false;
  var MIN_IMAGE_SIZE = 41;

  /**
   * Unexpectedly global variable contentPage could become undefined in FF,
   * in this case we redefine it.
   *
   * More details:
   * https://github.com/CyberPurify/PurifyBrowserExtension/issues/924
   * https://github.com/CyberPurify/PurifyBrowserExtension/issues/880
   */
  var getContentPage = function () {
    if (typeof contentPage === "undefined") {
      contentPage = {
        sendMessage: purifyContent.runtimeImpl.sendMessage,
        onMessage: purifyContent.runtimeImpl.onMessage,
      };
    }

    return contentPage;
  };

  /**
   * When Background page receives 'onCommitted' frame event then it sends scripts to corresponding frame
   * It allows us to execute script as soon as possible, because runtime.messaging makes huge overhead
   * If onCommitted event doesn't occur for the frame, scripts will be applied in usual way.
   */
  getContentPage().onMessage.addListener(function (
    response,
    sender,
    sendResponse
  ) {
    if (response.type === "injectScripts") {
      // Notify background-page that content-script was received scripts
      sendResponse({ applied: true });
      if (!isHtml()) {
        return;
      }
      applyScripts(response.scripts);
    }
  });

  /**
   * Initializing content script
   */
  var init = function () {
    if (!isHtml()) {
      return;
    }

    initRequestWrappers();

    var userAgent = navigator.userAgent.toLowerCase();
    isFirefox = userAgent.indexOf("firefox") > -1;
    isOpera = userAgent.indexOf("opera") > -1 || userAgent.indexOf("opr") > -1;

    initCollapseEventListeners();
    tryLoadCssAndScripts();

    imageDOMWatcher();
  };

  /**
   * Watch NSFW Content
   */
  const imageDOMWatcher = function () {
    var MutationObserver =
      window.MutationObserver || window.WebKitMutationObserver;

    if (!MutationObserver) {
      return;
    }

    var observer = new MutationObserver(function (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];

        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          if (mutation.target.nodeName === "TITLE") {
            var images = document.getElementsByTagName("img");
            for (let i = 0; i < images.length; i++) {
              analyzeImage(images[i], false);
            }
          }

          for (let i = 0; i < mutation.addedNodes.length; i++) {
            if (mutation.addedNodes[i].nodeName === "IMG") {
              analyzeImage(mutation.addedNodes[i], false);
            }
          }
        } else if (mutation.type === "attributes") {
          if (mutation.target.nodeName === "IMG") {
            analyzeImage(mutation.target, mutation.attributeName === "src");
            mutation.target;
          }
        }
      }
    });

    observer.observe(document, {
      characterData: false,
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  };

  const analyzeImage = function (image, srcAttribute) {
    if (
      image.src.length > 0 &&
      ((image.width > this.MIN_IMAGE_SIZE &&
        image.height > this.MIN_IMAGE_SIZE) ||
        image.height === 0 ||
        image.width === 0)
    ) {
      if (srcAttribute) {
        getPredictImageResult(image);
      } else if (image._isPurified === undefined) {
        getPredictImageResult(image);
      }
    }
  };

  const getPredictImageResult = function (image) {
    image._isPurified = true;
    hideImage(image);
    // console.log(`Analyze ${image.src}`);

    new Promise((resolve, reject) => {
      const request = {
        type: "requestAnalyzeImage",
        requestUrl: image.src,
        originUrl: window.location.href,
      };

      try {
        getContentPage().sendMessage(request, (response) => {
          const { result, requestUrl, err } = response;

          if (!result && !err) {
            showImage(image, requestUrl);
          } else {
            image.style.filter = "blur(100px)";
            showImage(image, requestUrl);
            image.dataset.purify = "nsfw";
          }

          resolve(response);
        });
      } catch (err) {
        console.log(err);
        reject(request);
      }
    });
  };

  const hideImage = function (image) {
    if (image.parentNode?.nodeName === "BODY") {
      image.hidden = true;
    }

    image.dataset.purify = "processing";
    image.style.visibility = "hidden";
  };

  const showImage = function (image, url) {
    if (image.src === url) {
      if (image.parentNode?.nodeName === "BODY") {
        image.hidden = false;
      }

      image.dataset.purify = "sfw";
      image.style.visibility = "visible";
    }
  };

  /**
   * Checks if it is html document
   *
   * @returns {boolean}
   */
  var isHtml = function () {
    return (
      document instanceof HTMLDocument ||
      // https://github.com/CyberPurify/PurifyBrowserExtension/issues/233
      (document instanceof XMLDocument &&
        document.createElement("div") instanceof HTMLDivElement)
    );
  };

  /**
   * Uses in `initRequestWrappers` method.
   * We insert wrapper's code into http/https documents and dynamically created frames.
   * The last one is due to the circumvention with using iframe's contentWindow.
   */
  var isHttpOrAboutPage = function () {
    var protocol = window.location.protocol;
    return protocol.indexOf("http") === 0 || protocol.indexOf("about:") === 0;
  };

  /**
   * Execute several scripts
   * @param {Array<string>} scripts Scripts to execute
   */
  var executeScripts = function (scripts) {
    if (!scripts || scripts.length === 0) {
      return;
    }
    // Wraps with try catch and appends cleanup
    scripts.unshift("( function () { try {");
    scripts.push(
      "} catch (ex) { console.error('Error executing AG js: ' + ex); } })();"
    );

    executeScript(scripts.join("\r\n"));
  };

  /**
   * Execute scripts in a page context and cleanup itself when execution completes
   * @param {string} script Script to execute
   */
  const executeScript = function (script) {
    const scriptTag = document.createElement("script");
    scriptTag.setAttribute("type", "text/javascript");
    scriptTag.textContent = script;

    const parent = document.head || document.documentElement;
    parent.appendChild(scriptTag);
    if (scriptTag.parentNode) {
      scriptTag.parentNode.removeChild(scriptTag);
    }
  };

  /**
   * Overrides window.RTCPeerConnection running the function from wrappers.js
   * https://github.com/CyberPurify/PurifyBrowserExtension/issues/588
   */
  /* global injectPageScriptAPI, initPageMessageListener */
  const initRequestWrappers = function () {
    // Only for dynamically created frames and http/https documents.
    if (!isHttpOrAboutPage()) {
      return;
    }

    /**
     * The code below is supposed to be used in WebExt extensions.
     * This code overrides RTCPeerConnection constructor, so that we could inspect & block them.
     */

    initPageMessageListener();

    const wrapperScriptName =
      "wrapper-script-" + Math.random().toString().substr(2);
    const script = `(${injectPageScriptAPI.toString()})('${wrapperScriptName}', true);`;
    executeScripts([script]);
  };

  /**
   * Loads CSS and JS injections
   */
  var tryLoadCssAndScripts = function () {
    var message = {
      type: "getSelectorsAndScripts",
      documentUrl: window.location.href,
    };

    /**
     * Sending message to background page and passing a callback function
     */
    getContentPage().sendMessage(message, processCssAndScriptsResponse);
  };

  /**
   * Processes response from the background page containing CSS and JS injections
   * @param response Response from the background page
   */
  const processCssAndScriptsResponse = (response) => {
    if (!response || response.requestFilterReady === false) {
      /**
       * This flag (requestFilterReady) means that we should wait for a while, because the
       * request filter is not ready yet. This is possible only on browser startup.
       * In this case we'll delay injections until extension is fully initialized.
       */
      setTimeout(tryLoadCssAndScripts, 100);
      return;
    }

    if (response.collectRulesHits) {
      CssHitsCounter.init((stats) => {
        getContentPage().sendMessage({ type: "saveCssHitStats", stats });
      });
    }

    if (response.collapseAllElements) {
      /**
       * This flag (collapseAllElements) means that we should check all page elements
       * and collapse them if needed. Why? On browser startup we can't block some
       * ad/tracking requests because extension is not yet initialized when
       * these requests are executed. At least we could hide these elements.
       */
      applySelectors(response.selectors);
      applyScripts(response.scripts);
      initBatchCollapse();
    } else {
      applySelectors(response.selectors);
      applyScripts(response.scripts);
    }
  };

  /**
   * Sets "style" DOM element content.
   * @param styleEl       "style" DOM element
   * @param cssContent    CSS content to set
   */
  var setStyleContent = function (styleEl, cssContent) {
    styleEl.textContent = cssContent;
  };

  /**
   * Applies CSS and extended CSS stylesheets
   * @param selectors     Object with the stylesheets got from the background page.
   */
  var applySelectors = function (selectors) {
    if (!selectors) {
      return;
    }

    applyCss(selectors.css);
    applyExtendedCss(selectors.extendedCss);
  };

  /**
   * Applies CSS stylesheets
   *
   * @param css Array with CSS stylesheets
   */
  var applyCss = function (css) {
    if (!css || css.length === 0) {
      return;
    }

    for (var i = 0; i < css.length; i++) {
      var styleEl = document.createElement("style");
      styleEl.setAttribute("type", "text/css");
      setStyleContent(styleEl, css[i]);

      (document.head || document.documentElement).appendChild(styleEl);

      protectStyleElementContent(styleEl);
    }
  };

  /**
   * Applies Extended Css stylesheet
   *
   * @param extendedCss Array with ExtendedCss stylesheets
   */
  var applyExtendedCss = function (extendedCss) {
    if (!extendedCss || !extendedCss.length) {
      return;
    }

    // https://github.com/CyberPurify/ExtendedCss
    window.extcss = new ExtendedCss({
      styleSheet: extendedCss.join("\n"),
      beforeStyleApplied: CssHitsCounter.countAffectedByExtendedCss,
    });
    extcss.apply();
  };

  /**
   * Protects specified style element from changes to the current document
   * Add a mutation observer, which is adds our rules again if it was removed
   *
   * @param protectStyleEl protected style element
   */
  var protectStyleElementContent = function (protectStyleEl) {
    var MutationObserver =
      window.MutationObserver || window.WebKitMutationObserver;
    if (!MutationObserver) {
      return;
    }
    /* observer, which observe protectStyleEl inner changes, without deleting styleEl */
    var innerObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (
          protectStyleEl.hasAttribute("mod") &&
          protectStyleEl.getAttribute("mod") === "inner"
        ) {
          protectStyleEl.removeAttribute("mod");
          break;
        }

        protectStyleEl.setAttribute("mod", "inner");
        var isProtectStyleElModified = false;

        /* further, there are two mutually exclusive situations: either there were changes the text of protectStyleEl,
                 either there was removes a whole child "text" element of protectStyleEl
                 we'll process both of them */

        if (m.removedNodes.length > 0) {
          for (var j = 0; j < m.removedNodes.length; j++) {
            isProtectStyleElModified = true;
            protectStyleEl.appendChild(m.removedNodes[j]);
          }
        } else {
          if (m.oldValue) {
            isProtectStyleElModified = true;
            protectStyleEl.textContent = m.oldValue;
          }
        }

        if (!isProtectStyleElModified) {
          protectStyleEl.removeAttribute("mod");
        }
      }
    });

    innerObserver.observe(protectStyleEl, {
      childList: true,
      characterData: true,
      subtree: true,
      characterDataOldValue: true,
    });
  };

  /**
   * Applies JS injections.
   * @param scripts Array with JS scripts and scriptSource ('remote' or 'local')
   */
  var applyScripts = function (scripts) {
    if (!scripts || scripts.length === 0) {
      return;
    }

    /**
     * JS injections are created by JS filtering rules:
     * http://cyberpurify.com/en/filterrules.html#javascriptInjection
     */
    executeScript(scripts);
  };

  /**
   * Init listeners for error and load events.
   * We will then check loaded elements if they are blocked by our extension.
   * In this case we'll hide these blocked elements.
   */
  var initCollapseEventListeners = function () {
    document.addEventListener("error", checkShouldCollapse, true);

    // We need to listen for load events to hide blocked iframes (they don't raise error event)
    document.addEventListener("load", checkShouldCollapse, true);
  };

  /**
   * Checks if loaded element is blocked by AG and should be hidden
   * @param event Load or error event
   */
  var checkShouldCollapse = function (event) {
    var element = event.target;
    var eventType = event.type;
    var tagName = element.tagName.toLowerCase();

    var expectedEventType =
      tagName === "iframe" || tagName === "frame" || tagName === "embed"
        ? "load"
        : "error";
    if (eventType !== expectedEventType) {
      return;
    }

    checkShouldCollapseElement(element);
  };

  /**
   * Extracts element URL from the dom node
   * @param element DOM node
   */
  var getElementUrl = function (element) {
    var elementUrl = element.src || element.data;
    if (
      !elementUrl ||
      elementUrl.indexOf("http") !== 0 ||
      // Some sources could not be set yet, lazy loaded images or smth.
      // In some cases like on gog.com, collapsing these elements could break the page script loading their sources
      elementUrl === element.baseURI
    ) {
      return null;
    }

    // truncate too long urls
    // https://github.com/CyberPurify/PurifyBrowserExtension/issues/1493
    const MAX_URL_LENGTH = 16 * 1024;
    if (elementUrl.length > MAX_URL_LENGTH) {
      elementUrl = elementUrl.slice(0, MAX_URL_LENGTH);
    }

    return elementUrl;
  };

  /**
   * Saves collapse request (to be reused after we get result from bg page)
   * @param element Element to check
   * @return request ID
   */
  var saveCollapseRequest = function (element) {
    var tagName = element.tagName.toLowerCase();
    var requestId = collapseRequestId++;
    collapseRequests[requestId] = {
      element: element,
      src: element.src,
      tagName: tagName,
    };

    return requestId;
  };

  /**
   * Response callback for "processShouldCollapse" message.
   * @param response Response got from the background page
   */
  var onProcessShouldCollapseResponse = function (response) {
    if (!response) {
      return;
    }

    // Get original collapse request
    var collapseRequest = collapseRequests[response.requestId];
    if (!collapseRequest) {
      return;
    }
    delete collapseRequests[response.requestId];

    var element = collapseRequest.element;
    if (response.collapse === true) {
      var elementUrl = collapseRequest.src;
      ElementCollapser.collapseElement(element, elementUrl);
    }
  };

  /**
   * Checks if element is blocked by AG and should be hidden
   * @param element Element to check
   */
  var checkShouldCollapseElement = function (element) {
    var requestType = requestTypeMap[element.localName];
    if (!requestType) {
      return;
    }

    var elementUrl = getElementUrl(element);
    if (!elementUrl) {
      return;
    }

    if (ElementCollapser.isCollapsed(element)) {
      return;
    }

    // Save request to a map (it will be used in response callback)
    var requestId = saveCollapseRequest(element);

    // Send a message to the background page to check if the element really should be collapsed
    var message = {
      type: "processShouldCollapse",
      elementUrl: elementUrl,
      documentUrl: document.URL,
      requestType: requestType,
      requestId: requestId,
    };

    getContentPage().sendMessage(message, onProcessShouldCollapseResponse);
  };

  /**
   * Response callback for "processShouldCollapseMany" message.
   * @param response Response from bg page.
   */
  var onProcessShouldCollapseManyResponse = function (response) {
    if (!response) {
      return;
    }

    var requests = response.requests;
    for (var i = 0; i < requests.length; i++) {
      var collapseRequest = requests[i];
      onProcessShouldCollapseResponse(collapseRequest);
    }
  };

  /**
   * Collects all elements from the page and checks if we should hide them.
   */
  var checkBatchShouldCollapse = function () {
    var requests = [];

    // Collect collapse requests
    for (var tagName in requestTypeMap) {
      // jshint ignore:line
      var requestType = requestTypeMap[tagName];

      var elements = document.getElementsByTagName(tagName);
      for (var j = 0; j < elements.length; j++) {
        var element = elements[j];
        var elementUrl = getElementUrl(element);
        if (!elementUrl) {
          continue;
        }

        var requestId = saveCollapseRequest(element);

        requests.push({
          elementUrl: elementUrl,
          requestType: requestType,
          requestId: requestId,
          tagName: tagName,
        });
      }
    }

    var message = {
      type: "processShouldCollapseMany",
      requests: requests,
      documentUrl: document.URL,
    };

    // Send all prepared requests in one message
    getContentPage().sendMessage(message, onProcessShouldCollapseManyResponse);
  };

  /**
   * This method is used when we need to check all page elements with collapse rules.
   * We need this when the browser is just started and add-on is not yet initialized.
   * In this case content scripts waits for add-on initialization and the
   * checks all page elements.
   */
  var initBatchCollapse = function () {
    if (
      document.readyState === "complete" ||
      document.readyState === "loaded" ||
      document.readyState === "interactive"
    ) {
      checkBatchShouldCollapse();
    } else {
      document.addEventListener("DOMContentLoaded", checkBatchShouldCollapse);
    }
  };

  /**
   * Called when document become visible.
   * https://github.com/CyberPurify/PurifyBrowserExtension/issues/159
   */
  var onVisibilityChange = function () {
    if (document.hidden === false) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      init();
    }
  };

  // Start the content script
  init();
})();
