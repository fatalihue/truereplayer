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
          // A run is BOUND to one tab. msg.tabId is the tab the run already used (the native side
          // owns it — a service worker is evicted when idle, so a pin kept here would evaporate).
          // Only the FIRST command of a run resolves the active tab; the rest reuse it, so moving
          // focus mid-run can no longer redirect the macro to another page.
          //
          // When the pinned tab is gone we fail LOUDLY. Falling back to the active tab would
          // silently restore the exact bug this exists to prevent, on the one occasion the user is
          // least likely to notice.
          const withTab = (cb) => {
            if (typeof msg.tabId === 'number') {
              chrome.tabs.get(msg.tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                  sendToNative({
                    type: 'browser:commandResult',
                    commandId: msg.commandId,
                    error: {
                      code: 'TAB_GONE',
                      message: 'The tab this run was acting on has been closed.',
                      tip: 'The macro stays on the tab it started on. Reopen the page and run it again.',
                    },
                  });
                  return;
                }
                cb([tab]);
              });
              return;
            }
            chrome.tabs.query({ active: true, currentWindow: true }, cb);
          };
          withTab((tabs) => {
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
              // Only a BARE host gets the https:// courtesy. The old test was "does it start with
              // http(s)://", so anything else was prefixed wholesale — "about:blank" became
              // "https://about:blank" and "file:///C:/x.html" became "https://file:///C:/x.html",
              // addresses Chrome rejects. Combined with the missing tabs.update callback below,
              // the rejection was SILENT: nothing navigated, the load watcher sat there, and 30 s
              // later the step blamed the network for what was a malformed URL field.
              // The scheme test requires a non-digit after the colon so "localhost:3000" is still
              // read as host:port and still gets prefixed.
              if (url && !/^[a-z][a-z0-9+.-]*:(\/\/|[^0-9])/i.test(url)) url = 'https://' + url;

              // Honour a timeout the user actually set; only fall back to 30 s when the action
              // carries none. The old floor of 30 s meant the Timeout field on a BrowserNavigate
              // was a one-way promise: raising it worked, lowering it did nothing, so an action
              // set to 3 s still sat for thirty. Measured while chasing the data: URL hang.
              const navTimeout = msg.timeout > 0 ? msg.timeout : 30000;

              const postSel = msg.postNavigateSelector || '';
              const urlPattern = msg.urlWaitPattern || '';

              // Navigate RE-PINS: it reports the tab it actually navigated, which is a brand-new
              // one when the action opened a tab. Without this the run would stay bound to the
              // tab it started on and every following step would act on the wrong page.
              const finishOk = (usedTabId) => {
                chrome.tabs.get(usedTabId, (t) => {
                  sendToNative({
                    type: 'browser:commandResult',
                    commandId: msg.commandId,
                    success: true,
                    tabId: usedTabId,
                    tabUrl: (!chrome.runtime.lastError && t && t.url) ? t.url : null,
                  });
                });
              };
              // Same page-reporting contract as finishOk. For a navigate that failed, where the
              // browser ACTUALLY ended up IS the diagnosis — a redirect to a login page and a slow
              // page are the same NAVIGATION_TIMEOUT otherwise. The tab id is optional because one
              // caller genuinely has no tab: the one where creating it is what failed.
              const finishErr = (code, message, tip, usedTabId) => {
                const send = (tabUrl) => sendToNative({
                  type: 'browser:commandResult',
                  commandId: msg.commandId,
                  error: { code, message, tip: tip || null },
                  tabUrl: tabUrl || null,
                });
                if (typeof usedTabId !== 'number') { send(null); return; }
                chrome.tabs.get(usedTabId, (t) => send((!chrome.runtime.lastError && t && t.url) ? t.url : null));
              };

              // Refuse the two schemes that execute in the page context, before handing them to
              // tabs.update. content.js's own navigate fallback already refuses exactly these as an
              // XSS sink; this path never did, and that was not only an inconsistency, it HUNG:
              // measured, a data: URL is neither rejected by tabs.update (no lastError, so the
              // callback below never fires) nor does it produce a loading→complete cycle, so the
              // watcher runs the FULL navTimeout — floored at 30 s no matter how short a timeout the
              // action asked for — and then reports it as a slow site. javascript: is refused by
              // Chrome itself, fast and by name; it is listed here so this reads as one rule rather
              // than an accident of which scheme Chrome happens to police.
              // Placed after finishErr rather than beside the URL normalisation above because
              // finishErr is a const arrow function — calling it earlier is a temporal-dead-zone
              // ReferenceError, which would turn a clean refusal into a broken command.
              if (/^\s*(javascript|data):/i.test(url || '')) {
                const scheme = /^\s*javascript:/i.test(url) ? 'javascript:' : 'data:';
                finishErr('INVALID_URL', `Refusing to navigate to a ${scheme} URL.`,
                  'Use an http:// or https:// address.');
                return;
              }

              const runPostChecks = (tabId) => {
                // If neither check is configured, return success immediately
                if (!postSel && !urlPattern) {
                  finishOk(tabId);
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
                    timeout: msg.timeout || 30000, // same budget as navTimeout above, so no clamp is needed here
                  }).then((response) => {
                    if (response?.success) cb();
                    else finishErr(
                      response?.error?.code || 'NAVIGATION_TIMEOUT',
                      response?.error?.message || `URL didn't match pattern.`,
                      response?.error?.tip || 'Check the URL pattern (glob or /regex/).',
                      tabId
                    );
                  }).catch((err) => {
                    finishErr('NAVIGATION_TIMEOUT', err?.message || 'URL wait failed.', null, tabId);
                  });
                };
                const checkSel = () => {
                  if (!postSel) {
                    finishOk(tabId);
                    return;
                  }
                  chrome.tabs.sendMessage(tabId, {
                    type: 'executeCommand',
                    commandId: msg.commandId + ':ws',
                    command: 'waitElement',
                    selector: postSel,
                    timeout: msg.timeout || 30000, // same budget as navTimeout above, so no clamp is needed here
                  }).then((response) => {
                    if (response?.success) finishOk(tabId);
                    else finishErr(
                      response?.error?.code || 'ELEMENT_NOT_FOUND',
                      response?.error?.message || 'Post-navigation element not found.',
                      response?.error?.tip || 'Check the selector or extend the timeout.',
                      tabId
                    );
                  }).catch((err) => {
                    finishErr('ELEMENT_NOT_FOUND', err?.message || 'Post-navigation wait failed.', null, tabId);
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
                  // The 300 ms is settle time for the NEW document's content script to come up,
                  // which only matters when something is about to talk to it. With no post-checks
                  // runPostChecks just calls finishOk and returns, so every plain BrowserNavigate
                  // was sleeping 300 ms to do nothing.
                  if (!postSel && !urlPattern) { runPostChecks(targetTabId); return; }
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
                    'Site is slow or unreachable. Increase timeout or check connection.',
                    targetTabId);
                }, navTimeout);

                // Abort handle for the caller: when the navigation never even STARTS, the watcher
                // has to be torn down or it would report its own NAVIGATION_TIMEOUT 30 s after the
                // real error was already sent.
                return () => {
                  if (done) return;
                  done = true;
                  if (onUpdated) chrome.tabs.onUpdated.removeListener(onUpdated);
                  if (fallback) clearTimeout(fallback);
                };
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
                const targetId = tabs[0].id;
                // Watcher armed BEFORE the update so the 'loading' status can't slip past it, and
                // torn down by abortWait if the update itself is refused. chrome.tabs.create above
                // already checks lastError this way; the same-tab branch simply never did, so an
                // address Chrome would not accept produced no error at all — just a 30 s wait.
                const abortWait = waitForLoad(targetId);
                chrome.tabs.update(targetId, { url }, () => {
                  if (!chrome.runtime.lastError) return;
                  abortWait();
                  finishErr('NAVIGATION_FAILED',
                    `Couldn't navigate to "${url}": ${chrome.runtime.lastError.message}`,
                    'Check the URL field — Chrome refused this address.',
                    targetId);
                });
              }
              return;
            }

            // A content script only exists on pages Chrome lets us inject into. On a chrome://,
            // chrome-extension:// or Web Store tab — or a tab that simply has not finished
            // injecting yet — sendMessage rejects with "Could not establish connection. Receiving
            // end does not exist", which names neither the cause nor the page. Say which page it
            // was and what to do, and retry once for the injection race.
            const targetTab = tabs[0];
            const canHostScript = /^(https?|file):/i.test(targetTab.url || '');
            const pageLabel = targetTab.url ? targetTab.url.slice(0, 120) : '(unknown page)';
            if (!canHostScript) {
              sendToNative({
                type: 'browser:commandResult',
                commandId: msg.commandId,
                error: {
                  code: 'NO_CONTENT_SCRIPT',
                  message: `Chrome's active tab is ${pageLabel}, which extensions cannot act on.`,
                  tip: 'Browser actions run on whichever tab is active. Click the tab with your page first, then run the macro.',
                },
                // Also as a field, not only inside the prose: the run report translates known
                // error codes and shows the translation INSTEAD of this message, so the page named
                // above disappears from the one place the user goes looking for it.
                tabUrl: targetTab.url || null,
              });
              return;
            }

            // Forward EVERYTHING, then override the type. This used to be rebuilt field by field,
            // 14 keys copied by hand, and that list is a standing trap: any new field added on the
            // C# side arrives here, is silently dropped, and the command runs with a default nobody
            // chose. It has already happened once — selectMatchMode was missing from this object
            // from the day the field shipped, so "Match by Value/Index" quietly fell back to text
            // matching, in a way that looks exactly like a wrong option label.
            // Key order matters: the spread must come FIRST, or msg.type ('browser:executeCommand')
            // would win and content.js's switch would fall through to its default. The extra keys
            // that ride along (tabId, newTab) are inert — executeCommand destructures what it wants.
            const relay = { ...msg, type: 'executeCommand' };

            const forward = (response) => {
              // Forward response — preserves response.success and response.error (object form).
              // tabId binds the run to this tab from here on; tabUrl is recorded per step in the
              // run report, so a macro that acted on the wrong page is visible after the fact
              // instead of leaving the user to guess.
              sendToNative({
                type: 'browser:commandResult',
                commandId: msg.commandId,
                ...response,
                tabId: targetTab.id,
                tabUrl: targetTab.url || null,
              });
            };
            // "Receiving end does not exist" on an http(s) tab means the content script has not
            // finished injecting — a race, not a dead end, so it is worth retrying. Any other
            // rejection is reported as-is; retrying it would only delay the real answer.
            //
            // Do NOT widen this regex. It is safe to retry PRECISELY because these two messages
            // mean the message was never delivered. "The message port closed before a response was
            // received" looks similar and is the opposite: the content script GOT it and may have
            // already run it (a click that navigates does exactly this), so retrying would execute
            // the action twice.
            const isInjectionRace = (err) =>
              /Receiving end does not exist|Could not establish connection/i.test(err?.message || '');

            // ── Fan-out vs. frame 0 ──────────────────────────────────────────────────────────
            // A correctness switch, not an optimisation, and deliberately NARROW.
            //
            // tabs.sendMessage without frameId delivers to EVERY frame and the FIRST reply wins.
            // For a normal positive wait that is not just harmless, it is load-bearing: a frame
            // that does not match stays SILENT until its own timeout expires, so the frame that
            // does match answers first, deterministically — and it is the only reason a
            // hand-typed selector pointing inside an iframe works at all. Sending everything to
            // frame 0 would turn those from "works" into ELEMENT_NOT_FOUND.
            //
            // Two shapes break that guarantee, because in them a NON-matching frame answers
            // instantly and wins the race:
            //   • timeout <= 0 (the If probe) — content.js short-circuits and rejects on the same
            //     tick, so any iframe can beat the main frame's {success:true} and flip an
            //     If BrowserElementState to the wrong branch, intermittently.
            //   • waitMode 'disappears' — checkDisappears runs before any observer and returns
            //     TRUE for a frame that never had the element, so "wait for the spinner to go"
            //     passes while the spinner is still on screen. Any page with one content-script
            //     iframe is enough.
            // Only those two are pinned to the main frame.
            const isInstantProbe = typeof msg.timeout === 'number' && msg.timeout <= 0;
            const isDisappears = msg.waitMode === 'disappears';
            const mainFrameOnly = isInstantProbe || isDisappears;
            const sendRelay = () => mainFrameOnly
              ? chrome.tabs.sendMessage(targetTab.id, relay, { frameId: 0 })
              : chrome.tabs.sendMessage(targetTab.id, relay);

            // Content scripts inject at document_idle, which on a real page lands anywhere from
            // 500 ms to several seconds after the navigation commits. A single 300 ms retry
            // therefore lost the race routinely — and the natural fix a user reaches for, putting
            // a BrowserWaitElement in front, does not help: the Wait travels through this same
            // funnel and fails the same way. So retry on a short cadence.
            //
            // The budget is CAPPED rather than taken from the action's timeout, for two reasons.
            // (1) `timeout: 0` is the instant If probe declaring it wants an answer now, and
            //     `msg.timeout || 5000` read that deliberate zero as "unset" and handed the one
            //     command that must stay cheap the largest budget of all — past the 3 s pipe
            //     timeout the C# probe gives itself, so its NO_CONTENT_SCRIPT reply arrived for a
            //     commandId already dropped and could never be seen. isInstantProbe, computed
            //     above for the frame decision, is the same question, so reuse it.
            // (2) Retrying eats time BEFORE content.js arms its own timer, while the C# grace is a
            //     flat 2 s. Let this window grow with the action timeout and the two clocks invert:
            //     the C# side gives up first and reports "not found" for a step that then runs and
            //     clicks. A ceiling well under that grace keeps the ordering the grace bought.
            const injectBudget = isInstantProbe ? 750 : Math.min(1500, Math.max(1000, msg.timeout || 5000));
            const injectDeadline = Date.now() + injectBudget;
            const attempt = () => {
              // Same frame targeting on every attempt — a retry that fanned out where the original
              // did not would reintroduce the race it was pinned to avoid.
              sendRelay()
                .then(forward)
                .catch((err) => {
                  if (!isInjectionRace(err)) {
                    sendToNative({
                      type: 'browser:commandResult',
                      commandId: msg.commandId,
                      error: { code: 'EXTENSION_ERROR', message: err.message || 'Failed to execute command', tip: null },
                      tabUrl: targetTab.url || null,
                    });
                    return;
                  }
                  if (Date.now() < injectDeadline) {
                    setTimeout(attempt, 250);
                    return;
                  }
                  sendToNative({
                    type: 'browser:commandResult',
                    commandId: msg.commandId,
                    error: {
                      code: 'NO_CONTENT_SCRIPT',
                      message: `No TrueReplayer content script on ${pageLabel}.`,
                      tip: 'Reload that tab and try again. If it was just updated, the extension needs the page reloaded before it can act on it.',
                    },
                    tabUrl: targetTab.url || null,
                  });
                });
            };
            attempt();
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
            // frameId 0 because content.js's startPick already returns early outside the main
            // frame (see its isMainFrame guard). Without this the sub-frames still received the
            // request, set pickResolve, bailed out of startPick and returned true — leaving a
            // message channel open per frame that nothing would ever answer.
            chrome.tabs.sendMessage(tabs[0].id, { type: 'pickElement' }, { frameId: 0 }).then((response) => {
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
      // The content script pushing a result on its own knows its page through `sender`, same as
      // the selectChanged relay just above. One rule everywhere: if the page is known, report it.
      tabUrl: sender.tab?.url || null,
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
