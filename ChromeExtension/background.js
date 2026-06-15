const NATIVE_HOST = 'com.truereplayer.native';
const RECONNECT_ALARM = 'truereplayer-reconnect';
const RECONNECT_INTERVAL_MIN = 0.25; // 15 seconds (minimum chrome.alarms allows in practice)

let port = null;
let isRecording = false;
let isBridgeReady = false;
let isOutdated = false;

function connect() {
  if (port) return;

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    isBridgeReady = false;
    updateBadge();

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'bridge:connected':
          isBridgeReady = true;
          isOutdated = false;
          stopReconnect(); // Connected — no need for reconnect alarm
          updateBadge();
          break;

        case 'bridge:expectedVersion': {
          const expected = msg.version;
          const current = chrome.runtime.getManifest().version;
          isOutdated = expected !== current;
          // Send our version back to TrueReplayer
          sendToNative({ type: 'browser:extensionVersion', version: current });
          updateBadge();
          break;
        }

        case 'bridge:disconnected':
          isBridgeReady = false;
          isRecording = false;
          updateBadge();
          // Stop recording in all content scripts
          chrome.tabs.query({}, (tabs) => {
            tabs.forEach((tab) => {
              chrome.tabs.sendMessage(tab.id, {
                type: 'setRecording',
                enabled: false,
              }).catch(() => {});
            });
          });
          break;

        case 'browser:setRecording':
          isRecording = msg.enabled;
          updateBadge();
          chrome.tabs.query({}, (tabs) => {
            tabs.forEach((tab) => {
              chrome.tabs.sendMessage(tab.id, {
                type: 'setRecording',
                enabled: isRecording,
              }).catch(() => {});
            });
          });
          break;

        case 'browser:executeCommand':
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs[0]) {
              sendToNative({
                type: 'browser:commandResult',
                commandId: msg.commandId,
                error: 'No active tab found',
              });
              return;
            }

            // Navigate uses Chrome API directly — works on any page including chrome://newtab
            // Waits for page to fully load before returning success so content script is ready.
            // #7 — Optional postNavigateSelector and urlWaitPattern for richer wait semantics.
            if (msg.command === 'navigate') {
              let url = msg.url;
              if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;

              const navTimeout = Math.max(msg.timeout || 30000, 30000);
              const postSel = msg.postNavigateSelector || '';
              const urlPattern = msg.urlWaitPattern || '';

              const finishOk = () => {
                sendToNative({
                  type: 'browser:commandResult',
                  commandId: msg.commandId,
                  success: true,
                });
              };
              const finishErr = (code, message, tip) => {
                sendToNative({
                  type: 'browser:commandResult',
                  commandId: msg.commandId,
                  error: { code, message, tip: tip || null },
                });
              };

              const runPostChecks = (tabId) => {
                // If neither check is configured, return success immediately
                if (!postSel && !urlPattern) {
                  finishOk();
                  return;
                }
                // Sequential post-checks: urlWaitPattern first (cheap), then postNavigateSelector
                const checkUrl = (cb) => {
                  if (!urlPattern) return cb();
                  chrome.tabs.sendMessage(tabId, {
                    type: 'executeCommand',
                    commandId: msg.commandId + ':wu',
                    command: 'waitUrl',
                    urlPattern,
                    timeout: msg.timeout || 30000, // navTimeout is always >= this, so the old Math.min was a no-op
                  }).then((response) => {
                    if (response?.success) cb();
                    else finishErr(
                      response?.error?.code || 'NAVIGATION_TIMEOUT',
                      response?.error?.message || `URL didn't match pattern.`,
                      response?.error?.tip || 'Check the URL pattern (glob or /regex/).'
                    );
                  }).catch((err) => {
                    finishErr('NAVIGATION_TIMEOUT', err?.message || 'URL wait failed.', null);
                  });
                };
                const checkSel = () => {
                  if (!postSel) {
                    finishOk();
                    return;
                  }
                  chrome.tabs.sendMessage(tabId, {
                    type: 'executeCommand',
                    commandId: msg.commandId + ':ws',
                    command: 'waitElement',
                    selector: postSel,
                    timeout: msg.timeout || 30000, // navTimeout is always >= this, so the old Math.min was a no-op
                  }).then((response) => {
                    if (response?.success) finishOk();
                    else finishErr(
                      response?.error?.code || 'ELEMENT_NOT_FOUND',
                      response?.error?.message || 'Post-navigation element not found.',
                      response?.error?.tip || 'Check the selector or extend the timeout.'
                    );
                  }).catch((err) => {
                    finishErr('ELEMENT_NOT_FOUND', err?.message || 'Post-navigation wait failed.', null);
                  });
                };
                checkUrl(checkSel);
              };

              const waitForLoad = (targetTabId) => {
                let onUpdated = null;
                let fallback = null;
                let done = false;

                const finalize = () => {
                  if (done) return;
                  done = true;
                  if (onUpdated) chrome.tabs.onUpdated.removeListener(onUpdated);
                  if (fallback) clearTimeout(fallback);
                  setTimeout(() => runPostChecks(targetTabId), 300);
                };

                // Require a real load to START ('loading') before accepting 'complete'. Without
                // this, a tab already at 'complete' (same-URL re-navigation or a fast cache hit)
                // can fire an early 'complete' and run post-checks against the OLD document. If no
                // fresh load starts, the fallback timeout below reports the failure.
                let sawLoading = false;
                onUpdated = (updatedTabId, changeInfo) => {
                  if (updatedTabId !== targetTabId) return;
                  if (changeInfo.status === 'loading') { sawLoading = true; return; }
                  if (changeInfo.status === 'complete' && sawLoading) {
                    finalize();
                  }
                };
                chrome.tabs.onUpdated.addListener(onUpdated);

                // Real timeout: report failure instead of silent success
                fallback = setTimeout(() => {
                  if (done) return;
                  done = true;
                  if (onUpdated) chrome.tabs.onUpdated.removeListener(onUpdated);
                  finishErr('NAVIGATION_TIMEOUT',
                    `Page didn't finish loading after ${Math.round(navTimeout / 1000)}s.`,
                    'Site is slow or unreachable. Increase timeout or check connection.');
                }, navTimeout);
              };

              if (msg.newTab) {
                chrome.tabs.create({ url, active: true }, (tab) => {
                  if (chrome.runtime.lastError || !tab) {
                    finishErr('NAVIGATION_FAILED',
                      `Couldn't open a new tab: ${chrome.runtime.lastError?.message || 'unknown error'}`,
                      'Check the URL and the extension\'s tab permissions.');
                    return;
                  }
                  waitForLoad(tab.id);
                });
              } else {
                waitForLoad(tabs[0].id);
                chrome.tabs.update(tabs[0].id, { url });
              }
              return;
            }

            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'executeCommand',
              commandId: msg.commandId,
              command: msg.command,
              selector: msg.selector,
              text: msg.text,
              url: msg.url,
              timeout: msg.timeout,
              // Forward new fields (extension 1.3.0)
              waitMode: msg.waitMode,
              urlWaitPattern: msg.urlWaitPattern,
              postNavigateSelector: msg.postNavigateSelector,
              typeAppend: msg.typeAppend,
              typePaste: msg.typePaste,
              typeDelay: msg.typeDelay,
              // BrowserSelectOption — without this forward, content.js falls back to
              // 'text' matching and "Match by Value/Index" silently misbehaves.
              selectMatchMode: msg.selectMatchMode,
            }).then((response) => {
              // Forward response — preserves response.success and response.error (object form)
              sendToNative({
                type: 'browser:commandResult',
                commandId: msg.commandId,
                ...response,
              });
            }).catch((err) => {
              sendToNative({
                type: 'browser:commandResult',
                commandId: msg.commandId,
                error: { code: 'EXTENSION_ERROR', message: err.message || 'Failed to execute command', tip: null },
              });
            });
          });
          break;

        case 'browser:pickElement':
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs[0]) {
              sendToNative({
                type: 'browser:pickResult',
                requestId: msg.requestId,
                selector: null,
                alternatives: [],
              });
              return;
            }
            chrome.tabs.sendMessage(tabs[0].id, { type: 'pickElement' }).then((response) => {
              sendToNative({
                type: 'browser:pickResult',
                requestId: msg.requestId,
                selector: response?.selector || null,
                alternatives: response?.alternatives || [],
              });
            }).catch(() => {
              sendToNative({
                type: 'browser:pickResult',
                requestId: msg.requestId,
                selector: null,
                alternatives: [],
              });
            });
          });
          break;

        case 'browser:cancelPick':
          // App asked to abort an in-progress element pick (editor switched/closed).
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'cancelPick' }).catch(() => {});
          });
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      isRecording = false;
      isBridgeReady = false;
      updateBadge();
      // Stop recording in all content scripts
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs.sendMessage(tab.id, {
            type: 'setRecording',
            enabled: false,
          }).catch(() => {});
        });
      });
      // NativeHost process died — schedule reconnect via alarm (survives service worker dormancy)
      scheduleReconnect();
    });
  } catch (e) {
    port = null;
    isBridgeReady = false;
    updateBadge();
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  // chrome.alarms survives service worker going dormant, unlike setTimeout
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_INTERVAL_MIN });
}

