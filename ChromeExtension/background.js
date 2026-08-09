const NATIVE_HOST = 'com.truereplayer.native';
const RECONNECT_ALARM = 'truereplayer-reconnect';
// Reconnect backoff. The floor is what MV3 actually honours: chrome.alarms clamps to 30 s, so the
// old 0.25 (documented as "15 seconds") was already being served as 30 s.
//
// Why a backoff at all: with TrueReplayer closed the cycle is fixed and endless — alarm, connect(),
// connectNative spawns the host process, the host fails to find the pipe and exits, onDisconnect,
// schedule again. A user who installed the extension and is not running the app paid a process
// spawn every half minute, forever.
//
// The ceiling is deliberately low. A long backoff trades one annoyance for a worse one: the app
// finally starts and the extension takes until the next alarm to notice. Two minutes cuts the
// spawn rate by 4x while keeping the worst-case blind window short, and opening the popup resets
// the ramp and retries at once — someone looking at the badge has almost certainly just started
// the app.
const RECONNECT_MIN_MINUTES = 0.5;
const RECONNECT_MAX_MINUTES = 2;
// Kept in storage.session, not a module variable: the service worker is torn down between alarms,
// so a plain counter would reset to zero on every wake and there would be no ramp at all. Session
// storage also clears itself when the browser restarts, which is the right moment to be eager again.
const RECONNECT_ATTEMPTS_KEY = 'reconnectAttempts';

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
                  // frameId 0: this asks whether the TAB finished navigating, and only the main
                  // frame's location is the tab's location. Fanned out, an iframe whose own URL
                  // happens to match the pattern — a same-site widget, an analytics frame — answers
                  // first and reports the navigation done while the page is still on the old URL.
                  // Unlike postNavigateSelector below, there is no reading of this field where an
                  // iframe's URL is the intended answer, so nothing legitimate is lost by pinning.
                  chrome.tabs.sendMessage(tabId, {
                    type: 'executeCommand',
                    commandId: msg.commandId + ':wu',
                    command: 'waitUrl',
                    urlPattern,
                    timeout: msg.timeout || 30000, // same budget as navTimeout above, so no clamp is needed here
                  }, { frameId: 0 }).then((response) => {
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

            // ── …and the half the note above does not cover: two frames that BOTH match ──────
            // Everything above reasons about frames that do NOT match, where the reply race is
            // sound. What it cannot fix is that a frame receiving a command does not merely
            // REPLY to it — it EXECUTES it. One reply wins the race and gets reported; the click
            // already happened in every frame that matched, and the macro looks like it worked.
            //
            // This needs no attacker and no exotic page. Stripe Elements' card field is
            // input[name="cardnumber"]; embedded forms, chat widgets and login iframes routinely
            // carry #email, #username, button[type=submit]. A BrowserType then types its text —
            // which may be a password, a token, or resolved {clipboard} content — into every one
            // of those fields. Typing a secret into N frames is not a degraded version of the
            // intent; it is never the intent.
            //
            // Pinning the mutating commands to frame 0 would fix it and would break exactly the
            // subframe selectors the note above exists to protect. So the command is split in
            // two instead:
            //   1. LOCATE — content.js's read-only 'locateFrame' probe fans out precisely as
            //      before, keeps the silence property (a frame that does not match stays quiet
            //      until its own timeout), and replies with nothing but its own frameId.
            //   2. EXECUTE — the real command, unchanged, sent to that ONE frame.
            // The added cost is a single message hop AFTER the element is already found, not a
            // fixed delay: the probe answers on the same tick the old fan-out would have started
            // acting. What it buys is that "which frame acts" stops being whichever frame's reply
            // happened to arrive first, and becomes a decision this code makes on purpose.
            //
            // The list below is a DENYLIST of the commands known not to touch the page, so a
            // command added later is treated as mutating by default. Being wrong that way costs
            // one extra message hop; being wrong the other way puts a password in three frames.
            // ('navigate' never reaches here — it returns above — but it belongs on the list as
            // the statement of which commands are reads, not as a live branch.)
            const READ_ONLY_COMMANDS = ['waitElement', 'waitUrl', 'navigate'];
            const needsElection = !mainFrameOnly && !READ_ONLY_COMMANDS.includes(msg.command);

            // Tie-break toward frame 0 when a SUBFRAME answers the probe. Silence settles ties
            // only while at most one frame matches; when two match they both answer on the same
            // tick and the winner is Chrome's frame dispatch order, which is not a decision
            // either. Frame 0 is the right default because recording is guarded by isMainFrame:
            // every RECORDED selector was captured in the main frame, so a subframe match on one
            // is a lookalike, not the target. A hand-typed subframe selector still wins — frame 0
            // simply does not match — and pays this grace once, only on the actions that use it.
            const FRAME0_GRACE_MS = 150;

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
            // One send, with that retry window around it. `frameId` undefined fans out, a number
            // targets that frame alone; targeting is fixed for the life of a dispatch, because a
            // retry that fanned out where the original did not would reintroduce the race it was
            // pinned to avoid. Each dispatch opens its own window — the second half of an elected
            // command talks to a frame that answered a millisecond ago, so in practice it never
            // spends any of it, and it must not inherit a window the first half already burned.
            const dispatch = (message, frameId, onResponse) => {
              const deadline = Date.now() + injectBudget;
              const attempt = () => {
                const sent = typeof frameId === 'number'
                  ? chrome.tabs.sendMessage(targetTab.id, message, { frameId })
                  : chrome.tabs.sendMessage(targetTab.id, message);
                sent
                  .then(onResponse)
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
                    if (Date.now() < deadline) {
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
            };

            if (!needsElection) {
              dispatch(relay, mainFrameOnly ? 0 : undefined, forward);
              return;
            }

            // Phase 1 — LOCATE. Derived from the relay by REMOVAL, never rebuilt field by field:
            // the hand-copied-object trap the relay comment above describes applies here twice
            // over, because a probe that reads a different field set than the command locates a
            // different element than the command then acts on. `text` is the one deliberate
            // subtraction — it is the payload, no mutating command matches on it, and it is the
            // field that must not be broadcast to frames that are not going to be used.
            const { text: _payload, ...probeBase } = relay;
            const probe = {
              ...probeBase,
              command: 'locateFrame',
              locateFor: relay.command,
              commandId: msg.commandId + ':lf', // same tagging as the navigate post-checks above
            };
            const electionStart = Date.now();

            const execIn = (frameId) => {
              // Phase 2 — EXECUTE, in one frame. The timeout is what is LEFT of the action's
              // budget: the waiting already happened during the probe, and handing this half a
              // fresh full timeout would let a 30 s action run for 60 s — past the flat 2 s grace
              // the C# side allows itself over the timeout it asked for, which is what keeps
              // content.js's timeout classifier the authority on "not found".
              // The floor leaves room to re-acquire the element if the page re-rendered between
              // the halves. That window is the one case where the split can fail where the
              // fan-out would not have, and it fails LOUDLY with ELEMENT_NOT_FOUND rather than
              // quietly acting in two places.
              const asked = typeof msg.timeout === 'number' ? msg.timeout : 30000;
              const left = Math.max(1000, asked - (Date.now() - electionStart));
              dispatch({ ...relay, timeout: left }, frameId, forward);
            };

            const noFrameId = () => forward({
              success: false,
              error: {
                code: 'EXTENSION_ERROR',
                message: 'The frame that matched this selector could not identify itself.',
                tip: 'Reload the page and run again. The action was NOT performed — running it in every frame that matched is exactly what this refuses to do.',
              },
            });

            dispatch(probe, undefined, (located) => {
              // A failed probe already carries the error the real command would have produced
              // (ELEMENT_NOT_FOUND / ELEMENT_HIDDEN / ELEMENT_DISABLED / SELECTOR_INVALID), from
              // the same classifier, so it is forwarded verbatim — the split must not change what
              // the user reads when nothing matched.
              if (!located || !located.success) {
                forward(located || { success: false, error: { code: 'EXTENSION_ERROR', message: 'No frame answered the locate probe.', tip: null } });
                return;
              }
              if (located.frameId === 0) { execIn(0); return; }
              // A subframe answered, or a frame that could not name itself. Re-run the same
              // read-only probe against the main frame with the short grace, then prefer it if it
              // also has the element. Safe to repeat precisely because the probe mutates nothing.
              chrome.tabs.sendMessage(targetTab.id, { ...probe, timeout: FRAME0_GRACE_MS }, { frameId: 0 })
                .then((mainFrame) => {
                  if (mainFrame && mainFrame.success) execIn(0);
                  else if (typeof located.frameId === 'number') execIn(located.frameId);
                  else noFrameId();
                })
                .catch(() => {
                  // No content script in frame 0 at all (or it went away) — nothing to prefer.
                  if (typeof located.frameId === 'number') execIn(located.frameId);
                  else noFrameId();
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
  chrome.storage.session.get(RECONNECT_ATTEMPTS_KEY).then((got) => {
    const attempts = Number(got?.[RECONNECT_ATTEMPTS_KEY]) || 0;
    const delay = Math.min(RECONNECT_MIN_MINUTES * Math.pow(2, attempts), RECONNECT_MAX_MINUTES);
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: delay });
    // Stop counting once the ceiling is reached, so the number cannot grow without bound across
    // a long session — the delay is already pinned at the maximum.
    if (delay < RECONNECT_MAX_MINUTES) {
      chrome.storage.session.set({ [RECONNECT_ATTEMPTS_KEY]: attempts + 1 });
    }
  }).catch(() => {
    // storage.session unavailable for any reason — fall back to the flat floor rather than
    // giving up on reconnecting altogether.
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_MIN_MINUTES });
  });
}

/// Clears the ramp so the next failure starts from the floor again.
function resetReconnectBackoff() {
  return chrome.storage.session.remove(RECONNECT_ATTEMPTS_KEY).catch(() => {});
}

function stopReconnect() {
  chrome.alarms.clear(RECONNECT_ALARM);
  resetReconnectBackoff();
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

/**
 * G1 — Normalise a ranked selector list before it crosses the pipe.
 *
 * Every message that reaches this service worker has already been filtered to this extension's
 * own content scripts, so this is not a trust boundary — it is a SHAPE boundary. The C# side
 * parses the array field by field and silently drops malformed entries, which would turn "the
 * generator produced something odd" into "the action recorded with no fallbacks and nobody
 * said so". Dropping the noise here keeps that from looking like a recording bug later.
 */
/**
 * Length ceilings for anything that crosses the native-messaging boundary.
 *
 * Chrome kills the native port outright when a message exceeds 1 MB, and the recording path had
 * no cap of any kind: generateSelector builds `#${CSS.escape(el.id)}` and `[data-testid="…"]`
 * straight from page-controlled attributes, and typed text is whatever the input holds. A page
 * with a megabyte-long id was enough to blow the frame and drop the bridge in the middle of a
 * recording — no attacker needed, just a pathological page.
 *
 * The numbers are far above anything real (a usable CSS selector is tens of characters; the
 * generator already caps descriptions at 40) and far below the frame limit, so truncation here
 * only ever happens to input that was never going to work as a selector anyway.
 */
const MAX_SELECTOR_CHARS = 2000;
const MAX_DESCRIPTION_CHARS = 200;
// Typed text is real user data, so this one is generous: it exists to stop a single field from
// reaching the frame limit, not to trim anything a person would actually type.
const MAX_TEXT_CHARS = 100000;

function capString(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function sanitizeAlternatives(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const alt of list) {
    if (!alt || typeof alt.selector !== 'string' || !alt.selector) continue;
    out.push({
      selector: capString(alt.selector, MAX_SELECTOR_CHARS),
      tier: typeof alt.tier === 'string' && alt.tier ? alt.tier : 'C',
      description: capString(alt.description, MAX_DESCRIPTION_CHARS),
    });
    // Mirrors generateSelectorAlternatives' own cap, so a future generator change cannot
    // quietly start writing 40-entry lists into every profile.
    if (out.length >= 5) break;
  }
  return out;
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
      selector: capString(msg.selector, MAX_SELECTOR_CHARS),
      // G1 — ranked fallback selectors, same shape the pick path already relays. Absent from
      // older content scripts (a stale service worker outliving a reload); the C# side reads a
      // missing array as "no fallbacks", which is exactly the pre-G1 behaviour.
      alternatives: sanitizeAlternatives(msg.alternatives),
      description: capString(msg.description, MAX_DESCRIPTION_CHARS),
      tagName: capString(msg.tagName, 64),
      button: msg.button || 'left',
      isInput: msg.isInput || false,
      url: sender.tab?.url || '',
    });
    sendResponse({ ok: true });
  } else if (msg.type === 'typingCaptured' && isRecording) {
    // #10 — Typing in an input was observed; bridge fills the BrowserType action's text
    sendToNative({
      type: 'browser:typingCaptured',
      selector: capString(msg.selector, MAX_SELECTOR_CHARS),
      alternatives: sanitizeAlternatives(msg.alternatives),
      text: capString(msg.text, MAX_TEXT_CHARS),
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
      selector: capString(msg.selector, MAX_SELECTOR_CHARS),
      alternatives: sanitizeAlternatives(msg.alternatives),
      description: capString(msg.description, MAX_DESCRIPTION_CHARS),
      // Option value and label are page-controlled too, and travel the same frame.
      selectedValue: capString(msg.selectedValue, MAX_SELECTOR_CHARS),
      selectedText: capString(msg.selectedText, MAX_SELECTOR_CHARS),
      selectedIndex: msg.selectedIndex ?? 0,
      url: sender.tab?.url || '',
    });
    sendResponse({ ok: true });
    // A 'commandResult' relay used to sit here. Nothing ever sent it: the only
    // chrome.runtime.sendMessage calls in content.js are elementClicked, typingCaptured,
    // selectInteractionStart/End, selectChanged, getStatus and whichFrame. Command results travel
    // back through the sendMessage RESPONSE that dispatch() awaits, never as a fresh message.
    //
    // It was also the one branch of this listener not gated on isRecording, and what it did was
    // hand the C# side a browser:commandResult with a caller-chosen commandId — which
    // BrowserBridgeService uses to resolve ANY pending command, with a caller-chosen success or
    // error. The sender.id / sender.tab checks above close the door today, so it was unreachable
    // rather than exploitable; it was a command-resolution door waiting for someone to open it.
  } else if (msg.type === 'whichFrame') {
    // The other half of ensureFrameId in content.js: a content script has no way to read its own
    // frameId, and this listener is the only place it is visible. Answering null rather than a
    // guess matters — the frame election uses this id to aim a mutating command at ONE frame, and
    // a wrong id would aim it at the wrong page. Anything without a tab context (the popup) has
    // no frame to name.
    sendResponse({ frameId: sender.tab && typeof sender.frameId === 'number' ? sender.frameId : null });
  } else if (msg.type === 'getStatus') {
    sendResponse({
      connected: isBridgeReady,
      recording: isRecording,
      outdated: isOutdated,
    });
    // Only the popup asks for status, so this fires when the user is actually looking at the
    // badge — the one moment where waiting out a backed-off alarm is most likely to be wrong,
    // because they have probably just started TrueReplayer. Reset the ramp and try now.
    // The reset is awaited before connect(): if this failed attempt schedules the next alarm
    // before the counter is cleared, the ramp survives the very reset that was meant to undo it.
    if (!isBridgeReady) {
      resetReconnectBackoff().then(() => {
        chrome.alarms.clear(RECONNECT_ALARM);
        connect();
      });
    }
  }
  return true;
});

// Ensure connection on all service worker lifecycle events
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

/**
 * Completes the popup's "Reload extension" button.
 *
 * The flag is read at TOP LEVEL rather than from onInstalled/onStartup on purpose: neither of
 * those fires on chrome.runtime.reload(), so a listener would never run and the tabs would
 * silently keep their orphaned content scripts — the exact failure the button is meant to
 * prevent, and an invisible one.
 *
 * Cleared BEFORE the refresh, so a tab that fails to reload cannot leave the flag armed and
 * turn every future service-worker wake-up into a surprise refresh of the user's tabs.
 * Only http(s) tabs: nothing else can host a content script, and reloading a pinned app tab or
 * a chrome:// page would be an unrequested side effect.
 */
chrome.storage.local.get('reloadTabsOnStart', (state) => {
  if (!state || !state.reloadTabsOnStart) return;
  chrome.storage.local.remove('reloadTabsOnStart', () => {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id != null && /^https?:/i.test(tab.url || '')) {
          chrome.tabs.reload(tab.id).catch(() => {});
        }
      }
    });
  });
});

// Start connection immediately when script loads
connect();
