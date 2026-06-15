(() => {
  const isMainFrame = window === window.top;

  let recording = false;
  let picking = false;
  let highlightEl = null;
  let _mouseOverPending = false;
  let _lastHighlightedEl = null;

  // #10 — Typing capture during recording
  let _typingObserver = null;       // currently-monitored input element
  let _typingObserverInitial = '';  // value at time of focus
  let _typingObserverHandler = null;
  let _typingObserverBlur = null;

  const { generateSelector, generateSelectorAlternatives, getElementDescription } =
    window.__trueReplayerSelectorGenerator || {};

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

    // Native <select> clicks just open the OS dropdown popup. The meaningful action
    // is the value change, captured by onSelectChange below — recording the click
    // here would produce a redundant (and broken at replay) BrowserClick.
    if (el.tagName === 'SELECT') return;

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

    // #10 — If user clicked into an input/contentEditable, start observing typing
    if (isInput) {
      startTypingObserver(el);
    } else {
      // Non-input click commits whatever was being typed
      flushTypingObserver();
    }

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

    flushTypingObserver();

    // Visual feedback: flash green
    if (highlightEl) {
      highlightEl.style.background = 'rgba(14, 122, 13, 0.25)';
      highlightEl.style.borderColor = 'rgba(14, 122, 13, 0.8)';
      setTimeout(removeHighlight, 300);
    }
  }

  // #10 — Typing capture: when user focuses a field via recorded click,
  // observe input events. When focus leaves, send the typed text as a BrowserType action.
  function startTypingObserver(el) {
    flushTypingObserver(); // commit any pending observer first

    _typingObserver = el;
    _typingObserverInitial = el.isContentEditable ? (el.textContent || '') : (el.value || '');

    _typingObserverHandler = () => {
      // Just track changes; we'll commit on blur
    };
    _typingObserverBlur = () => {
      flushTypingObserver();
    };

    el.addEventListener('input', _typingObserverHandler, true);
    el.addEventListener('blur', _typingObserverBlur, true);
  }

  function flushTypingObserver() {
    if (!_typingObserver) return;

    const el = _typingObserver;
    const initial = _typingObserverInitial;
    const current = el.isContentEditable ? (el.textContent || '') : (el.value || '');

    // Detach listeners
    if (_typingObserverHandler) el.removeEventListener('input', _typingObserverHandler, true);
    if (_typingObserverBlur) el.removeEventListener('blur', _typingObserverBlur, true);
    _typingObserver = null;
    _typingObserverHandler = null;
    _typingObserverBlur = null;
    _typingObserverInitial = '';

    // Compute typed delta
    let typed = current;
    let isAppend = false;
    if (initial && current.startsWith(initial)) {
      typed = current.slice(initial.length);
      isAppend = true;
    }

    if (typed.length === 0) return;

    const selector = generateSelector?.(el);
    if (!selector) return;

    chrome.runtime.sendMessage({
      type: 'typingCaptured',
      selector,
      text: typed,
      isAppend,
    });
  }

  // mousedown on a native <select> — tells the backend that an interaction is starting.
  // Backend flips a flag that makes the OS-level mouse hook skip recording native clicks
  // until either the matching change fires (option picked) or the <select> blurs (cancel)
  // or the 15-second safety timeout elapses. Without this, slow users (>3 s between open
  // and pick) would leave orphan click pairs in the action grid.
  function onSelectMouseDown(e) {
    if (!recording) return;
    if (!e.target || e.target.tagName !== 'SELECT') return;
    chrome.runtime.sendMessage({ type: 'selectInteractionStart' });
  }

  // blur on a <select> — covers the "user opened then cancelled by clicking outside" path.
  // Without this, the suppress flag would only clear via the safety timeout, eating any
  // unrelated clicks the user makes immediately after.
  function onSelectBlur(e) {
    if (!recording) return;
    if (!e.target || e.target.tagName !== 'SELECT') return;
    chrome.runtime.sendMessage({ type: 'selectInteractionEnd' });
  }

  // Esc dismisses a native <select> popup WITHOUT blurring the element — no blur, no
  // change, so neither bracket-closer above fires and the suppress flag would sit until
  // the 15 s safety timeout. Close the bracket explicitly on Esc while a <select> has
  // focus. (The backend also wipes the Esc tap the OS keyboard hook recorded.)
  function onRecordKeyDown(e) {
    if (!recording) return;
    if (e.key !== 'Escape') return;
    const el = document.activeElement;
    if (el && el.tagName === 'SELECT') {
      chrome.runtime.sendMessage({ type: 'selectInteractionEnd' });
    }
  }

  // Captures changes to native <select> dropdowns. The companion to the SELECT skip
  // in onClick: clicking the <select> opens the OS popup (not recordable), but the
  // resulting value change is captured here as a BrowserSelectOption action.
  function onSelectChange(e) {
    if (!recording) return;
    const el = e.target;
    if (!el || el.tagName !== 'SELECT') return;

    const selector = generateSelector?.(el);
    if (!selector) return;

    const opt = el.options[el.selectedIndex];
    if (!opt) return;

    chrome.runtime.sendMessage({
      type: 'selectChanged',
      selector,
      description: getElementDescription?.(el) || '',
      selectedValue: opt.value,
      selectedText: (opt.text || '').trim(),
      selectedIndex: el.selectedIndex,
    });

    // Visual feedback: flash green (matches onClick's affordance)
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
    document.addEventListener('change', onSelectChange, true);
    document.addEventListener('mousedown', onSelectMouseDown, true);
    document.addEventListener('blur', onSelectBlur, true);
    document.addEventListener('keydown', onRecordKeyDown, true);
  }

  function stopRecording() {
    recording = false;
    flushTypingObserver();
    removeHighlight();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('change', onSelectChange, true);
    document.removeEventListener('mousedown', onSelectMouseDown, true);
    document.removeEventListener('blur', onSelectBlur, true);
    document.removeEventListener('keydown', onRecordKeyDown, true);
  }

  // ── Pick Element Mode (single-pick for edit panel) ──

  let pickResolve = null;

  function onPickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = e.target;
    if (!el) return stopPick(null, []);

    // #2 — Generate alternatives ranked by stability (returns array; first is primary)
    let alternatives = [];
    if (generateSelectorAlternatives) {
      try { alternatives = generateSelectorAlternatives(el) || []; } catch { alternatives = []; }
    }

    const primary = alternatives[0]?.selector || generateSelector?.(el) || null;

    stopPick(primary, alternatives);
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
      stopPick(null, []);
    }
  }

  function stopPick(selector, alternatives) {
    picking = false;
    removeHighlight();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('contextmenu', onPickClick, true);
    document.removeEventListener('keydown', onPickKeydown, true);
    if (pickResolve) {
      pickResolve(selector, alternatives || []);
      pickResolve = null;
    }
  }

  // ── Command Execution ──

  // #8 — Structured error helper. Returns an object the bridge deserializes as
  // {code, message, tip} for friendly UX.
  function mkError(code, message, tip) {
    return { code, message, tip };
  }

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

  // #4 — Element interactable: not disabled (native or aria)
  function isInteractable(el) {
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  // #4 — Element covered: returns the covering element if the target isn't on top, else null
  function getCoveringElement(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (!top) return null;
    if (top === el || el.contains(top) || top.contains(el)) return null;
    return top;
  }

  // #4 — Smart scrollIntoView: skip if already in viewport
  function scrollIntoViewIfNeeded(el) {
    const rect = el.getBoundingClientRect();
    const inView =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth);
    if (!inView) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }

  // #1 — Parse a selector into {kind, mode, value}.
  // CSS selectors return {kind:'css'}. Text selectors recognize 4 prefixes:
  //   text=    → exact
  //   text*=   → contains (case-sensitive)
  //   text~=   → contains (case-insensitive)
  //   text/.../flags  → regex (flags optional, e.g. /i, /im)
  function parseTextSelector(selector) {
    if (typeof selector !== 'string') return { kind: 'css', value: selector || '' };

    // Regex form: text/.../flags
    if (selector.startsWith('text/')) {
      const lastSlash = selector.lastIndexOf('/');
      if (lastSlash > 4) {
        const pattern = selector.slice(5, lastSlash);
        const flags = selector.slice(lastSlash + 1);
        return { kind: 'text', mode: 'regex', value: pattern, flags };
      }
    }

    if (selector.startsWith('text*=')) return { kind: 'text', mode: 'contains', value: selector.slice(6) };
    if (selector.startsWith('text~=')) return { kind: 'text', mode: 'icontains', value: selector.slice(6) };
    if (selector.startsWith('text=')) return { kind: 'text', mode: 'exact', value: selector.slice(5) };

    return { kind: 'css', value: selector };
  }

  // #1 — Test if element text matches the parsed text selector
  function elementTextMatches(el, parsed) {
    const elText = (el.textContent || '').trim();

    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim())
      .join(' ').trim();

    switch (parsed.mode) {
      case 'exact':
        return directText === parsed.value || elText === parsed.value;
      case 'contains':
        return directText.includes(parsed.value) || elText.includes(parsed.value);
      case 'icontains': {
        const needle = parsed.value.toLowerCase();
        return directText.toLowerCase().includes(needle) || elText.toLowerCase().includes(needle);
      }
      case 'regex': {
        try {
          const re = new RegExp(parsed.value, parsed.flags || '');
          return re.test(directText) || re.test(elText);
        } catch {
          return false;
        }
      }
      default:
        return false;
    }
  }

  /**
   * #1 — Find element by parsed text selector, ranking direct-text matches and
   * deeper (more specific) elements higher.
   */
  function findByParsedText(parsed) {
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const elText = el.textContent?.trim();
      if (!elText) continue;

      if (!elementTextMatches(el, parsed)) continue;
      if (!isVisible(el)) continue;

      // Direct-text match preference
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ').trim();
      // Re-test using only direct text to determine direct-match preference
      const directMatch = directText && (
        parsed.mode === 'exact' ? directText === parsed.value :
        parsed.mode === 'contains' ? directText.includes(parsed.value) :
        parsed.mode === 'icontains' ? directText.toLowerCase().includes(parsed.value.toLowerCase()) :
        parsed.mode === 'regex' ? (() => { try { return new RegExp(parsed.value, parsed.flags || '').test(directText); } catch { return false; } })() :
        false
      );

      candidates.push({ el, directMatch: !!directMatch, depth: getDepth(el) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.directMatch - a.directMatch) || (b.depth - a.depth));
    return candidates[0].el;
  }

  function getDepth(el) {
    let d = 0;
    let c = el;
    while (c.parentElement) { d++; c = c.parentElement; }
    return d;
  }

  // #1 + #8 — Validate CSS selector syntax. Returns true if valid, false otherwise.
  function isValidCssSelector(sel) {
    try {
      document.querySelector(sel);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * #6 — Find element matching the selector. Mode determines what "match" means.
   * mode = 'appears' | 'enabled' | 'text-match' (uses textPattern)
   * For 'appears' and 'text-match', element must be visible.
   * For 'enabled', element must be visible AND interactable.
   */
  function findElementForMode(parsedSelector, mode, textPattern) {
    const findCss = () => {
      try {
        return document.querySelector(parsedSelector.value);
      } catch {
        return null;
      }
    };
    const findText = () => findByParsedText(parsedSelector);

    const baseFinder = parsedSelector.kind === 'text' ? findText : findCss;
    const el = baseFinder();
    if (!el) return null;

    switch (mode) {
      case 'appears':
        return isVisible(el) ? el : null;
      case 'enabled':
        return isVisible(el) && isInteractable(el) ? el : null;
      case 'text-match': {
        if (!isVisible(el)) return null;
        if (!textPattern) return el;
        const parsedText = parseTextSelector(textPattern);
        return elementTextMatches(el, parsedText) ? el : null;
      }
      default:
        return isVisible(el) ? el : null;
    }
  }

  /**
   * #6 — waitForElement with mode support.
   *   appears (default) — element exists and is visible
   *   disappears — element is gone or invisible
   *   enabled — element exists, visible, and not disabled
   *   text-match — element exists, visible, and its text matches textPattern
   */
  async function waitForElement(selector, timeout = 30000, mode = 'appears', textPattern = null) {
    const parsed = parseTextSelector(selector);

    // #8 — Validate CSS selector syntax up front for clearer error
    if (parsed.kind === 'css' && !isValidCssSelector(parsed.value)) {
      throw mkError(
        'SELECTOR_INVALID',
        'CSS selector is invalid.',
        'Check syntax — selector failed querySelector validation.'
      );
    }

    const checkPositive = () => findElementForMode(parsed, mode, textPattern);
    const checkDisappears = () => {
      const el = parsed.kind === 'text' ? findByParsedText(parsed) :
        (() => { try { return document.querySelector(parsed.value); } catch { return null; } })();
      // Element gone OR present but no longer visible
      if (!el) return true;
      return !isVisible(el);
    };

    if (mode === 'disappears') {
      // Immediate check
      if (checkDisappears()) return null;

      return new Promise((resolve, reject) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          observer.disconnect();
          const seconds = Math.round(timeout / 1000);
          reject(mkError(
            'ELEMENT_NOT_FOUND',
            `Element still present after ${seconds}s.`,
            'Element did not disappear in time. Increase the timeout or check selector.'
          ));
        }, timeout);

        const observer = new MutationObserver(() => {
          if (resolved) return;
          if (checkDisappears()) {
            resolved = true;
            clearTimeout(timer);
            observer.disconnect();
            resolve(null);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      });
    }

    // Positive modes (appears, enabled, text-match)
    const found = checkPositive();
    if (found) return found;

    return new Promise((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        const seconds = Math.round(timeout / 1000);

        // Provide more specific error code if the element exists but doesn't satisfy mode
        let el = null;
        try {
          el = parsed.kind === 'text' ? findByParsedText(parsed) : document.querySelector(parsed.value);
        } catch { /* swallow */ }

        if (el && !isVisible(el)) {
          reject(mkError('ELEMENT_HIDDEN', `Element exists but is hidden after ${seconds}s.`,
            'Element has display:none, visibility:hidden, or zero size. Wait for it to become visible first.'));
        } else if (el && mode === 'enabled' && !isInteractable(el)) {
          reject(mkError('ELEMENT_DISABLED', `Element is disabled after ${seconds}s.`,
            'Button/input is disabled. Wait for the form/page to enable it.'));
        } else {
          reject(mkError('ELEMENT_NOT_FOUND', `Element not found after ${seconds}s.`,
            'Page might be loading slowly, or selector doesn\'t match anything. Try Pick again.'));
        }
      }, timeout);

      const observer = new MutationObserver(() => {
        if (resolved) return;
        const f = checkPositive();
        if (f) {
          resolved = true;
          clearTimeout(timer);
          observer.disconnect();
          resolve(f);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
  }

  // #9 — Replay highlight: brief overlay around an element during action execution
  function flashHighlight(el, status, durationMs) {
    if (!el || !document.body.contains(el)) return;
    if (typeof status !== 'string') status = 'active';
    if (typeof durationMs !== 'number') durationMs = 300;
    const colors = {
      active:  { bg: 'rgba(96, 205, 255, 0.22)', border: 'rgba(96, 205, 255, 0.85)' },
      success: { bg: 'rgba(14, 122, 13, 0.25)',  border: 'rgba(14, 122, 13, 0.85)' },
      error:   { bg: 'rgba(196, 43, 28, 0.25)',  border: 'rgba(196, 43, 28, 0.85)' },
    };
    const c = colors[status] || colors.active;
    const overlay = document.createElement('div');
    const rect = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      position: 'fixed',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      background: c.bg,
      border: '2px solid ' + c.border,
      borderRadius: '3px',
      pointerEvents: 'none',
      zIndex: '2147483646',
      transition: 'opacity 0.15s ease',
    });
    document.body.appendChild(overlay);
    setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 200);
    }, durationMs);
  }

  // #5 — Type into a contentEditable element using execCommand or selection API
  function typeIntoContentEditable(el, text, append) {
    el.focus();
    if (!append) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { document.execCommand('delete', false); } catch { /* fallback below */ }
    } else {
      // Move caret to end
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    try {
      // execCommand('insertText') fires native input events that frameworks listen to
      document.execCommand('insertText', false, text);
    } catch {
      el.textContent = (append ? (el.textContent || '') : '') + text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // #5 — Paste text via clipboard for fast bulk entry
  async function typeViaPaste(el, text, append) {
    el.focus();
    // Clear first if not appending, so paste replaces existing content
    if (!append) {
      if ('value' in el) {
        el.value = '';
      } else if (el.isContentEditable) {
        el.textContent = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    let clipboardOk = false;
    // Snapshot the user's clipboard so it can be restored — typeViaPaste otherwise permanently
    // clobbers whatever they had copied. readText may be blocked (no permission/gesture); if so we
    // skip the restore rather than failing the paste.
    let priorClipboard = null;
    let priorClipboardRead = false;
    try {
      try { priorClipboard = await navigator.clipboard.readText(); priorClipboardRead = true; } catch { priorClipboardRead = false; }
      await navigator.clipboard.writeText(text);
      clipboardOk = true;
    } catch {
      clipboardOk = false;
    }
    if (clipboardOk) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        el.dispatchEvent(pasteEvent);
        try { document.execCommand('paste'); } catch { /* fallback */ }
      } catch { /* fallback */ }
    }

    // Fallback / final write — covers apps that ignore the synthetic paste event
    const empty = (el.isContentEditable ? !el.textContent : !el.value);
    if (empty) {
      if (el.isContentEditable) {
        el.textContent = text;
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Restore the user's original clipboard now that the paste has consumed it (best effort).
    if (priorClipboardRead) {
      try { await navigator.clipboard.writeText(priorClipboard); } catch { /* best effort */ }
    }
  }

  // ── Key chip parsing for BrowserType ──
  // Supports {enter}, {tab}, {esc}/{escape}, {backspace}, {delete}, {up}/{down}/{left}/{right}
  // mixed with regular text, e.g. "user{tab}pass{enter}".

  const KEY_CHIP_MAP = {
    enter:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
    tab:       { key: 'Tab',        code: 'Tab',        keyCode: 9  },
    esc:       { key: 'Escape',     code: 'Escape',     keyCode: 27 },
    escape:    { key: 'Escape',     code: 'Escape',     keyCode: 27 },
    backspace: { key: 'Backspace',  code: 'Backspace',  keyCode: 8  },
    delete:    { key: 'Delete',     code: 'Delete',     keyCode: 46 },
    up:        { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
    down:      { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
    left:      { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
    right:     { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  };
  const KEY_CHIP_PATTERN = /\{(enter|tab|esc|escape|backspace|delete|up|down|left|right)\}/gi;

  function parseTypeSegments(text) {
    if (!text) return [{ kind: 'text', value: '' }];
    const segments = [];
    let lastIndex = 0;
    let match;
    KEY_CHIP_PATTERN.lastIndex = 0;
    while ((match = KEY_CHIP_PATTERN.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
      }
      segments.push({ kind: 'key', name: match[1].toLowerCase() });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      segments.push({ kind: 'text', value: text.slice(lastIndex) });
    }
    return segments.length > 0 ? segments : [{ kind: 'text', value: text }];
  }

  /**
   * Dispatch a special key (Enter/Esc/Backspace/etc.) on an element.
   * Synthetic KeyboardEvents only notify JS handlers — they do NOT trigger the browser's
   * default action (delete a char, move caret, change focus). For keys whose default is
   * essential, we apply the effect ourselves after the dispatch, unless a handler called
   * preventDefault on keydown.
   */
  function dispatchSpecialKey(el, name) {
    const meta = KEY_CHIP_MAP[name];
    if (!meta) return;
    const opts = {
      key: meta.key, code: meta.code,
      keyCode: meta.keyCode, which: meta.keyCode,
      bubbles: true, cancelable: true,
    };
    const downEvt = new KeyboardEvent('keydown', opts);
    el.dispatchEvent(downEvt);
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));

    if (downEvt.defaultPrevented) return;

    if (name === 'backspace') {
      applyEditDelete(el, -1);
      return;
    }
    if (name === 'delete') {
      applyEditDelete(el, +1);
      return;
    }

    // Enter form-submit fallback (synthetic events skip the browser's default submit)
    if (name === 'enter' && el.tagName !== 'TEXTAREA') {
      const form = el.form || (el.closest && el.closest('form'));
      if (form && typeof form.requestSubmit === 'function') {
        try { form.requestSubmit(); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Apply the effect of Backspace (dir = -1) or Delete (dir = +1) on a text input,
   * textarea, or contentEditable element. Mirrors the browser's default behaviour:
   *   - If there's a selection, remove it (regardless of direction).
   *   - Otherwise, remove one char before/after the caret.
   * Fires a native 'input' event so frameworks (React/Vue/etc.) sync their state.
   */
  function applyEditDelete(el, dir) {
    if ('value' in el && typeof el.value === 'string') {
      const value = el.value;
      let start = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
      let end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
      if (start > end) { const tmp = start; start = end; end = tmp; }

      let newValue = value;
      let newCaret = start;
      if (start !== end) {
        newValue = value.slice(0, start) + value.slice(end);
        newCaret = start;
      } else if (dir < 0 && start > 0) {
        newValue = value.slice(0, start - 1) + value.slice(start);
        newCaret = start - 1;
      } else if (dir > 0 && end < value.length) {
        newValue = value.slice(0, start) + value.slice(start + 1);
        newCaret = start;
      } else {
        return; // nothing to delete (caret at start for backspace, or at end for delete)
      }

      el.value = newValue;
      try { el.setSelectionRange(newCaret, newCaret); } catch { /* unsupported on some types */ }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (el.isContentEditable) {
      try {
        document.execCommand(dir < 0 ? 'delete' : 'forwardDelete');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch { /* legacy execCommand may throw in some envs */ }
    }
  }

  async function executeCommand(msg) {
    const {
      command, selector, text, url, timeout = 30000,
      waitMode, urlWaitPattern, postNavigateSelector,
      typeAppend, typePaste, typeDelay,
      selectMatchMode,
    } = msg;

    let actionEl = null;
    try {
      switch (command) {
        case 'click': {
          const el = await waitForElement(selector, timeout, 'appears');
          actionEl = el;

          // #4 — Reject early on disabled elements with specific code
          if (!isInteractable(el)) {
            throw mkError('ELEMENT_DISABLED', 'Element is disabled — cannot click.',
              'Wait for the element to be enabled first (use Wait with mode=enabled).');
          }

          scrollIntoViewIfNeeded(el);
          await new Promise(r => setTimeout(r, 30));

          // #4 — Reject if covered by another element (modal, sticky header, tooltip)
          const coveredBy = getCoveringElement(el);
          if (coveredBy) {
            throw mkError('ELEMENT_COVERED', 'Element is covered by another element.',
              'Modal, tooltip, or sticky header is on top. Add a Wait or scroll before this action.');
          }

          // #9 — Highlight before action
          flashHighlight(el, 'active', 220);

          // Native <select>: set value directly instead of clicking
          if (el.tagName === 'SELECT') {
            el.focus();
            if (text) {
              const option = Array.from(el.options).find(o => o.value === text || o.textContent.trim() === text);
              if (option) {
                el.value = option.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else {
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

          el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('mouseover', { ...opts, buttons: 0 }));
          await new Promise(r => setTimeout(r, 50));

          // #4 — Smart fallback: snapshot toggle/state signals before click
          const beforeClassList = el.className;
          const beforeAriaExpanded = el.getAttribute('aria-expanded');
          const beforeAriaPressed = el.getAttribute('aria-pressed');
          const beforeAriaChecked = el.getAttribute('aria-checked');
          const beforeFocused = document.activeElement;

          el.focus();
          el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          await new Promise(r => setTimeout(r, 30));
          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
          el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));

          await new Promise(r => setTimeout(r, 200));

          // #4 — Use native .click() only if synthetic events caused NO state change.
          // Robust signals: classList change, aria-* toggles, focus change, element removal.
          const stillInDom = document.body.contains(el);
          if (stillInDom) {
            const noClassChange = el.className === beforeClassList;
            const noAriaChange = el.getAttribute('aria-expanded') === beforeAriaExpanded
              && el.getAttribute('aria-pressed') === beforeAriaPressed
              && el.getAttribute('aria-checked') === beforeAriaChecked;
            const noFocusChange = document.activeElement === beforeFocused;

            if (noClassChange && noAriaChange && noFocusChange) {
              try { el.click(); } catch { /* swallow */ }
            }
          }

          flashHighlight(el, 'success', 200);
          return { success: true };
        }

        case 'rightClick': {
          const el = await waitForElement(selector, timeout, 'appears');
          actionEl = el;

          if (!isInteractable(el)) {
            throw mkError('ELEMENT_DISABLED', 'Element is disabled — cannot right-click.',
              'Wait for the element to be enabled first.');
          }

          scrollIntoViewIfNeeded(el);

          const coveredBy = getCoveringElement(el);
          if (coveredBy) {
            throw mkError('ELEMENT_COVERED', 'Element is covered by another element.',
              'Modal, tooltip, or sticky header is on top.');
          }

          flashHighlight(el, 'active', 220);

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

          flashHighlight(el, 'success', 200);
          return { success: true };
        }

        case 'type': {
          const el = await waitForElement(selector, timeout, 'appears');
          actionEl = el;

          if (!isInteractable(el)) {
            throw mkError('ELEMENT_DISABLED', 'Field is disabled — cannot type.',
              'Wait for the field to be enabled first.');
          }

          scrollIntoViewIfNeeded(el);
          flashHighlight(el, 'active', 220);
          el.focus();

          // Parse text for key chips: {enter}, {tab}, {esc}, {backspace}, {delete}, {up}/{down}/{left}/{right}.
          // Mixed sequences like "user{tab}pass{enter}" type each text segment, then
          // dispatch the key, then continue typing on the new active element.
          const segments = parseTypeSegments(text ?? ''); // tolerate a missing text payload
          let currentEl = el;
          // Each text segment that follows a focus transition (start, or after a key)
          // re-applies the typeAppend rule — so non-append clears each new field too.
          let justTransitioned = true;

          const charDelay = (typeof typeDelay === 'number' && typeDelay >= 0)
            ? typeDelay
            : (text.length > 20 ? 5 : 0);

          for (const seg of segments) {
            if (seg.kind === 'key') {
              dispatchSpecialKey(currentEl, seg.name);
              // Let async handlers / focus moves settle, then track the new active element
              await new Promise(r => setTimeout(r, 30));
              const active = document.activeElement;
              if (active && active !== document.body && active.isConnected) {
                currentEl = active;
              }
              justTransitioned = true;
              continue;
            }

            // Text segment
            const value = seg.value;
            const shouldClear = !typeAppend && justTransitioned;

            if (typePaste) {
              await typeViaPaste(currentEl, value, !shouldClear);
              justTransitioned = false;
              continue;
            }

            if (currentEl.isContentEditable) {
              typeIntoContentEditable(currentEl, value, !shouldClear);
              justTransitioned = false;
              continue;
            }

            // Native input/textarea path
            if (shouldClear && 'value' in currentEl) {
              currentEl.value = '';
              currentEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            for (const char of value) {
              if ('value' in currentEl) currentEl.value += char;
              currentEl.dispatchEvent(new Event('input', { bubbles: true }));
              currentEl.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
              currentEl.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
              if (charDelay > 0) await new Promise(r => setTimeout(r, charDelay));
            }
            currentEl.dispatchEvent(new Event('change', { bubbles: true }));
            justTransitioned = false;
          }

          flashHighlight(el, 'success', 200);
          return { success: true };
        }

        case 'waitElement': {
          // #6 — Wait modes: appears (default) | disappears | enabled | text-match
          const mode = waitMode || 'appears';
          const el = await waitForElement(selector, timeout, mode, msg.text);
          if (el) {
            actionEl = el;
            flashHighlight(el, 'success', 200);
          }
          return { success: true };
        }

        case 'navigate': {
          // background.js handles tab-level navigation; this same-tab fallback only fires
          // if invoked directly on a content script (legacy path). Validate the scheme — refuse
          // javascript:/data: which would otherwise execute in the page context (XSS sink).
          let parsedNav;
          try { parsedNav = new URL(url, location.href); } catch { parsedNav = null; }
          if (!parsedNav || (parsedNav.protocol !== 'http:' && parsedNav.protocol !== 'https:')) {
            throw mkError('INVALID_URL', 'Refusing to navigate to a non-http(s) URL.', 'Use an http:// or https:// URL.');
          }
          window.location.href = parsedNav.href;
          return { success: true };
        }

        // #7 — New helper command: wait for current URL to match a pattern (glob or regex)
        case 'waitUrl': {
          const pattern = msg.urlPattern || '';
          if (!pattern) return { success: true };
          const matches = (u) => urlMatchesPattern(u, pattern);
          if (matches(location.href)) return { success: true };

          return await new Promise((resolve, reject) => {
            let resolved = false;
            const cleanup = () => {
              window.removeEventListener('popstate', check);
              clearInterval(intv);
            };
            const timer = setTimeout(() => {
              if (resolved) return;
              resolved = true;
              cleanup();
              const seconds = Math.round(timeout / 1000);
              reject(mkError('NAVIGATION_TIMEOUT',
                `URL didn't match pattern after ${seconds}s.`,
                'Check the pattern (glob or /regex/). Current URL: ' + location.href));
            }, timeout);

            const check = () => {
              if (matches(location.href)) {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                cleanup();
                resolve({ success: true });
              }
            };
            window.addEventListener('popstate', check);
            const intv = setInterval(check, 200);
          });
        }

        case 'selectOption': {
          // Native <select> dropdowns can't be opened programmatically (browser
          // blocks .click()), and their <option> children fail visibility checks.
          // The standard automation pattern is to set `.value` directly and
          // dispatch `change` / `input` events. This command exposes that path.
          const el = await waitForElement(selector, timeout, 'appears');
          actionEl = el;

          if (el.tagName !== 'SELECT') {
            throw mkError('NOT_A_SELECT',
              `Element ${selector} isn't a native <select> (tagName=${el.tagName}).`,
              'Use BrowserClick for div-based dropdowns (React-Select, ant.d, Select2, etc.).');
          }

          const mode = selectMatchMode || 'text';
          const target = (text || '').trim();
          let option = null;
          if (mode === 'value') {
            option = Array.from(el.options).find(o => o.value === target);
          } else if (mode === 'index') {
            const i = parseInt(target, 10);
            if (!isNaN(i) && i >= 0 && i < el.options.length) option = el.options[i];
          } else {
            // 'text' or unknown → default to text match (trimmed both sides)
            option = Array.from(el.options).find(o => o.text.trim() === target);
          }

          if (!option) {
            throw mkError('OPTION_NOT_FOUND',
              `No <option> matched "${target}" (mode=${mode}).`,
              'Check Match Mode and the exact option label/value.');
          }
          if (option.disabled) {
            throw mkError('OPTION_DISABLED',
              `The matched <option> "${option.text.trim()}" is disabled.`,
              'Wait for the option to become enabled, or pick a different one.');
          }

          el.value = option.value;
          // Dispatch both change and input — different libs / frameworks listen to one or the other.
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          flashHighlight(el, 'success', 200);

          return {
            success: true,
            selectedValue: option.value,
            selectedText: option.text.trim(),
          };
        }

        default:
          throw mkError('UNKNOWN_COMMAND', `Unknown command: ${command}`, null);
      }
    } catch (err) {
      // Flash error highlight if we identified the element
      if (actionEl) flashHighlight(actionEl, 'error', 600);

      // err can be a structured {code, message, tip} or a native Error
      if (err && typeof err === 'object' && err.code) {
        return { success: false, error: { code: err.code, message: err.message, tip: err.tip || null } };
      }
      return { success: false, error: { code: 'UNKNOWN_ERROR', message: err?.message || String(err), tip: null } };
    }
  }

  // #7 — URL pattern matching: supports glob (*) and /regex/flags syntax
  function urlMatchesPattern(url, pattern) {
    if (!pattern) return true;
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const last = pattern.lastIndexOf('/');
      const pat = pattern.slice(1, last);
      const flags = pattern.slice(last + 1);
      try { return new RegExp(pat, flags).test(url); } catch { return false; }
    }
    // Glob: escape regex metas, then convert * → .* and ? → .
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try { return new RegExp('^' + escaped + '$').test(url); } catch { return false; }
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
        }).catch((err) => {
          // Without this, a thrown command leaves the caller awaiting a response forever.
          sendResponse({ success: false, error: (err && (err.message || err.error)) || String(err) });
        });
        return true; // async response

      case 'pickElement':
        // Single-pick mode: highlights elements, returns selector + alternatives, ESC cancels
        pickResolve = (selector, alternatives) => {
          sendResponse({ selector, alternatives });
        };
        startPick();
        return true; // async response

      case 'cancelPick':
        // App aborted the pick (editor switched/closed) — stop highlighting. stopPick resolves the
        // pending pickElement response with null, so the in-flight request completes cleanly.
        if (picking) stopPick(null, []);
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: true });
    }
  });

  // Recording state arrives via 'setRecording' broadcasts, but a page loaded
  // MID-recording (the user navigated while recording) gets a fresh content script
  // that never saw the broadcast — browser events on the new page silently stopped
  // being captured. Pull the current state from the background on load so recording
  // survives navigations.
  try {
    chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
      if (chrome.runtime.lastError) return;
      if (status && status.recording) startRecording();
    });
  } catch { /* extension context invalidated (e.g. extension was reloaded) */ }
})();
