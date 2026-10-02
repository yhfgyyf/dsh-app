package com.labteto.dshmobile.collab

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.labteto.dshmobile.R
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/** Explicit opt-in messaging continuity; separate from the desktop's dataSync service. */
@AndroidEntryPoint
class CollaborationService : Service() {
    @Inject lateinit var manager: CollaborationManager
    @Inject lateinit var notifications: CollaborationNotifications
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        notifications.channels()
        val notification = NotificationCompat.Builder(this, CollaborationNotifications.CONNECTION)
            .setSmallIcon(R.drawable.ic_notification_whale).setContentTitle("DSH 协作消息后台接收")
            .setContentText("通过已绑定中继同步；可在设置中关闭")
            .setContentIntent(notifications.intent()).setOngoing(true).setOnlyAlertOnce(true).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(12, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(12, notification)
        manager.serviceState(true)
        return START_STICKY
    }
    override fun onDestroy() { manager.serviceState(false); super.onDestroy() }
}
