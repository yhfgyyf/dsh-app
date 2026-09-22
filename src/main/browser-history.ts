export interface BrowserHistory {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
}

/** Electron 31 exposes history inspection on navigationHistory, but navigation on WebContents. */
export function browserHistory(contents: Partial<BrowserHistory> & { navigationHistory?: Partial<BrowserHistory> }): BrowserHistory {
  const methods = ['canGoBack', 'canGoForward', 'goBack', 'goForward'] as const;
  for (const candidate of [contents.navigationHistory, contents]) {
    if (candidate && methods.every(method => typeof candidate[method] === 'function')) return candidate as BrowserHistory;
  }
  throw new Error('当前浏览器运行时不支持页面导航。');
}
