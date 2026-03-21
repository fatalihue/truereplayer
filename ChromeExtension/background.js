const NATIVE_HOST = 'com.truereplayer.native';
const RECONNECT_ALARM = 'truereplayer-reconnect';
const RECONNECT_INTERVAL_MIN = 0.25; // 15 seconds (minimum chrome.alarms allows in practice)

let port = null;
let isRecording = false;
let isBridgeReady = false;

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
          stopReconnect(); // Connected — no need for reconnect alarm
          updateBadge();
          break;

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
            // Waits for page to fully load before returning success so content script is ready
            if (msg.command === 'navigate') {
              let url = msg.url;
              if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;

              const waitForLoad = (targetTabId) => {
                const onUpdated = (updatedTabId, changeInfo) => {
                  if (updatedTabId === targetTabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    clearTimeout(fallback);
                    setTimeout(() => {
                      sendToNative({
                        type: 'browser:commandResult',
                        commandId: msg.commandId,
                        success: true,
                      });
                    }, 300);
                  }
                };
                chrome.tabs.onUpdated.addListener(onUpdated);
                const fallback = setTimeout(() => {
                  chrome.tabs.onUpdated.removeListener(onUpdated);
                  sendToNative({
                    type: 'browser:commandResult',
                    commandId: msg.commandId,
                    success: true,
                  });
                }, 30000);
              };

              if (msg.newTab) {
                chrome.tabs.create({ url, active: true }, (tab) => {
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
            }).then((response) => {
              sendToNative({
                type: 'browser:commandResult',
                commandId: msg.commandId,
                success: true,
                ...response,
              });
            }).catch((err) => {
              sendToNative({
                type: 'browser:commandResult',
                commandId: msg.commandId,
                error: err.message || 'Failed to execute command',
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
              });
              return;
            }
            chrome.tabs.sendMessage(tabs[0].id, { type: 'pickElement' }).then((response) => {
              sendToNative({
                type: 'browser:pickResult',
                requestId: msg.requestId,
                selector: response?.selector || null,
              });
            }).catch(() => {
              sendToNative({
                type: 'browser:pickResult',
                requestId: msg.requestId,
                selector: null,
              });
            });
          });
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      const wasBridgeReady = isBridgeReady;
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
  }
}

function updateBadge() {
  if (isBridgeReady) {
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
    });
  }
  return true;
});

// Ensure connection on all service worker lifecycle events
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

// Start connection immediately when script loads
connect();
