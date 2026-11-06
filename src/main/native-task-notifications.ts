import { app, nativeImage, Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { join, resolve } from 'node:path';
import { TaskNotifications } from './task-notifications.ts';
import { notificationBadgePng } from './notification-badge.ts';

export function prepareTaskNotificationIdentity() {
  if (process.platform === 'linux') app.setDesktopName('dsh-desktop.desktop');
  if (process.platform !== 'win32') return;
  app.setAppUserModelId('io.dsh.desktop');
  // Set identity only on an existing shortcut owned by this installed App.
  const shortcut = join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs/DSH Desktop.lnk');
  try {
    const details = shell.readShortcutLink(shortcut);
    if (resolve(details.target).toLowerCase() === resolve(process.execPath).toLowerCase())
      shell.writeShortcutLink(shortcut, 'update', { ...details, appUserModelId: 'io.dsh.desktop' });
  } catch { /* Portable runs may have no installer shortcut. */ }
}

export function createNativeTaskNotifications(window: () => BrowserWindow | undefined, openSession: (id: string) => void) {
  return new TaskNotifications({
    badge(count) {
      try {
        if (process.platform === 'darwin') app.dock?.setBadge(count ? String(count) : '');
        else if (process.platform === 'win32') window()?.setOverlayIcon(count ? nativeImage.createFromBuffer(notificationBadgePng(count)) : null, count ? `${count} 个会话有未读任务结果` : '');
        else app.setBadgeCount(count);
      } catch { console.warn('任务角标未能更新。'); }
    },
    notify(notice, open) {
      if (!Notification.isSupported()) return () => {};
      const notification = new Notification({ title: notice.outcome === 'completed' ? '任务已完成' : '任务意外中断',
        body: `${notice.title || 'DSH 会话'}\n点击返回 DSH 查看。` });
      notification.on('click', open);
      notification.on('failed', () => console.warn('系统任务通知未能显示，请检查系统通知权限。'));
      notification.show();
      return () => { notification.removeListener('click', open); try { notification.close(); } catch { /* OS notification was already removed. */ } };
    },
    openSession,
  });
}
