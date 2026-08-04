/**
 * Generates a stable, unique CSS selector for a DOM element.
 * Priority: #id > [data-testid] > [name] > [type]+[name] > .classes > tag path
 */
function generateSelector(el) {
  if (!el || el === document.documentElement || el === document.body) return null;

  // 0. Bubble up to nearest interactive ancestor (button, a, [role="button"], input, select, textarea)
  // When user clicks a span/svg/use inside a button, we want the button itself
  el = bubbleToInteractive(el);

  // 1. ID (if unique and valid)
  if (el.id && el.id !== 'null' && el.id !== 'undefined' && !/^\d/.test(el.id)) {
    const selector = `#${CSS.escape(el.id)}`;
    if (isUnique(selector, el)) return selector;
  }

  // 2. data-testid
  const testId = el.getAttribute('data-testid');
  if (testId) {
    const selector = `[data-testid="${CSS.escape(testId)}"]`;
    if (isUnique(selector, el)) return selector;
  }

  // 3. name attribute (common for form fields)
  const name = el.getAttribute('name');
  if (name) {
    const selector = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    if (isUnique(selector, el)) return selector;
  }

  // 4. type + specific attributes for inputs
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    const type = el.getAttribute('type');
    const placeholder = el.getAttribute('placeholder');
    if (type && placeholder) {
      const selector = `${el.tagName.toLowerCase()}[type="${CSS.escape(type)}"][placeholder="${CSS.escape(placeholder)}"]`;
      if (isUnique(selector, el)) return selector;
    }
    if (placeholder) {
      const selector = `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`;
      if (isUnique(selector, el)) return selector;
    }
  }

  // 5. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const selector = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
    if (isUnique(selector, el)) return selector;
  }

  // 6. Classes (if unique combination)
  if (el.classList.length > 0) {
    const classes = Array.from(el.classList)
      .filter(c => !c.match(/^(hover|active|focus|selected|open|show|hidden)/i))
      .slice(0, 3)
      .map(c => `.${CSS.escape(c)}`)
      .join('');
    if (classes) {
      const selector = `${el.tagName.toLowerCase()}${classes}`;
      if (isUnique(selector, el)) return selector;
    }
  }

  // 7. Build path with nth-child
  return buildNthChildPath(el);
}

/**
 * `skipOwnId` ignores an id on the STARTING element (ancestors still anchor on theirs).
 * Only generateSelectorAlternatives passes it, and only to get a genuinely structural fallback:
 * without it, an element that has an id makes this function return "#thatId" on its first
 * iteration, which is the exact string the S-tier candidate already claimed — so the tier-C entry
 * was deduped away and the MOST stable elements ended up as the only ones with no fallback at all.
 * Backwards, since "the site renamed the id" is precisely what fallbacks are for.
 */
/**
 * One path segment that IDENTIFIES `node` among its parent's children — not merely describes it.
 *
 * That distinction is the whole point. getUniqueClassSelector ends with "return the best class even
 * if not unique", which is genuinely useful for narrowing a long path but does NOT pin the node
 * down: for three sibling rows sharing a class it yields `div.row` for all three. A path built from
 * such segments matches every one of them, `querySelector` hands back the FIRST, and the replay
 * clicks the wrong row with no error anywhere — the failure is silent and looks like the macro
 * working. Appending the positional index closes it, and costs nothing when the class was already
 * enough.
 */
