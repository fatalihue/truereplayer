(() => {
  const isMainFrame = window === window.top;

  let recording = false;
  let picking = false;
  let highlightEl = null;
  let _mouseOverPending = false;
  let _lastHighlightedEl = null;

  const { generateSelector, getElementDescription } = window.__trueReplayerSelectorGenerator || {};

  // ── Recording Mode ──

  function onMouseOver(e) {
    if (!recording && !picking) return;
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    if (el === _lastHighlightedEl) return; // Skip if same element — no reflow needed
    if (_mouseOverPending) return;
    _mouseOverPending = true;
    requestAnimationFrame(() => {
      _mouseOverPending = false;
      if (!recording && !picking) return;
      if (el === _lastHighlightedEl) return;
      _lastHighlightedEl = el;
      removeHighlight();

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
    });
  }

  function onMouseOut() {
    _lastHighlightedEl = null;
    removeHighlight();
  }

  function onClick(e) {
    if (!recording) return;

    // Right-clicks are handled by onContextMenu
    if (e.button === 2) return;

    // Don't block the click — let it happen naturally so menus open, buttons toggle, etc.
    // Only prevent navigation on links to keep the user on the page
    const interactiveEl = bubbleToInteractiveForRecording(e.target);
    if (interactiveEl && interactiveEl.tagName === 'A' && interactiveEl.href) {
      e.preventDefault();
    }

    const el = e.target;
    if (!el) return;

    const selector = generateSelector?.(el);
    if (!selector) return;

    const description = getElementDescription?.(el) || '';

    // Detect input-like elements for auto BrowserType
    const tag = el.tagName.toLowerCase();
    const isInput = tag === 'textarea'
      || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes(el.type))
      || el.isContentEditable;

    chrome.runtime.sendMessage({
      type: 'elementClicked',
      selector,
      description,
      tagName: tag,
      button: e.type === 'contextmenu' ? 'right' : 'left',
      isInput,
    });

    // Visual feedback: flash green
    if (highlightEl) {
      highlightEl.style.background = 'rgba(14, 122, 13, 0.25)';
      highlightEl.style.borderColor = 'rgba(14, 122, 13, 0.8)';
      setTimeout(removeHighlight, 300);
    }
  }

  function bubbleToInteractiveForRecording(el) {
    let current = el;
    for (let i = 0; i < 5 && current && current !== document.body; i++) {
      if (current.tagName === 'A' || current.tagName === 'BUTTON') return current;
      current = current.parentElement;
    }
    return null;
  }

  function removeHighlight() {
    if (highlightEl) {
      highlightEl.remove();
      highlightEl = null;
    }
  }

  function onContextMenu(e) {
    if (!recording) return;

    // Prevent the native context menu so we can record the right-click
    e.preventDefault();

    // Reuse the same logic as onClick
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
      button: 'right',
    });

    // Visual feedback: flash green
    if (highlightEl) {
      highlightEl.style.background = 'rgba(14, 122, 13, 0.25)';
      highlightEl.style.borderColor = 'rgba(14, 122, 13, 0.8)';
      setTimeout(removeHighlight, 300);
    }
  }

  function startRecording() {
    if (!isMainFrame) return; // Only record in main frame — iframes cause multiplied handlers
    recording = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onContextMenu, true);
  }

  function stopRecording() {
    recording = false;
    removeHighlight();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
  }

  // ── Pick Element Mode (single-pick for edit panel) ──

  let pickResolve = null;

  function onPickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = e.target;
    if (!el) return stopPick(null);

    const selector = generateSelector?.(el);
    stopPick(selector || null);
  }

  function startPick() {
    if (!isMainFrame) return;
    picking = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('contextmenu', onPickClick, true);
    // ESC cancels pick mode
    document.addEventListener('keydown', onPickKeydown, true);
  }

  function onPickKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      stopPick(null);
    }
  }

  function stopPick(selector) {
    picking = false;
    removeHighlight();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('contextmenu', onPickClick, true);
    document.removeEventListener('keydown', onPickKeydown, true);
    if (pickResolve) {
      pickResolve(selector);
      pickResolve = null;
    }
  }

  // ── Command Execution ──

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // Allow opacity:0 for form elements (sites overlay native selects with custom UI)
    const formTags = new Set(['SELECT', 'INPUT', 'TEXTAREA']);
    if (style.opacity === '0' && !formTags.has(el.tagName)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Find element by text content. Searches visible elements matching the text.
   * Prefers smaller/more specific elements (buttons, links, spans, list items).
   */
  function findByText(text) {
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const elText = el.textContent?.trim();
      if (!elText) continue;
      // Exact match on direct text (not children's text)
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ').trim();
      if (directText === text || elText === text) {
        if (isVisible(el)) candidates.push({ el, directMatch: directText === text, depth: getDepth(el) });
      }
    }
    if (candidates.length === 0) return null;
    // Prefer direct text match, then deepest element (most specific)
    candidates.sort((a, b) => (b.directMatch - a.directMatch) || (b.depth - a.depth));
    return candidates[0].el;
  }

  function getDepth(el) {
    let d = 0;
    let c = el;
    while (c.parentElement) { d++; c = c.parentElement; }
    return d;
  }

  async function waitForElement(selector, timeout = 30000) {
    const isTextSelector = selector.startsWith('text=');
    const findFn = isTextSelector
      ? () => findByText(selector.slice(5))
      : () => { const el = document.querySelector(selector); return el && isVisible(el) ? el : null; };

    // Check immediately first
    const el = findFn();
    if (el) return el;

    // Use MutationObserver instead of polling — zero CPU when DOM is idle
    return new Promise((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        const seconds = Math.round(timeout / 1000);
        reject(new Error(`Element not found after ${seconds}s. Make sure it is visible on the page.`));
      }, timeout);

      const observer = new MutationObserver(() => {
        if (resolved) return;
        const found = findFn();
        if (found) {
          resolved = true;
          clearTimeout(timer);
          observer.disconnect();
          resolve(found);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
  }

  async function executeCommand(msg) {
    const { command, commandId, selector, text, url, timeout = 30000 } = msg;

    try {
      switch (command) {
        case 'click': {
          const el = await waitForElement(selector, timeout);
          el.scrollIntoView({ block: 'center', behavior: 'instant' });

          // Native <select>: set value directly instead of clicking
          if (el.tagName === 'SELECT') {
            el.focus();
            // If text is provided, select that option; otherwise just focus
            if (text) {
              const option = Array.from(el.options).find(o => o.value === text || o.textContent.trim() === text);
              if (option) {
                el.value = option.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else {
              // Simulate opening the select
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            }
            return { success: true };
          }

          // Full mouse event sequence: hover → click for menu/dropdown compatibility
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const opts = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            buttons: 1,
            clientX: cx,
            clientY: cy,
            screenX: cx + window.screenX,
            screenY: cy + window.screenY,
          };

          // Hover first — reveals submenus that appear on mouseenter/mouseover
          el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('mouseover', { ...opts, buttons: 0 }));
          await new Promise(r => setTimeout(r, 50));

          // Snapshot state before click to detect if simulated events worked
          const childCountBefore = document.body.childElementCount;
          const rectBefore = el.getBoundingClientRect();

          el.focus();
          el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          await new Promise(r => setTimeout(r, 30));
          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
          el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));

          // Only use .click() fallback if simulated events had no visible effect
          // (element still in DOM, same position, no DOM changes)
          await new Promise(r => setTimeout(r, 100));
          const stillInDom = document.body.contains(el);
          const childCountAfter = document.body.childElementCount;
          const domChanged = childCountAfter !== childCountBefore;

          if (stillInDom && !domChanged) {
            // Simulated events didn't cause any visible change — try native click
            el.click();
          }

          return { success: true };
        }

        case 'rightClick': {
          const el = await waitForElement(selector, timeout);
          el.scrollIntoView({ block: 'center', behavior: 'instant' });

          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const opts = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 2,
            buttons: 2,
            clientX: cx,
            clientY: cy,
            screenX: cx + window.screenX,
            screenY: cy + window.screenY,
          };

          el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('mouseover', { ...opts, buttons: 0 }));
          await new Promise(r => setTimeout(r, 50));

          el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          await new Promise(r => setTimeout(r, 30));
          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
          el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('contextmenu', { ...opts, buttons: 0 }));

          return { success: true };
        }

        case 'type': {
          const el = await waitForElement(selector, timeout);
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();

          // Clear existing value
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));

          // Type text character by character with micro-delays for browser responsiveness
          for (const char of text) {
            el.value += char;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
            if (text.length > 20) await new Promise(r => setTimeout(r, 5));
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
          sendResponse(result);
        });
        return true; // async response

      case 'pickElement':
        // Single-pick mode: highlights elements, returns selector on click, ESC cancels
        pickResolve = (selector) => {
          sendResponse({ selector });
        };
        startPick();
        return true; // async response

      default:
        sendResponse({ ok: true });
    }
  });
})();
