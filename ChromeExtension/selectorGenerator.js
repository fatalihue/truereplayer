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
    if (isUnique(selector)) return selector;
  }

  // 2. data-testid
  const testId = el.getAttribute('data-testid');
  if (testId) {
    const selector = `[data-testid="${CSS.escape(testId)}"]`;
    if (isUnique(selector)) return selector;
  }

  // 3. name attribute (common for form fields)
  const name = el.getAttribute('name');
  if (name) {
    const selector = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    if (isUnique(selector)) return selector;
  }

  // 4. type + specific attributes for inputs
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    const type = el.getAttribute('type');
    const placeholder = el.getAttribute('placeholder');
    if (type && placeholder) {
      const selector = `${el.tagName.toLowerCase()}[type="${CSS.escape(type)}"][placeholder="${CSS.escape(placeholder)}"]`;
      if (isUnique(selector)) return selector;
    }
    if (placeholder) {
      const selector = `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`;
      if (isUnique(selector)) return selector;
    }
  }

  // 5. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const selector = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
    if (isUnique(selector)) return selector;
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
      if (isUnique(selector)) return selector;
    }
  }

  // 7. Build path with nth-child
  return buildNthChildPath(el);
}

function buildNthChildPath(el) {
  const parts = [];
  let current = el;

  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();

    if (current.id && current.id !== 'null' && current.id !== 'undefined' && !/^\d/.test(current.id)) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(selector);
    current = current.parentElement;

    // Limit depth
    if (parts.length > 5) break;
  }

  return parts.join(' > ');
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

function isUnique(selector) {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function getElementDescription(el) {
  // Try to get a human-readable description
  const text = el.textContent?.trim()?.substring(0, 50);
  const placeholder = el.getAttribute('placeholder');
  const ariaLabel = el.getAttribute('aria-label');
  const title = el.getAttribute('title');
  const alt = el.getAttribute('alt');
  const value = el.tagName === 'INPUT' ? el.getAttribute('type') : null;

  return ariaLabel || title || alt || placeholder || (text ? `"${text}"` : value || el.tagName.toLowerCase());
}

// Export for content.js
if (typeof window !== 'undefined') {
  window.__trueReplayerSelectorGenerator = { generateSelector, getElementDescription };
}
