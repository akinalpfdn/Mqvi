package net.mqvi.app

import android.app.NotificationManager
import android.content.Context
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Lets the web layer cancel the ringing incoming-call notification. MqviMessagingService
 * posts it natively, so without this bridge JS has no way to stop it — which is what left
 * a phone ringing after the call was answered on another device.
 *
 * iOS registers a different surface under the same "P2PCall" name (CallKit + VoIP token);
 * callers route by platform in src/native/p2pCall.ts.
 */
@CapacitorPlugin(name = "P2PCall")
class P2PCallPlugin : Plugin() {

    @PluginMethod
    fun cancelIncomingCall(call: PluginCall) {
        cancelCallNotification(context)
        call.resolve()
    }

    companion object {
        fun cancelCallNotification(context: Context) {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(MqviMessagingService.CALL_NOTIFICATION_ID)
        }
    }
}