function siblingSegment(node) {
  const parent = node.parentElement;
  const tag = node.tagName.toLowerCase();
  const sameTag = parent
    ? Array.from(parent.children).filter((s) => s.tagName === node.tagName)
    : [];
  // :nth-of-type counts among same-TAG siblings, and every candidate below starts with the tag,
  // so the index stays consistent whether or not a class is present.
  const nth = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(node) + 1})` : '';

  const classSelector = getUniqueClassSelector(node);
  if (!classSelector) return tag + nth;
  if (!parent) return classSelector;

  let sameClass = 0;
  for (const s of parent.children) {
    try { if (s.matches(classSelector)) sameClass++; } catch { /* exotic class name */ }
  }
  return sameClass === 1 ? classSelector : classSelector + nth;
}

function buildNthChildPath(el, skipOwnId) {
  const parts = [];
  let current = el;

  while (current && current !== document.body && current !== document.documentElement) {
    // 1. An id ANCHORS the path — but only if it actually pins it down. This used to break
    //    unconditionally, so a path whose lower segments were ambiguous inherited an anchor and
    //    was returned as if it were exact: `#list > div.row` for three identical rows. Duplicate
    //    ids are invalid HTML and common regardless, so verify rather than assume; when the anchor
    //    does not settle it, drop it and describe this node structurally like any other.
    if (!(skipOwnId && current === el)
        && current.id && current.id !== 'null' && current.id !== 'undefined' && !/^\d/.test(current.id)) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      if (isUnique(parts.join(' > '), el)) break;
      parts.shift();
    }

    // 2. One self-disambiguating segment per level, so a path assembled from them is unique by
    //    construction as soon as it reaches an anchor.
    parts.unshift(siblingSegment(current));
    current = current.parentElement;

    if (isUnique(parts.join(' > '), el)) break;

    if (parts.length > 6) break;
  }

  // Residual, stated rather than hidden: a path that hit the 6-level cap without reaching an
  // anchor is relative, and a relative path can still repeat elsewhere in the document. Returning
  // it anyway is deliberate — this is generateSelector's last resort, and the recorder drops the
  // action entirely when it gets nothing back, which trades a rare wrong target for a guaranteed
  // lost recording. Callers that can afford to be strict check for themselves:
  // generateSelectorAlternatives gates its tier-C entry on isUnique.
  return parts.join(' > ');
}

/**
 * Try to build a unique selector from an element's classes.
 * Filters out state classes (hover, active, etc.) and dynamic classes.
 * Returns tag.class1.class2 if unique, or null.
 */
function getUniqueClassSelector(el) {
  if (!el.classList || el.classList.length === 0) return null;

  const validClasses = Array.from(el.classList).filter(c =>
    !c.match(/^(hover|active|focus|selected|open|show|hidden|is-|has-|js-|u-)/i) &&
    !c.match(/^(hovered|bordered|transparent|semibold)/i) &&
    !c.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) && // UUID
    !c.match(/^[a-zA-Z]+-[0-9a-f]{6,}$/i) && // hash suffixes (css-modules, obfuscated)
    c.length > 1 &&
    c.length < 60
  );

  if (validClasses.length === 0) return null;

  // Try single most specific class (prefer BEM-style with __ or --)
  const bemClasses = validClasses.filter(c => c.includes('__') || c.includes('--'));
  const tryOrder = [...bemClasses, ...validClasses.filter(c => !bemClasses.includes(c))];

  for (const cls of tryOrder) {
    const selector = `${el.tagName.toLowerCase()}.${CSS.escape(cls)}`;
    if (isUnique(selector, el)) return selector;
  }

  // Try two-class combo
  if (validClasses.length >= 2) {
    for (let i = 0; i < Math.min(validClasses.length, 3); i++) {
      for (let j = i + 1; j < Math.min(validClasses.length, 4); j++) {
        const selector = `${el.tagName.toLowerCase()}.${CSS.escape(validClasses[i])}.${CSS.escape(validClasses[j])}`;
        if (isUnique(selector, el)) return selector;
      }
    }
  }

  // Return best class even if not unique (helps narrow path)
  if (tryOrder.length > 0) {
    return `${el.tagName.toLowerCase()}.${CSS.escape(tryOrder[0])}`;
  }

  return null;
}

function bubbleToInteractive(el) {
  const interactiveTags = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
  const interactiveRoles = new Set(['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio']);

  // If already interactive, return as-is
  if (interactiveTags.has(el.tagName)) return el;
  if (interactiveRoles.has(el.getAttribute('role'))) return el;

  // Walk up to find nearest interactive ancestor (max 5 levels)
  let current = el.parentElement;
  for (let i = 0; i < 5 && current && current !== document.body; i++) {
    if (interactiveTags.has(current.tagName)) return current;
    if (interactiveRoles.has(current.getAttribute('role'))) return current;
    current = current.parentElement;
  }

  // No interactive ancestor found — return original element
  return el;
}

