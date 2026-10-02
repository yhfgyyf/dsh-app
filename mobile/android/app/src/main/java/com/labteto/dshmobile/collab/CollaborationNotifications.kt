package com.labteto.dshmobile.collab

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.labteto.dshmobile.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CollaborationNotifications @Inject constructor(@ApplicationContext private val context: Context) {
    fun channels() {
        context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
            NotificationChannel(MESSAGES, "协作任务消息", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CONNECTION, "协作后台连接", NotificationManager.IMPORTANCE_LOW),
        ))
    }
    fun allowed(): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        context.getSystemService(NotificationManager::class.java).getNotificationChannel(MESSAGES)?.importance != NotificationManager.IMPORTANCE_NONE

    fun intent(hostId: String = "", taskId: String = ""): PendingIntent = PendingIntent.getActivity(context, 0,
        Intent(context, CollaborationActivity::class.java)
            .setData(Uri.Builder().scheme("dsh-collab").authority("task").appendPath(hostId).appendPath(taskId).build())
            .putExtra("hostId", hostId).putExtra("taskId", taskId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun message(hostId: String, taskId: String) {
        channels()
        if (!allowed()) return
        val notification = NotificationCompat.Builder(context, MESSAGES)
            .setSmallIcon(R.drawable.ic_notification_whale).setContentTitle("DSH 协作任务有新消息")
            .setContentText("点开查看任务详情").setContentIntent(intent(hostId, taskId))
            .setAutoCancel(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        NotificationManagerCompat.from(context).notify("collab:$hostId:$taskId", 1, notification)
    }
    companion object { const val MESSAGES = "collaboration_messages"; const val CONNECTION = "collaboration_connection" }
}
