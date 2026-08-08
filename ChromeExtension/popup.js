const dot = document.getElementById('statusDot');
const text = document.getElementById('statusText');
const hint = document.getElementById('hint');
const reloadBtn = document.getElementById('reloadBtn');
const reloadHint = document.getElementById('reloadHint');

/**
 * Reload the extension from here instead of walking to chrome://extensions.
 *
 * chrome.runtime.reload() re-reads an unpacked extension from disk, but it does NOT re-inject
 * content scripts into tabs that are already open — those keep running the OLD script until
 * their page is reloaded, which is exactly the trap this button exists to avoid. So the tab
 * refresh is part of the button, not a separate thing to remember. It cannot happen here
 * (reload() kills this service worker immediately, and refreshing first would just re-inject
 * the old script), so the intent is parked in storage and the next service worker acts on it.
 */
reloadBtn.addEventListener('click', () => {
  // Belt-and-suspenders: the button is born disabled (see popup.html) and only ever flipped
  // enabled below, once getStatus has confirmed recording is off. A disabled button doesn't
  // dispatch click at all, but checking again here keeps this handler fail-closed on its own
  // terms rather than trusting the DOM attribute alone.
  if (reloadBtn.disabled) return;
  reloadBtn.disabled = true;
  reloadBtn.textContent = 'Reloading...';
  chrome.storage.local.set({ reloadTabsOnStart: true }, () => chrome.runtime.reload());
});

chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
  if (chrome.runtime.lastError || !response) {
    dot.className = 'dot disconnected';
    text.textContent = 'Disconnected';
    hint.textContent = 'Open TrueReplayer to connect.';
    // getStatus itself failed to answer, so whether a recording is in flight is unknown, not
    // "known safe". The button starts disabled in the HTML for exactly this case — leave it
    // that way instead of falling open just because the query never came back.
    reloadHint.textContent = 'Status unavailable — reload is disabled until it responds.';
    return;
  }

  if (response.recording) {
    dot.className = 'dot recording';
    text.textContent = 'Recording';
    hint.textContent = 'Click on page elements to capture them. Actions appear in TrueReplayer grid.';
    // A reload mid-recording drops the native port and refreshes the page under the user, which
    // ends the session and loses whatever was not yet in the grid. One misclick is not worth
    // the convenience, so the button is simply not available while REC is on. It already started
    // disabled from page-load (see popup.html); restating it here keeps this branch correct on
    // its own even if that default is ever revisited.
    reloadBtn.disabled = true;
    reloadHint.textContent = 'Stop recording before reloading the extension.';
  } else {
    if (response.connected) {
      dot.className = 'dot connected';
      text.textContent = 'Connected';
      hint.textContent = 'Start recording in TrueReplayer to capture browser elements.';
    } else {
      dot.className = 'dot disconnected';
      text.textContent = 'Disconnected';
      hint.textContent = 'Open TrueReplayer to connect.';
    }
    // Only now has getStatus actually confirmed no recording is in flight, so it's finally safe
    // to hand out the button that started disabled.
    reloadBtn.disabled = false;
    reloadHint.textContent = 'Also refreshes open tabs, so pages get the new content script.';
  }

  if (response.outdated) {
    const update = document.getElementById('updateNotice');
    if (update) update.style.display = 'block';
  }
});