/**
 * Is this selector unique on the page?
 *
 * `el` (optional) is a cheap early-out, not a different question. Every selector built in this
 * file is derived FROM el, so el necessarily matches it — which means a first match that ISN'T el
 * already proves there are at least two, with no need to count. querySelector stops at the first
 * hit; querySelectorAll walks the whole document and materialises a NodeList. Since the generators
 * below are mostly a sequence of REJECTED candidates (that is how they narrow), this turns the
 * common path from "scan everything" into "stop at the first hit", and only the winner pays full
 * price. Call sites without an element still get the original behaviour.
 */
function isUnique(selector, el) {
  try {
    if (el && document.querySelector(selector) !== el) return false;
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/**
 * A short human label for a recorded element — this becomes the action's Comment, the only
 * column in the grid that says what the row DOES. Cosmetic: nothing matches on it.
 *
 * It used to be `el.textContent.trim().substring(0, 50)`, which produced the "giant name that
 * doesn't even look like anything on screen". Three separate reasons, all fixed here:
 *   • textContent is the whole SUBTREE, so clicking a wrapper concatenated every descendant's
 *     text with no separator at all.
 *   • trim() only touches the ends, so the source file's newlines and indentation survived in
 *     the middle — half the 50 characters were whitespace.
 *   • it described the RAW click target while the selector described the BUBBLED one, so
 *     clicking the icon inside a button gave an action aimed at the button and labelled "svg".
 *
 * Order is deliberate: an authored label (aria-label/title/alt/placeholder) beats scraped text,
 * because it is what the page's author chose to call the thing. Below that, the element's OWN
 * text beats its descendants'.
 */
function getElementDescription(el) {
  if (!el) return '';
  // Same element the selector will point at.
  el = bubbleToInteractive(el);

  // Whitespace runs (including newlines) collapse to one space — this alone is most of the fix.
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const MAX = 40;
  const cap = (s) => (s.length > MAX ? s.slice(0, MAX).trimEnd() + '...' : s);

  for (const attr of ['aria-label', 'title', 'alt', 'placeholder']) {
    const v = clean(el.getAttribute(attr));
    if (v) return cap(v);
  }

  // The element's own text nodes, not its descendants'.
  const own = clean(Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join(' '));
  if (own) return cap(own);

  // No own text: a button wrapping a <span> is still fairly labelled by that span, so fall
  // through to the subtree. Truncated like everything else — for a real container this is a
  // paragraph rather than a name, and 40 collapsed characters of it is at least a usable hint
  // instead of the bare tag name.
  const subtree = clean(el.textContent);
  if (subtree) return cap(subtree);

  if (el.tagName === 'INPUT') {
    const v = clean(el.getAttribute('value')) || clean(el.getAttribute('name'));
    if (v) return cap(v);
    const type = clean(el.getAttribute('type'));
    return type ? `input ${type}` : 'input';
  }

  return el.tagName.toLowerCase();
}

/**
 * #2 — Generate up to 5 stable selector alternatives ranked by stability tier.
 * Tier S (green): #id, [data-testid], [data-cy], [data-test]
 * Tier A (blue):  [name], [aria-label], unique [role][aria-label] combos
 * Tier B (yellow): text= (when text content is unique on page)
 * Tier C (red):   nth-child CSS path (current full path generator)
 *
 * Returns an array of {selector, tier, description} sorted by stability.
 */
function generateSelectorAlternatives(el) {
  if (!el || el === document.documentElement || el === document.body) return [];

  // Bubble up to nearest interactive ancestor for consistency with generateSelector
  el = bubbleToInteractive(el);

  const alts = [];
  const seen = new Set();
  const push = (selector, tier, description) => {
    if (!selector || seen.has(selector)) return;
    if (!isUnique(selector, el)) return; // Skip ambiguous selectors at S/A tiers
    seen.add(selector);
    alts.push({ selector, tier, description });
  };

  // Tier S — strongest stability signals
  if (el.id && el.id !== 'null' && el.id !== 'undefined' && !/^\d/.test(el.id)) {
    push(`#${CSS.escape(el.id)}`, 'S', 'ID');
  }
  for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
    const v = el.getAttribute(attr);
    if (v) push(`[${attr}="${CSS.escape(v)}"]`, 'S', attr);
  }

  // Tier A — strong but not as durable as test IDs
  const nameAttr = el.getAttribute('name');
  if (nameAttr) {
    push(`${el.tagName.toLowerCase()}[name="${CSS.escape(nameAttr)}"]`, 'A', 'name');
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    push(`${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`, 'A', 'aria-label');
    const role = el.getAttribute('role');
    if (role) {
      push(`[role="${CSS.escape(role)}"][aria-label="${CSS.escape(ariaLabel)}"]`, 'A', 'role+aria-label');
    }
  }
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    push(`${el.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`, 'A', 'placeholder');
  }

  // Tier B — text= match if this element's visible text is unique on the page
  const directText = Array.from(el.childNodes)
    .filter(n => n.nodeType === Node.TEXT_NODE)
    .map(n => n.textContent.trim())
    .join(' ').trim();
  const visibleText = (directText || el.textContent?.trim() || '').slice(0, 80);
  if (visibleText && visibleText.length >= 2 && visibleText.length <= 80) {
    if (isTextUnique(visibleText)) {
      alts.push({ selector: `text=${visibleText}`, tier: 'B', description: 'visible text' });
    }
  }

  // Tier C — structural path, so there is ALWAYS something to fall back to.
  // buildNthChildPath directly (not generateSelector, which re-runs the id/testid/name ladder
  // above and hands back a string already in `seen`), and with skipOwnId so an id-bearing element
  // gets a real path instead of its own id a second time.
  // isUnique is NOT optional here. Every tier above goes through push(), which rejects an
  // ambiguous candidate; this entry bypassed push() and so was the one candidate that could be
  // ambiguous. buildNthChildPath gives up after 6 levels and returns whatever it has, so an
  // element deep in a repetitive list yields a path matching several siblings — and a fallback is
  // used precisely when the primary stopped matching, i.e. exactly when nobody is watching. An
  // element with no unique structural path goes back to having no tier C at all, which is the
  // correct outcome: ELEMENT_NOT_FOUND is a far better failure than silently clicking the wrong row.
  const path = buildNthChildPath(el, true);
  if (path && !seen.has(path) && isUnique(path, el)) {
    alts.push({ selector: path, tier: 'C', description: 'CSS path' });
  }

  // Cap at 5; always sorted by tier (S, A, B, C)
  const tierRank = { S: 0, A: 1, B: 2, C: 3 };
  alts.sort((a, b) => tierRank[a.tier] - tierRank[b.tier]);
  return alts.slice(0, 5);
}

