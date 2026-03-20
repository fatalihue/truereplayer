const NATIVE_HOST = 'com.truereplayer.native';

let port = null;
let isRecording = false;
let isBridgeReady = false;
let reconnectDelay = 3000;
const MAX_RECONNECT_DELAY = 60000;

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
          reconnectDelay = 3000; // Reset backoff on successful connection
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
              const tabId = tabs[0].id;
              const onUpdated = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(onUpdated);
                  // Small delay to ensure content script is injected and ready
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
              chrome.tabs.update(tabId, { url });
              // Timeout fallback in case onUpdated never fires
              setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                sendToNative({
                  type: 'browser:commandResult',
                  commandId: msg.commandId,
                  success: true,
                });
              }, 30000);
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
      // NativeHost process died — reconnect with backoff
      // If bridge was ready before, NativeHost worked → TrueReplayer probably restarted → fast retry
      // If bridge was never ready, pipe wasn't found → increase backoff
      if (!wasBridgeReady) {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      }
      setTimeout(connect, reconnectDelay);
    });
  } catch (e) {
    port = null;
    isBridgeReady = false;
    updateBadge();
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    setTimeout(connect, reconnectDelay);
  }
}

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
