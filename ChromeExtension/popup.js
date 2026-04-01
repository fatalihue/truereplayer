const dot = document.getElementById('statusDot');
const text = document.getElementById('statusText');
const hint = document.getElementById('hint');

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