// #2 — Check whether a visible-text query would resolve uniquely.
// We approximate: walk the DOM and count visible elements whose direct text matches.
function isTextUnique(text) {
  let count = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode;
    const direct = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim())
      .join(' ').trim();
    if (direct === text) {
      count++;
      if (count > 1) return false;
    }
  }
  return count === 1;
}

/**
 * #2 — Estimate the stability tier of an arbitrary selector string for the
 * SheetPanel shield indicator. No DOM lookup; pure pattern detection.
 */
function estimateSelectorTier(selector) {
  if (!selector) return 'C';
  const s = selector.trim();
  // Text-based selectors → tier B
  if (s.startsWith('text=') || s.startsWith('text*=') || s.startsWith('text~=') || s.startsWith('text/')) return 'B';
  // ID or test-id → tier S
  if (/^#[A-Za-z_][\w\-]*$/.test(s)) return 'S';
  if (/\[data-(testid|test|cy|qa)=/.test(s)) return 'S';
  // name / aria-label / placeholder → tier A
  if (/\[(name|aria-label|placeholder)=/.test(s)) return 'A';
  // nth-of-type / nth-child / direct child paths → tier C
  if (s.includes(':nth-') || s.includes(' > ')) return 'C';
  // Class-only selectors → tier B (decent but not test-id)
  if (/^[a-z]+\./i.test(s)) return 'B';
  // Default
  return 'C';
}

// Export for content.js
if (typeof window !== 'undefined') {
  window.__trueReplayerSelectorGenerator = {
    generateSelector,
    generateSelectorAlternatives,
    estimateSelectorTier,
    getElementDescription,
  };
}