function stopReconnect() {
  chrome.alarms.clear(RECONNECT_ALARM);
}

// Alarm handler — wakes service worker to retry connection
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !port) {
    connect();
  }
});

function sendToNative(msg) {
  if (port && isBridgeReady) {
    try {
      port.postMessage(msg);
    } catch (e) {
      console.error('[TrueReplayer] Send error:', e);
    }
  } else {
    // Don't drop silently — a message arriving before the bridge is ready (or after it
    // disconnected) is worth a breadcrumb when debugging "recording captured nothing".
    console.warn('[TrueReplayer] Dropped message (bridge not ready):', msg && msg.type);
  }
}

function updateBadge() {
  if (isOutdated && !isRecording) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#fb923c' });
  } else if (isBridgeReady) {
    chrome.action.setBadgeText({ text: isRecording ? 'REC' : 'ON' });
    chrome.action.setBadgeBackgroundColor({
      color: isRecording ? '#C42B1C' : '#0E7A0D',
    });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Trust only this extension's own messages (defence-in-depth — onMessage already filters to
  // same-extension senders), and require a tab context for the recording message types so they
  // can't be spoofed from a non-content-script sender. getStatus (from the popup) has no tab.
  if (!msg || sender.id !== chrome.runtime.id) return;
  const RECORDING_TYPES = ['elementClicked', 'typingCaptured', 'selectInteractionStart',
    'selectInteractionEnd', 'selectChanged', 'commandResult'];
  if (RECORDING_TYPES.includes(msg.type) && !sender.tab) return;
  if (msg.type === 'elementClicked' && isRecording) {
    sendToNative({
      type: 'browser:elementClicked',
      selector: msg.selector,
      description: msg.description,
      tagName: msg.tagName,
      button: msg.button || 'left',
      isInput: msg.isInput || false,
      url: sender.tab?.url || '',
    });
    sendResponse({ ok: true });
  } else if (msg.type === 'typingCaptured' && isRecording) {
    // #10 — Typing in an input was observed; bridge fills the BrowserType action's text
    sendToNative({
      type: 'browser:typingCaptured',
      selector: msg.selector,
      text: msg.text || '',
      isAppend: !!msg.isAppend,
    });
    sendResponse({ ok: true });
  } else if (msg.type === 'selectInteractionStart' && isRecording) {
    // Tells the bridge to suppress native click recording until end / change / timeout.
    sendToNative({ type: 'browser:selectInteractionStart' });
    sendResponse({ ok: true });
  } else if (msg.type === 'selectInteractionEnd' && isRecording) {
    // <select> blurred without firing change — user cancelled the interaction.
    sendToNative({ type: 'browser:selectInteractionEnd' });
    sendResponse({ ok: true });
  } else if (msg.type === 'selectChanged' && isRecording) {
    // Native <select> value changed during recording — bridge creates a
    // BrowserSelectOption action targeting the select with the picked option's text.
    sendToNative({
      type: 'browser:selectChanged',
      selector: msg.selector,
      description: msg.description || '',
      selectedValue: msg.selectedValue || '',
      selectedText: msg.selectedText || '',
      selectedIndex: msg.selectedIndex ?? 0,
      url: sender.tab?.url || '',
    });
    sendResponse({ ok: true });
  } else if (msg.type === 'commandResult') {
    sendToNative({
      type: 'browser:commandResult',
      commandId: msg.commandId,
      success: msg.success,
      error: msg.error,
    });
    sendResponse({ ok: true });
  } else if (msg.type === 'getStatus') {
    sendResponse({
      connected: isBridgeReady,
      recording: isRecording,
      outdated: isOutdated,
    });
  }
  return true;
});

// Ensure connection on all service worker lifecycle events
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

// Start connection immediately when script loads
connect();
