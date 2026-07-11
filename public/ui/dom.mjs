// Tiny DOM helpers. Functions only — no top-level DOM access — so modules
// that import this file still load under node:test.

/**
 * querySelector that throws on a miss (a missing element is a template bug).
 * @param {string} sel @param {ParentNode} [root]
 * @returns {HTMLElement}
 */
export function qs(sel, root) {
  const node = (root ?? document).querySelector(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return /** @type {HTMLElement} */ (node);
}

/**
 * Element builder. String children become TEXT nodes — user-controlled
 * strings can never be parsed as markup.
 * @param {string} tag
 * @param {Record<string, string>} [attrs] "class" sets className; others via setAttribute
 * @param {...(Node|string)} children
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** @param {Element} node @param {string} text */
export function setText(node, text) {
  node.textContent = text;
}

/** Toggle visibility via the .hidden class (CSP forbids style attributes). @param {Element} node @param {boolean} on */
export function show(node, on) {
  node.classList.toggle("hidden", !on);
}
