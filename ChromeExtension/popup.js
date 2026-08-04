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
  reloadBtn.disabled = true;
  reloadBtn.textContent = 'Reloading...';
  chrome.storage.local.set({ reloadTabsOnStart: true }, () => chrome.runtime.reload());
});

chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
  if (chrome.runtime.lastError || !response) {
    dot.className = 'dot disconnected';
    text.textContent = 'Disconnected';
    hint.textContent = 'Open TrueReplayer to connect.';
    return;
  }

  if (response.recording) {
    dot.className = 'dot recording';
    text.textContent = 'Recording';
    hint.textContent = 'Click on page elements to capture them. Actions appear in TrueReplayer grid.';
    // A reload mid-recording drops the native port and refreshes the page under the user, which
    // ends the session and loses whatever was not yet in the grid. One misclick is not worth
    // the convenience, so the button is simply not available while REC is on.
    reloadBtn.disabled = true;
    reloadHint.textContent = 'Stop recording before reloading the extension.';
  } else if (response.connected) {
    dot.className = 'dot connected';
    text.textContent = 'Connected';
    hint.textContent = 'Start recording in TrueReplayer to capture browser elements.';
  } else {
    dot.className = 'dot disconnected';
    text.textContent = 'Disconnected';
    hint.textContent = 'Open TrueReplayer to connect.';
  }

  if (response.outdated) {
    const update = document.getElementById('updateNotice');
    if (update) update.style.display = 'block';
  }
});
