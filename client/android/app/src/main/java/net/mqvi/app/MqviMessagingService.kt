package net.mqvi.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Intercepts incoming-call data messages to show a ringing notification, and delegates
 * every other message — DM notifications, token refresh — to the Capacitor base service
 * via super (so DMs + token sync are unchanged).
 *
 * The call notification is posted directly (no foreground service — starting a FGS from
 * a background FCM throws on Android 12+ and dropped the notification entirely). The
 * ringtone loops via FLAG_INSISTENT until the user taps/dismisses it or it times out at
 * ~50s (the server's ring window is 60s). The channel uses the ringtone sound + a long
 * vibration pattern so it rings like a call, not a one-shot message beep.
 */
class MqviMessagingService : MessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        if (remoteMessage.data["type"] == "call") {
            // Foreground: the in-app overlay rings; don't double up.
            if (!MainActivity.isAppForeground) {
                showIncomingCall(remoteMessage.data)
            }
            return // handled natively — don't let Capacitor fire pushNotificationReceived
        }
        if (remoteMessage.data["type"] == "call_cancel") {
            // Caller hung up / call timed out while ringing — stop the incoming-call ring.
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(CALL_NOTIFICATION_ID)
            return
        }
        super.onMessageReceived(remoteMessage)
    }

    private fun showIncomingCall(data: Map<String, String>) {
        ensureCallChannel()

        val callId = data["call_id"].orEmpty()
        val title = data["title"] ?: getString(R.string.app_name)
        val body = data["body"].orEmpty()

        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_INCOMING_CALL, true)
            putExtra(MainActivity.EXTRA_CALL_ID, callId)
        }
        val pi = PendingIntent.getActivity(
            this,
            callId.hashCode(),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, CALLS_CHANNEL)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(pi)
            // Auto-stop the ring around the server's 60s ring window.
            .setTimeoutAfter(50_000L)
            .build()
        // Loop the ringtone until the user taps/dismisses (or the timeout cancels it).
        notification.flags = notification.flags or Notification.FLAG_INSISTENT

        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(CALL_NOTIFICATION_ID, notification)
    }

    // Fresh channel id (a prior build created "incoming_call" silent, and channel
    // settings are immutable once created) so the ringtone sound + vibration apply.
    private fun ensureCallChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CALLS_CHANNEL) != null) return
        val channel = NotificationChannel(
            CALLS_CHANNEL,
            "Incoming Calls",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Incoming call ringing"
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000)
        }
        nm.createNotificationChannel(channel)
    }

    companion object {
        private const val CALLS_CHANNEL = "incoming_call_alert"
        private const val CALL_NOTIFICATION_ID = 42
    }
}
