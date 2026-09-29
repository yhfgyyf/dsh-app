package com.labteto.dshmobile.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.labteto.dshmobile.MainActivity
import com.labteto.dshmobile.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Notification channels + post helpers. Completion events come from the
 * core CompletionClassifier (turn end, goal complete/blocked, plan review,
 * approval/question requested).
 */
@Singleton
class DshNotifications @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_COMPLETIONS, context.getString(R.string.notif_channel_completions), NotificationManager.IMPORTANCE_DEFAULT),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ACTION, context.getString(R.string.notif_channel_action), NotificationManager.IMPORTANCE_HIGH),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.notif_channel_connection), NotificationManager.IMPORTANCE_LOW),
        )
    }

    fun canPost(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * Post a completion/action notification that deep-links to a session.
     * [canPost] gates the POST_NOTIFICATIONS runtime permission (API 33+);
     * the lint suppression covers that checked gate.
     */
    @android.annotation.SuppressLint("MissingPermission")
    fun postSession(
        channel: String,
        id: Int,
        title: String,
        text: String,
        sessionId: String?,
        actionLabel: String? = null,
    ) {
        if (!canPost()) return
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (sessionId != null) {
                data = android.net.Uri.parse("dshmobile://host/current/session/$sessionId")
                putExtra(EXTRA_SESSION_ID, sessionId)
            }
        }
        val pending = PendingIntent.getActivity(
            context,
            id,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification_whale)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(if (channel == CHANNEL_ACTION) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
        if (actionLabel != null) {
            builder.addAction(0, actionLabel, pending)
        }
        NotificationManagerCompat.from(context).notify(id, builder.build())
    }

    companion object {
        const val CHANNEL_COMPLETIONS = "completions"
        const val CHANNEL_ACTION = "needs_action"
        const val CHANNEL_CONNECTION = "connection"
        const val EXTRA_SESSION_ID = "dsh_session_id"
    }
}
