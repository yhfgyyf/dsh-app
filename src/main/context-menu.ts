import { clipboard, Menu } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions, WebContents } from 'electron';

/** Each native view owns its selection; the main window may have a different one. */
export function installTextContextMenu(contents: WebContents, window: BrowserWindow): void {
  contents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const flags = params.editFlags;
    const edit = (command: 'undo' | 'redo' | 'cut' | 'paste' | 'selectAll') => () => {
      if (!contents.isDestroyed()) { contents.focus(); contents[command](); }
    };
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) items.push(
      { label: '撤销', enabled: flags.canUndo, click: edit('undo') },
      { label: '重做', enabled: flags.canRedo, click: edit('redo') },
      { type: 'separator' },
      { label: '剪切', enabled: flags.canCut, click: edit('cut') },
    );
    items.push({ label: '复制', enabled: flags.canCopy && !!params.selectionText, click: () => clipboard.writeText(params.selectionText) });
    if (params.isEditable) items.push({ label: '粘贴', enabled: flags.canPaste, click: edit('paste') });
    items.push({ type: 'separator' }, { label: '全选', enabled: flags.canSelectAll, click: edit('selectAll') });
    Menu.buildFromTemplate(items).popup({ window });
  });
}
