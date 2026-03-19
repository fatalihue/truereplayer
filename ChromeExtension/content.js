(() => {
  let recording = false;
  let highlightEl = null;

  const { generateSelector, getElementDescription } = window.__trueReplayerSelectorGenerator || {};

  // ── Recording Mode ──

  function onMouseOver(e) {
    if (!recording) return;
    removeHighlight();

    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;

    highlightEl = document.createElement('div');
    const rect = el.getBoundingClientRect();
    Object.assign(highlightEl.style, {
      position: 'fixed',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      background: 'rgba(96, 205, 255, 0.15)',
      border: '2px solid rgba(96, 205, 255, 0.6)',
      borderRadius: '3px',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transition: 'all 0.1s ease',
    });
    document.body.appendChild(highlightEl);
  }

  function onMouseOut() {
    removeHighlight();
  }

  function onClick(e) {
    if (!recording) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = e.target;
    if (!el) return;

    const selector = generateSelector?.(el);
    if (!selector) return;

    const description = getElementDescription?.(el) || '';

    chrome.runtime.sendMessage({
      type: 'elementClicked',
      selector,
      description,
      tagName: el.tagName.toLowerCase(),
    });

    // Visual feedback: flash green
    if (highlightEl) {
      highlightEl.style.background = 'rgba(14, 122, 13, 0.25)';
      highlightEl.style.borderColor = 'rgba(14, 122, 13, 0.8)';
      setTimeout(removeHighlight, 300);
    }
  }

  function removeHighlight() {
    if (highlightEl) {
      highlightEl.remove();
      highlightEl = null;
    }
  }

  function startRecording() {
    recording = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
  }

  function stopRecording() {
    recording = false;
    removeHighlight();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onClick, true);
  }

  // ── Command Execution ──

  async function waitForElement(selector, timeout = 30000) {
    const el = document.querySelector(selector);
    if (el) return el;

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      await new Promise((r) => setTimeout(r, 250));
      const found = document.querySelector(selector);
      if (found) return found;
    }
    throw new Error(`Timeout waiting for element: ${selector}`);
  }

  async function executeCommand(msg) {
    const { command, commandId, selector, text, url, timeout = 30000 } = msg;

    try {
      switch (command) {
        case 'click': {
          const el = await waitForElement(selector, timeout);
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();
          el.click();
          return { success: true };
        }

        case 'type': {
          const el = await waitForElement(selector, timeout);
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();

          // Clear existing value
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));

          // Type text character by character for better compatibility
          for (const char of text) {
            el.value += char;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }

        case 'waitElement': {
          await waitForElement(selector, timeout);
          return { success: true };
        }

        case 'navigate': {
          window.location.href = url;
          return { success: true };
        }

        default:
          throw new Error(`Unknown command: ${command}`);
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Message Handling ──

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'setRecording':
        if (msg.enabled) startRecording();
        else stopRecording();
        sendResponse({ ok: true });
        break;

      case 'executeCommand':
        executeCommand(msg).then((result) => {
          if (result.error) {
            sendResponse(result);
          } else {
            sendResponse(result);
          }
        });
        return true; // async response

      default:
        sendResponse({ ok: true });
    }
  });
})();
