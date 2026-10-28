const excluded = 'script, style, noscript, input, textarea, select, [contenteditable], [data-composer-seat], [data-desktop-content-tools], [hidden], [aria-hidden="true"]';
const blocks = 'p, pre, li, tr, h1, h2, h3, h4, h5, h6, blockquote, div';
export type TextMatch = { range: Range };

/** Literal Unicode search across inline markup, without rewriting React's DOM. */
export function contentMatches(root: HTMLElement, query: string): { matches: TextMatch[]; limited: boolean } {
  if (!query) return { matches: [], limited: false };
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks: { node: Text; start: number; end: number }[] = [];
  let text = '', lastBlock: Element | null = null;
  const visible = new WeakMap<Element, boolean>();
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded) || !node.textContent) continue;
    let show = visible.get(parent);
    if (show === undefined) { show = parent.checkVisibility({ checkVisibilityCSS: true }); visible.set(parent, show); }
    if (!show) continue;
    const block = parent.closest(blocks);
    if (lastBlock && block !== lastBlock) text += '\n';
    lastBlock = block;
    const start = text.length;
    text += node.textContent;
    chunks.push({ node: node as Text, start, end: text.length });
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: TextMatch[] = [];
  let result, cursor = 0;
  while ((result = pattern.exec(text))) {
    if (matches.length === 10_000) return { matches, limited: true };
    const start = result.index, end = start + result[0].length;
    while (chunks[cursor] && chunks[cursor].end <= start) cursor++;
    const first = chunks[cursor];
    let tail = cursor;
    while (chunks[tail] && chunks[tail].end < end) tail++;
    const last = chunks[tail];
    if (!first || !last) continue;
    const range = root.ownerDocument.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    matches.push({ range });
  }
  return { matches, limited: false };
}

/** A right-panel tab wins over its nested /side conversation. */
export function contentRoot(element: Element | null): HTMLElement | undefined {
  return element?.closest<HTMLElement>('[data-dockkit-content]')
    ?? element?.closest<HTMLElement>('[data-conversation-content]') ?? undefined;
}

export function visibleContent(root: HTMLElement): boolean {
  return root.isConnected && root.checkVisibility({ checkVisibilityCSS: true }) && root.getBoundingClientRect().width > 0;
}

export function scrollToContentMatch(range: Range, root: HTMLElement) {
  range.startContainer.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  requestAnimationFrame(() => {
    if (!range.startContainer.isConnected) return;
    for (let element = range.startContainer.parentElement; element && root.contains(element); element = element.parentElement) {
      const style = getComputedStyle(element), rect = range.getBoundingClientRect(), viewport = element.getBoundingClientRect();
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) element.scrollTop += rect.top - viewport.top - element.clientHeight / 2;
      if (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth && (rect.left < viewport.left || rect.right > viewport.right)) element.scrollLeft += rect.left - viewport.left - 24;
      if (element === root) break;
    }
  });
}
