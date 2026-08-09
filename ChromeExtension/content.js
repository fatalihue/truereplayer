(() => {
  const isMainFrame = window === window.top;

  /**
   * The overlay nodes flashHighlight created, held by identity.
   *
   * This used to be a `data-tr-overlay` attribute, which put the answer to "is this node ours?"
   * inside the DOM — where the page can read it and, more to the point, WRITE it. A page that
   * stamps the attribute on everything it mutates makes waitForClickEffect discard every record,
   * so `landed` stays false and the click falls through to the native `el.click()` fallback. The
   * comment on that fallback already names the cost: duplicate orders, duplicate messages, a
   * counter that reads 2.
   *
   * A WeakSet in this closure is not reachable from page script at all, and it holds the nodes
   * weakly so a removed overlay is still collectable.
   */
  const ourOverlays = new WeakSet();

  /**
   * Which frame am I?
   *
   * A content script cannot ask Chrome for its own frameId — MV3 has no API for it — but the
   * service worker sees it as `sender.frameId` on anything we send. So the answer is fetched
   * once, lazily, and cached for the life of this document. A frameId is stable while the frame
   * lives, and a new document gets a new content script and therefore a fresh cache.
   *
   * This exists for the frame election in background.js: a browser action still fans out to
   * every frame to FIND its element, so the frame that matched has to be able to NAME itself,
   * or the half of the command that actually mutates the page cannot be aimed at it alone.
   *
   * The main frame is 0 by definition and answers without a round trip, so the handshake only
   * ever costs anything on a page whose target really is inside an iframe, and only on that
   * frame's first action. A failure resolves to null and is deliberately NOT cached as an
   * answer: the background then falls back to probing the main frame, which is where every
   * RECORDED selector points anyway, and the next action tries the handshake again.
   */
  let myFrameId = isMainFrame ? 0 : null;
  let frameIdPending = null;
  function ensureFrameId() {
    if (myFrameId !== null) return Promise.resolve(myFrameId);
    if (frameIdPending) return frameIdPending;
    const pending = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'whichFrame' }, (reply) => {
          if (!chrome.runtime.lastError && reply && typeof reply.frameId === 'number') {
            myFrameId = reply.frameId;
          }
          resolve(myFrameId);
        });
      } catch {
        resolve(null); // extension context invalidated (extension reloaded) — page must reload
      }
    }).then((id) => {
      if (id === null) frameIdPending = null; // let the next action retry instead of remembering "unknown"
      return id;
    });
    frameIdPending = pending;
    return pending;
  }

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
  // G1 — the selector/alternatives computed for this field when it was CLICKED, not recomputed
  // at flush time. See flushTypingObserver for why recomputing is not equivalent.
  let _typingObserverSelector = '';
  let _typingObserverAlternatives = [];

  const { generateSelector, generateSelectorAlternatives, getElementDescription } =
    window.__trueReplayerSelectorGenerator || {};

  /**
   * G1 — Ranked fallback selectors for a recorded element.
   *
   * Only the crosshair picker used to call this, so every RECORDED action shipped as a single
   * candidate: when the page drifted there was nothing to fall back to, and the primary a
   * recording produces is the WEAKEST kind (generateSelector ends at buildNthChildPath).
   *
   * The primary deliberately stays generateSelector's output rather than alternatives[0]. Two
   * reasons: the C# recorder matches a later typingCaptured to the BrowserType row it created by
   * exact `Key == selector` string equality, and the tier ranking depends on document-wide
   * uniqueness (isTextUnique walks the whole DOM), so it can legitimately answer differently a
   * few seconds apart on a live page. generateSelector is the stable choice for the identity
   * string; the ranked list rides along purely as replay fallback, which is what G1 is about.
   *
   * Never throws — a recording that loses an action because the fallback generator tripped over
   * an exotic DOM is strictly worse than an action with no fallbacks.
   */
  function selectorAlternativesFor(el) {
    if (!generateSelectorAlternatives) return [];
    try { return generateSelectorAlternatives(el) || []; } catch { return []; }
  }

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

    const alternatives = selectorAlternativesFor(el);
    const description = getElementDescription?.(el) || '';

    // Detect input-like elements for auto BrowserType
    const tag = el.tagName.toLowerCase();
    const isInput = tag === 'textarea'
      || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes(el.type))
      || el.isContentEditable;

    chrome.runtime.sendMessage({
      type: 'elementClicked',
      selector,
      alternatives,
      description,
      tagName: tag,
      button: e.type === 'contextmenu' ? 'right' : 'left',
      isInput,
    });

    // #10 — If user clicked into an input/contentEditable, start observing typing
    if (isInput) {
      startTypingObserver(el, selector, alternatives);
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
      alternatives: selectorAlternativesFor(el),
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
  function startTypingObserver(el, selector, alternatives) {
    flushTypingObserver(); // commit any pending observer first

    _typingObserver = el;
    _typingObserverInitial = el.isContentEditable ? (el.textContent || '') : (el.value || '');
    _typingObserverSelector = selector || '';
    _typingObserverAlternatives = alternatives || [];

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
    // Captured before the reset below, and NOT recomputed. The C# recorder fills the
    // BrowserType row created by the click that focused this field, and it finds that row by
    // exact selector-string equality — so the two must be the same string by construction, not
    // by two generator runs happening to agree. They can disagree: the page moves between the
    // click and the blur (that is what the user was doing in between), and generateSelector's
    // ladder is uniqueness-sensitive at every rung. When they disagreed the typing landed in a
    // SECOND BrowserType row instead of the first, so replay clicked the field and then typed
    // into it twice.
    const selector = _typingObserverSelector || generateSelector?.(el);
    const alternatives = _typingObserverAlternatives;
    const current = el.isContentEditable ? (el.textContent || '') : (el.value || '');

    // Detach listeners
    if (_typingObserverHandler) el.removeEventListener('input', _typingObserverHandler, true);
    if (_typingObserverBlur) el.removeEventListener('blur', _typingObserverBlur, true);
    _typingObserver = null;
    _typingObserverHandler = null;
    _typingObserverBlur = null;
    _typingObserverInitial = '';
    _typingObserverSelector = '';
    _typingObserverAlternatives = [];

    // Compute typed delta
    let typed = current;
    let isAppend = false;
    if (initial && current.startsWith(initial)) {
      typed = current.slice(initial.length);
      isAppend = true;
    }

    if (typed.length === 0) return;
    if (!selector) return;

    chrome.runtime.sendMessage({
      type: 'typingCaptured',
      selector,
      // Only used when no BrowserType row matches (typing in a field the extension never saw
      // clicked); the bridge creates a fresh action there and it deserves fallbacks like any
      // other. When a row DOES match, the click already stored the same list on it.
      alternatives,
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
      alternatives: selectorAlternativesFor(el),
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
    // The hover handlers are SHARED with recording, and a DOM listener is keyed by
    // (type, function, capture) — startRecording and startPick register the very same function
    // references, so there is only ever ONE registration. Removing it here while recording is
    // still on took the element highlight away for the rest of the session: pick an element
    // mid-recording and the blue outline never came back, with nothing to suggest why.
    if (!recording) {
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('mouseout', onMouseOut, true);
    }
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

  // #4 — Smart scrollIntoView: skip if already in viewport.
  // Returns whether it actually scrolled, so the caller can settle only when there is something
  // to settle. The click path used to sleep a flat 30 ms right after calling this, whether or not
  // the page had moved a pixel.
  function scrollIntoViewIfNeeded(el) {
    const rect = el.getBoundingClientRect();
    const inView =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth);
    if (inView) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  }

  // One animation frame — tied to real layout instead of guessing in milliseconds. Falls back to
  // a timer in a hidden tab, where rAF never fires and the wait would otherwise hang (the
  // automation daemon acting on a background tab is exactly that case).
  function nextFrame() {
    return new Promise((r) => {
      // Race rAF against a timer instead of committing to a branch on one synchronous read of
      // visibilityState. The read happens when the promise is CREATED; if the tab goes hidden
      // during the await — the user switches tabs, the daemon fronts another window, the next
      // action's ActivateWindow steals focus — a pending rAF callback simply never runs, and this
      // promise never settles. executeCommand then never returns, the content script never calls
      // sendResponse, and the step dies only when the C# pipe gives up, reporting
      // ELEMENT_NOT_FOUND about an element that was found and a click that got stuck.
      // waitUncovered holds that window open for up to a second on every covered click.
      // The timer also covers a throttled frame, which the top document's visibilityState cannot see.
      let done = false;
      const fire = () => { if (done) return; done = true; r(); };
      requestAnimationFrame(fire);
      setTimeout(fire, 50);
    });
  }

  /**
   * Is anything on top of the target? Retried for a short budget instead of sampled once.
   *
   * The single sample happened immediately after the scroll, which is precisely the moment a
   * cookie banner, a toast or a spinner mid-fade is still over the element — elementFromPoint
   * returns the overlay and the step died with ELEMENT_COVERED while its whole timeout budget sat
   * unspent. Overlays clear in a few frames; a wait measured in frames costs nothing when the
   * element is already clear (the first check answers and the loop never runs).
   */
  async function waitUncovered(el, budgetMs) {
    const deadline = Date.now() + budgetMs;
    let covering = getCoveringElement(el);
    while (covering && Date.now() < deadline) {
      await nextFrame();
      covering = getCoveringElement(el);
    }
    return covering;
  }

  const CLICK_STATE_ATTRS = ['aria-expanded', 'aria-pressed', 'aria-checked'];

  // Snapshot of the signals that say "this click landed". getAttribute('class') rather than
  // .className because on an SVG element .className is an SVGAnimatedString — the SAME object
  // every time — so comparing it could never report a change.
  function clickSnapshot(el) {
    return {
      href: location.href,
      active: document.activeElement,
      cls: el.getAttribute('class'),
      aria: CLICK_STATE_ATTRS.map((a) => el.getAttribute(a)).join('|'),
    };
  }

  function clickChanged(el, snap) {
    return !el.isConnected
      || location.href !== snap.href
      || document.activeElement !== snap.active
      || el.getAttribute('class') !== snap.cls
      || CLICK_STATE_ATTRS.map((a) => el.getAttribute(a)).join('|') !== snap.aria;
  }

  /**
   * Wait up to budgetMs for evidence the click had an effect, resolving the INSTANT one shows up.
   *
   * What this replaces: a flat 200 ms sleep followed by comparing three snapshots. That sleep was
   * paid on every single BrowserClick and is most of the gap between it and BrowserRightClick,
   * which does identical work in 80 ms. And the comparison could not do its job, because
   * `el.focus()` ran BEFORE the "before" snapshot was compared — so for anything focusable
   * (button, a, input — nearly every click target) the focus check always reported a change and
   * the native fallback was unreachable. What remained was the non-focusable div/span, which also
   * changes no class and no aria-*, so the fallback fired exactly THERE and el.click() re-ran a
   * React onClick that had already fired: one click, two submissions.
   *
   * SCOPE — ANY page mutation counts, except our own overlay. This was tried the other way first,
   * restricted to the element, its ancestors and fresh body insertions, on the reasoning that a
   * ticker or a lazy image should not suppress a fallback that was needed. A live run demolished
   * it: the most ordinary handler there is — click a button, a counter ELSEWHERE on the page goes
   * up — matches none of those, so the fallback fired on top of a click that had already worked
   * and every action ran TWICE. Measured as exactly 2x, 6x and 2x against expected 1, 3 and 1.
   *
   * The two failure directions are not symmetric, which settles it:
   *   too loose  → an unrelated mutation suppresses the fallback, so a click that did nothing is
   *                reported as done. That is also what shipped for years, since the old heuristic
   *                could never reach the fallback for focusable elements at all.
   *   too tight  → a click that worked is dispatched a SECOND time. Duplicate orders, duplicate
   *                messages, a counter that reads 2.
   * Doing the action twice is far worse than not detecting that it worked, so err loose.
   */
  function waitForClickEffect(el, snap, budgetMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(v);
      };

      // flashHighlight appends a marked div straight into body right before the click and removes
      // it after. Both the insertion AND the removal are mutations, and counting either made the
      // detector read TrueReplayer's own highlight as proof the page reacted — which is how the
      // fallback became unreachable for the very elements it exists to rescue. Note this cannot be
      // done by filtering the record's TARGET: a childList record reports the PARENT, so an
      // overlay appended to body arrives as a mutation on body. The added/removed nodes are what
      // have to be inspected.
      const isOurs = (n) => ourOverlays.has(n);

      const observer = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'childList') {
            // A record whose ONLY added/removed nodes are our own overlay is our own doing.
            let real = false;
            for (const n of r.addedNodes) if (!isOurs(n)) { real = true; break; }
            if (!real) for (const n of r.removedNodes) if (!isOurs(n)) { real = true; break; }
            if (real) return finish(true);
            continue;
          }
          // attributes / characterData: the target IS the changed node, so filtering it works here.
          if (!isOurs(r.target)) return finish(true);
        }
        if (clickChanged(el, snap)) finish(true);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      const timer = setTimeout(() => finish(clickChanged(el, snap)), budgetMs);
    });
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

  // An element's OWN text nodes, excluding descendants. Written as a plain sibling walk because
  // it runs for every element in the document during a text search: the previous
  // Array.from(childNodes).filter().map().join() allocated three intermediate arrays per node.
  // Joining with ' ' between EVERY text node (empties included) before the final trim is not an
  // accident — it reproduces the old join() exactly, down to the double space an empty node in
  // the middle produces, so no existing text= selector changes what it matches.
  function directTextOf(el) {
    let out = '';
    let first = true;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      if (!first) out += ' ';
      out += n.textContent.trim();
      first = false;
    }
    return out.trim();
  }

  // Compile a regex selector ONCE per parse instead of once per element examined, and cache it on
  // the parsed object (which lives for exactly one waitForElement call). `g` and `y` are stripped:
  // they make .test() stateful via lastIndex, which a fresh-regex-per-call could ignore but a
  // cached one cannot — with them a match would flip on and off between elements.
  function ensureRegex(parsed) {
    if (parsed._re === undefined) {
      try {
        parsed._re = new RegExp(parsed.value, (parsed.flags || '').replace(/[gy]/g, ''));
      } catch {
        parsed._re = null;
      }
    }
    return parsed._re;
  }

  // #1 — Does one string satisfy the parsed text selector?
  function matchesText(text, parsed) {
    switch (parsed.mode) {
      case 'exact':
        return text === parsed.value;
      case 'contains':
        return text.includes(parsed.value);
      case 'icontains':
        return text.toLowerCase().includes(parsed.value.toLowerCase());
      case 'regex': {
        const re = ensureRegex(parsed);
        return re ? re.test(text) : false;
      }
      default:
        return false;
    }
  }

  // #1 — Test if element text matches the parsed text selector.
  // elTextIn / directTextIn let a caller that ALREADY computed them (the document walk below) pass
  // them in. textContent is O(subtree), and the walk used to read it twice per element and rebuild
  // the direct text a third time for the ranking.
  function elementTextMatches(el, parsed, elTextIn, directTextIn) {
    const directText = directTextIn !== undefined ? directTextIn : directTextOf(el);
    const elText = elTextIn !== undefined ? elTextIn : (el.textContent || '').trim();
    return matchesText(directText, parsed) || matchesText(elText, parsed);
  }

  /**
   * #1 — Find element by parsed text selector, ranking direct-text matches and
   * deeper (more specific) elements higher.
   *
   * `includeHidden` opts OUT of the visibility filter below, and exists for exactly one caller:
   * findExisting, which asks "does this match anything AT ALL". It is a parameter rather than a
   * change of meaning for everyone because the filter is not a courtesy to the other callers —
   * it decides which element wins the ranking. A hidden twin of the same label (the mobile copy
   * of a nav, a collapsed menu, a modal pre-rendered as display:none) is usually DEEPER than the
   * on-screen one, so it outranks it. Drop the filter globally and findElementForMode gets handed
   * that twin and reports "not found" about a control plainly on screen, while checkDisappears
   * reads the same twin as proof the element has gone.
   */
  function findByParsedText(parsed, includeHidden = false) {
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      // Both strings computed ONCE and threaded through everything that needs them. This loop is
      // the body of the check that re-runs on every DOM mutation while a text wait is pending, so
      // the per-node cost is paid thousands of times per second on a live page.
      const elText = el.textContent?.trim();
      if (!elText) continue;
      const directText = directTextOf(el);

      if (!elementTextMatches(el, parsed, elText, directText)) continue;
      if (!includeHidden && !isVisible(el)) continue;

      // Direct-text match preference — the same scalar test, on the direct text alone.
      // getDepth stays per-CANDIDATE (not per-node): only elements that already matched reach it.
      candidates.push({
        el,
        directMatch: !!directText && matchesText(directText, parsed),
        depth: getDepth(el),
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.directMatch - a.directMatch) || (b.depth - a.depth));
    return promoteToInteractive(candidates[0].el, parsed);
  }

  // A text locator names what the user SEES, but the visible text usually lives on an inner
  // wrapper: <button><span>Sign in</span></button> resolves to the SPAN (it wins the ranking above
  // on direct-text match). Clicking still works — the event bubbles — which is exactly why this
  // was invisible. Everything else does not: isInteractable/isVisible/getCoveringElement then run
  // against a span that has no `disabled`, so a DISABLED button reports as enabled, an "enabled"
  // wait passes on a dead control, and BrowserAssert green-lights it.
  //
  // So promote the hit to its nearest interactive ancestor, but ONLY when that ancestor still
  // carries the same text — that proves we are climbing the label's own control rather than
  // escaping into an unrelated container that happens to be nearby. If the wrapper has no such
  // ancestor, or the ancestor's text no longer matches, the original element is returned
  // unchanged.
  function promoteToInteractive(el, parsed) {
    if (!el) return el;
    const interactiveTags = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
    const interactiveRoles = new Set(['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio']);
    const isInteractive = (n) =>
      interactiveTags.has(n.tagName) || interactiveRoles.has(n.getAttribute('role'));

    if (isInteractive(el)) return el;

    let current = el.parentElement;
    for (let i = 0; i < 5 && current && current !== document.body; i++) {
      if (isInteractive(current)) {
        return elementTextMatches(current, parsed) && isVisible(current) ? current : el;
      }
      current = current.parentElement;
    }
    return el;
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
        // A BARE pattern means exact, which is what the editor's hint promises ("plain text =
        // exact"). parseTextSelector returns {kind:'css'} with NO mode for an unprefixed string,
        // and elementTextMatches' switch has no case for undefined — so every plain text-match
        // silently returned false and the wait/assert just timed out. Defaulted HERE rather than
        // inside parseTextSelector: that function's bare-string branch is what classifies ordinary
        // CSS selectors, and giving it a text mode would reclassify every selector in the app.
        const parsedText = parseTextSelector(textPattern);
        const textCriteria = parsedText.kind === 'text'
          ? parsedText
          : { kind: 'text', mode: 'exact', value: textPattern };
        return elementTextMatches(el, textCriteria) ? el : null;
      }
      default:
        return isVisible(el) ? el : null;
    }
  }

  // Attributes that isVisible / isInteractable actually read. The observer used to watch EVERY
  // attribute on every element under document.body, which on a live page means style recalcs,
  // animation classes, progress bars and ad frames all waking a check that cannot possibly care.
  const WATCHED_ATTRIBUTES = ['class', 'style', 'hidden', 'disabled', 'aria-disabled', 'aria-hidden', 'open'];

  /**
   * The engine behind every wait: run `check` when the page changes, and stop when it says so.
   *
   * Two things it fixes over the plain MutationObserver it replaces.
   *
   * CORRECTNESS — the observer was the ONLY thing that could wake a wait, so any state change
   * that does not mutate anything under document.body was invisible. A stylesheet finishing its
   * load (it lands in <head>), a class toggled on <html> (outside the observed root), a media
   * query, a transition settling — in all of those the element becomes visible and the wait sits
   * there until it times out, then reports "not found" about something plainly on screen. The
   * user reads that as a broken selector and goes off to re-pick a selector that was fine. A
   * 250 ms safety poll turns those from a full-timeout failure into a quarter-second delay.
   *
   * COST — the callback is coalesced to at most one check per frame. Uncoalesced, a React page
   * fires it dozens of times a second and each call sweeps the whole candidate list, which for a
   * text selector means a full-document TreeWalker. rAF deliberately falls back to a timer when
   * the tab is hidden: rAF does not run there, and a hidden tab is exactly the automation-daemon
   * case, so without the fallback the wait would stall precisely when nobody is watching.
   */
  function makeWatcher(candidates, check) {
    let done = false;
    let scheduled = false;
    let observer = null;
    let poll = null;
    let timer = null;

    const cleanup = () => {
      done = true;
      if (observer) { observer.disconnect(); observer = null; }
      if (poll) { clearInterval(poll); poll = null; }
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const evaluate = () => {
      if (done) return;
      let satisfied = false;
      try { satisfied = check(); } catch { satisfied = false; }
      if (satisfied) cleanup();
    };

    const schedule = () => {
      if (scheduled || done) return;
      scheduled = true;
      const run = () => { scheduled = false; evaluate(); };
      if (document.visibilityState === 'hidden') setTimeout(run, 0);
      else requestAnimationFrame(run);
    };

    return {
      start(timeoutMs, onTimeout) {
        timer = setTimeout(() => {
          if (done) return;
          cleanup();
          onTimeout();
        }, timeoutMs);

        observer = new MutationObserver(schedule);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: WATCHED_ATTRIBUTES,
          // Text mutations only matter when something is actually matching on text.
          characterData: candidates.some(c => c.parsed && c.parsed.kind === 'text'),
        });

        poll = setInterval(evaluate, 250);
      },
    };
  }

  // Does this selector match ANYTHING at all, regardless of visibility or enabled state?
  // Used only to tell "the primary is gone" apart from "the primary is here but not ready",
  // which is what decides whether falling back to another candidate is legitimate.
  //
  // "Regardless of visibility" has to hold for BOTH kinds, or the guard below answers a different
  // question depending on which kind of selector the recorder happened to produce for the same
  // element. The CSS branch is a raw querySelector and already ignores visibility; the text branch
  // filters to visible by default and has to be told not to here. Agreeing the other way — making
  // CSS visibility-aware — would be the wrong direction: a present-but-hidden primary (a modal
  // that has not opened yet, a control still display:none) is the "here but not ready" case, and
  // waiting for it is precisely what the guard is for. Treating it as gone lets a tier-B/C
  // fallback act on a lookalike while the intended element is sitting right there.
  //
  // Only truthiness is read at the call site, so it does not matter that includeHidden can change
  // WHICH of several matches wins the ranking, or that promoteToInteractive will decline to climb
  // to a hidden interactive ancestor.
  function findExisting(parsed) {
    if (parsed.kind === 'text') return findByParsedText(parsed, true);
    try { return document.querySelector(parsed.value); } catch { return null; }
  }

  // Set by waitForElement when a FALLBACK selector (not the primary) matched; cleared at
  // the start of every executeCommand. The command dispatcher attaches it to the success
  // response so the C# side can log which tier saved the run.
  let lastFallbackMatch = null;

  /**
   * #6 — waitForElement with mode support.
   *   appears (default) — element exists and is visible
   *   disappears — element is gone or invisible
   *   enabled — element exists, visible, and not disabled
   *   text-match — element exists, visible, and its text matches textPattern
   *
   * `alternatives` (optional) — ranked fallback selectors ({selector, tier}) captured at
   * pick time. On every check the candidates are tried in order (primary first), so a
   * drifted primary falls through to tier B/C within the SAME timeout window instead of
   * failing. Disappears mode ignores them: "gone" must mean the PRIMARY element is gone —
   * a tier-C nth-child fallback could match a different element forever and never
   * disappear.
   */
  async function waitForElement(selector, timeout = 30000, mode = 'appears', textPattern = null, alternatives = null) {
    const parsed = parseTextSelector(selector);

    // #8 — Validate CSS selector syntax up front for clearer error
    if (parsed.kind === 'css' && !isValidCssSelector(parsed.value)) {
      throw mkError(
        'SELECTOR_INVALID',
        'CSS selector is invalid.',
        'Check syntax — selector failed querySelector validation.'
      );
    }

    // Candidate list: primary first, then the pick-time alternatives (deduped against the
    // primary, invalid CSS skipped silently — a broken fallback must never break the run).
    const candidates = [{ selector, parsed, tier: null }];
    if (mode !== 'disappears' && Array.isArray(alternatives)) {
      for (const alt of alternatives) {
        if (!alt || typeof alt.selector !== 'string' || !alt.selector || alt.selector === selector) continue;
        const altParsed = parseTextSelector(alt.selector);
        if (altParsed.kind === 'css' && !isValidCssSelector(altParsed.value)) continue;
        candidates.push({ selector: alt.selector, parsed: altParsed, tier: alt.tier || 'C' });
      }
    }

    const checkPositive = () => {
      // Fallbacks answer "the primary no longer FINDS anything" — never "the primary found the
      // element and it is not ready yet". The distinction did not exist while click/type used
      // 'appears', because a visible primary always won at i=0. Under 'enabled' a primary that is
      // present but disabled returns null from findElementForMode, and without this guard the loop
      // would walk on and act on whatever a tier-B/C fallback matched instead — a different
      // element, chosen precisely because the intended one was not ready. Waiting for the real
      // button to enable is the whole point; clicking a lookalike while it is disabled is the one
      // outcome worse than timing out.
      if (candidates.length > 1 && findExisting(candidates[0].parsed)) {
        return findElementForMode(candidates[0].parsed, mode, textPattern);
      }
      for (let i = 0; i < candidates.length; i++) {
        const el = findElementForMode(candidates[i].parsed, mode, textPattern);
        if (el) {
          if (i > 0) {
            lastFallbackMatch = { selector: candidates[i].selector, tier: candidates[i].tier };
            console.info('[TrueReplayer] Primary selector failed — matched via fallback', lastFallbackMatch);
          }
          return el;
        }
      }
      return null;
    };
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

      // timeout <= 0 = instant single-check probe (If Browser Element) — evaluate once and
      // answer now; never allocate the observer/timer machinery below.
      if (timeout <= 0) {
        throw mkError('ELEMENT_NOT_FOUND', 'Element still present.',
          'Instant probe: the element has not disappeared.');
      }

      return new Promise((resolve, reject) => {
        const w = makeWatcher(candidates, () => {
          if (!checkDisappears()) return false;
          resolve(null);
          return true;
        });
        w.start(timeout, () => {
          const seconds = Math.round(timeout / 1000);
          reject(mkError(
            'ELEMENT_NOT_FOUND',
            `Element still present after ${seconds}s.`,
            'Element did not disappear in time. Increase the timeout or check selector.'
          ));
        });
      });
    }

    // Positive modes (appears, enabled, text-match)
    const found = checkPositive();
    if (found) return found;

    // timeout <= 0 = instant single-check probe — same rule as the disappears branch above.
    if (timeout <= 0) {
      throw mkError('ELEMENT_NOT_FOUND',
        candidates.length > 1 ? `Element not found (tried ${candidates.length} selectors).` : 'Element not found.',
        'Instant probe: no selector matched the required state.');
    }

    return new Promise((resolve, reject) => {
      const w = makeWatcher(candidates, () => {
        const f = checkPositive();
        if (!f) return false;
        resolve(f);
        return true;
      });
      w.start(timeout, () => {
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
        } else if (candidates.length > 1) {
          reject(mkError('ELEMENT_NOT_FOUND',
            `Element not found after ${seconds}s (tried ${candidates.length} selectors).`,
            'Primary selector and all pick-time fallbacks failed — the page changed too much. Re-pick the element.'));
        } else {
          reject(mkError('ELEMENT_NOT_FOUND', `Element not found after ${seconds}s.`,
            'Page might be loading slowly, or selector doesn\'t match anything. Try Pick again.'));
        }
      });
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
    // Marks this node as ours so waitForClickEffect can ignore it. Recorded by identity in a
    // closure-scoped WeakSet rather than as a DOM attribute — see ourOverlays for why the page
    // must not be able to claim this.
    ourOverlays.add(overlay);
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

  /**
   * Write a form control's value through the PROTOTYPE's setter instead of the instance property.
   *
   * React installs a value tracker on every controlled input. Assigning `el.value = x` updates the
   * DOM but leaves that tracker holding the old string, so when the 'input' event arrives React
   * compares the two, sees no change, and never fires onChange. On a controlled field the visible
   * result is text that appears and is then wiped by the next render, or a submit button that
   * stays disabled — while the extension cheerfully reports success:true. Most modern forms are
   * controlled, so this was the quiet failure behind "the macro types but nothing happens".
   *
   * The contentEditable path never had the problem because it goes through execCommand, whose own
   * comment says it "fires native input events that frameworks listen to". The native-input path
   * was simply left out of that reasoning. Going through the prototype setter is exactly what the
   * browser does when a human types.
   */
  function setNativeValue(el, value) {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) { desc.set.call(el, value); return; }
    } catch { /* fall through to the plain assignment */ }
    el.value = value;
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
        setNativeValue(el, '');
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
        setNativeValue(el, text);
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

      setNativeValue(el, newValue);
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
      alternatives,
    } = msg;

    lastFallbackMatch = null; // per-command reset — see the declaration near waitForElement
    let actionEl = null;
    try {
      switch (command) {
        case 'click': {
          // Wait for the element to be ENABLED, not merely present. waitForElement has had this
          // mode all along and the click simply never used it: it checked isInteractable ONCE,
          // microseconds after the element appeared, then failed with a tip literally instructing
          // the user to go build a second action ("use Wait with mode=enabled"). A submit button
          // that enables 300 ms after form validation therefore failed every time with its whole
          // timeout budget unspent. ELEMENT_DISABLED is still reported — by waitForElement's
          // timeout classifier, once the window is genuinely exhausted rather than at 0 ms.
          const el = await waitForElement(selector, timeout, 'enabled', null, alternatives);
          actionEl = el;

          // Settle only if the page actually moved.
          if (scrollIntoViewIfNeeded(el)) await nextFrame();

          // #4 — Reject if covered by another element (modal, sticky header, tooltip)
          const coveredBy = await waitUncovered(el, Math.min(1000, timeout));
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
                setNativeValue(el, option.value);
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
          await nextFrame();

          el.focus();
          // Snapshot AFTER focus() — that call is OURS, and letting it count as "the page
          // reacted" is what made the fallback below unreachable for every focusable element.
          const snap = clickSnapshot(el);

          el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          // KEEP this one. Some sites measure how long the button was held to tell a click from
          // the start of a drag, and an instantaneous down/up reads as neither.
          await new Promise(r => setTimeout(r, 30));
          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
          el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));

          // Synchronous handlers have already run by now, so check before waiting at all.
          // Frameworks that batch (React) land a frame later, which the observer catches.
          let landed = clickChanged(el, snap);
          if (!landed) landed = await waitForClickEffect(el, snap, 200);

          // #4 — Native .click() only when the synthetic sequence produced NO observable effect.
          // Guarded on the element still being in the document: a click that removed its own
          // target obviously worked, and re-clicking a detached node is meaningless.
          if (!landed && el.isConnected) {
            try { el.click(); } catch { /* swallow */ }
          }

          flashHighlight(el, 'success', 200);
          return { success: true };
        }

        case 'rightClick': {
          // Same 'enabled' wait and same covered retry as click — see the notes there.
          const el = await waitForElement(selector, timeout, 'enabled', null, alternatives);
          actionEl = el;

          if (scrollIntoViewIfNeeded(el)) await nextFrame();

          const coveredBy = await waitUncovered(el, Math.min(1000, timeout));
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
          // A frame, not a flat 50 ms — hover menus react on the next paint, and this keeps
          // rightClick and click on the same clock.
          await nextFrame();

          el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          await new Promise(r => setTimeout(r, 30)); // held-duration signal, same as click
          el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
          el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('contextmenu', { ...opts, buttons: 0 }));

          flashHighlight(el, 'success', 200);
          return { success: true };
        }

        case 'type': {
          // 'enabled' for the same reason as click: a field that a form enables a moment later is
          // the normal case, not an error, and the old 0 ms check turned it into one.
          const el = await waitForElement(selector, timeout, 'enabled', null, alternatives);
          actionEl = el;

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

          // typeDelay arrives as JSON null whenever the user leaves "Delay per char" blank, and
          // `typeof null === 'object'` — so the ternary fell straight through to the automatic
          // branch and EVERY text over 20 characters silently paid 5 ms per character. 500
          // characters is 2.5 s of pure sleep the user never asked for, and it is what pushed long
          // BrowserType actions past the pipe timeout, making the C# side report "field not found"
          // about a field it had already found and was busy filling.
          // Default to 0 and keep ONE event per character: the compatibility that matters is the
          // per-char event stream, not the pause between them. Anyone who needs a pause has an
          // explicit field for it, and "Paste" remains the instant path for bulk text.
          // Reading typeDelay rather than text.length also stops this line from being the one
          // place that assumes `text` is a string — the segment parser above already tolerates it
          // being absent.
          const charDelay = (typeof typeDelay === 'number' && typeDelay >= 0) ? typeDelay : 0;

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
              setNativeValue(currentEl, '');
              currentEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            for (const char of value) {
              // keydown → write → input → keyup, which is the order a real keystroke produces.
              // This used to run write → input → keydown → keyup, so a keydown handler inspecting
              // the field saw a value that ALREADY contained the character it was being told about
              // — the opposite of what every such handler is written against.
              //
              // What this does NOT do, despite an earlier version of this comment saying so: it
              // does not stop an input mask from inserting the character a second time. A mask
              // that writes in its own keydown handler still writes, and we still append after it.
              // Fixing that needs the value to be compared across the dispatch and the append
              // skipped when the page already did it — a real change, not a reordering.
              currentEl.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
              if ('value' in currentEl) setNativeValue(currentEl, currentEl.value + char);
              currentEl.dispatchEvent(new Event('input', { bubbles: true }));
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
          const el = await waitForElement(selector, timeout, mode, msg.text, alternatives);
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
          const el = await waitForElement(selector, timeout, 'appears', null, alternatives);
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

          setNativeValue(el, option.value);
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

        /**
         * Phase 1 of the frame election — see the fan-out note in background.js for the why.
         *
         * The read-only twin of the four mutating commands above. It asks the SAME question they
         * ask — does THIS frame have the element, in the state that command needs it in — and
         * answers with nothing but the id of the frame it ran in. The background then sends the
         * real command to that frame alone, so an element that exists in two frames (Stripe's
         * card field, a duplicated #email, a login iframe) is acted on in exactly one.
         *
         * It never touches the page: no focus, no highlight, no events. That is what makes it
         * safe to broadcast, and it is also why the background may re-run it against the main
         * frame as a tie-break without any risk of acting twice.
         *
         * It carries no `text`. The background strips the payload before broadcasting, because
         * the probe reaches EVERY frame and a BrowserType's text can be a password, a token, or
         * resolved {clipboard} content. Nothing here needs it: all four mutating commands locate
         * by `selector`/`alternatives` and pass a null textPattern to waitForElement, so dropping
         * it cannot change WHICH element is found. Keep it that way — if a command ever starts
         * matching on `text` (the way waitElement's 'text-match' mode does), this probe has to be
         * given the same criterion or it will elect a frame that then finds nothing.
         */
        case 'locateFrame': {
          // click / rightClick / type wait for 'enabled'; selectOption only waits for 'appears'.
          // Must be the same mode the real command uses, or the elected frame can lose in phase 2
          // a race it just won in phase 1.
          const mode = msg.locateFor === 'selectOption' ? 'appears' : 'enabled';
          await waitForElement(selector, timeout, mode, null, alternatives);
          // A frame that cannot name itself answers null rather than guessing 0: guessing would
          // aim the click at the main frame when a SUBFRAME is what matched.
          return { success: true, frameId: await ensureFrameId() };
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
        // No isMainFrame guard here, unlike startRecording and startPick — and that is deliberate.
        // A command may legitimately target an element inside an iframe (a hand-typed selector),
        // so a frame that has the element must be allowed to run it. What must NOT happen is
        // SEVERAL frames running it, and that is decided one level up: background.js elects a
        // single frame with the read-only 'locateFrame' probe and sends the mutating command
        // there with an explicit frameId. Adding a guard here would break subframe selectors
        // without adding any safety the election does not already provide.
        executeCommand(msg).then((result) => {
          // Attach which fallback selector saved the run (if any) so the C# side can log
          // it — a used fallback means the primary selector is drifting.
          if (result && result.success && lastFallbackMatch) result.matchedVia = lastFallbackMatch;
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
