package net.mqvi.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel

/**
 * Capacitor plugin for Android screen sharing via MediaProjection + LiveKit.
 *
 * Android WebView doesn't support getDisplayMedia(), so we use native
 * MediaProjection API and publish the screen capture track through a
 * separate LiveKit room connection (same pattern as iOS ReplayKit).
 *
 * JS calls start({ url, token }) -> native permission dialog -> LiveKit publish.
 * JS calls stop() -> disconnect room -> release MediaProjection.
 */
@CapacitorPlugin(name = "ScreenShare")
class ScreenSharePlugin : Plugin() {

    private var room: Room? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var pendingUrl: String? = null
    private var pendingToken: String? = null

    @PluginMethod
    fun start(call: PluginCall) {
        val url = call.getString("url")
        val token = call.getString("token")

        if (url.isNullOrEmpty() || token.isNullOrEmpty()) {
            call.reject("url and token are required")
            return
        }

        pendingUrl = url
        pendingToken = token

        val projectionManager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        val intent = projectionManager.createScreenCaptureIntent()

        startActivityForResult(call, intent, "handleScreenCaptureResult")
    }

    @ActivityCallback
    private fun handleScreenCaptureResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            call.reject("Screen capture permission denied")
            pendingUrl = null
            pendingToken = null
            return
        }

        val mediaProjectionData = result.data!!
        val url = pendingUrl!!
        val token = pendingToken!!
        pendingUrl = null
        pendingToken = null

        scope.launch {
            try {
                val newRoom = LiveKit.create(context)
                room = newRoom

                newRoom.connect(url, token)

                // LiveKit Android SDK handles MediaProjection internally via ScreenCaptureParams
                val params = ScreenCaptureParams(mediaProjectionData)
                newRoom.localParticipant.setScreenShareEnabled(true, params)

                val ret = JSObject()
                ret.put("started", true)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject("Failed to start screen share: ${e.message}")
                cleanup()
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        scope.launch {
            cleanup()
            val ret = JSObject()
            ret.put("stopped", true)
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun isActive(call: PluginCall) {
        val ret = JSObject()
        ret.put("active", room != null)
        call.resolve(ret)
    }

    private suspend fun cleanup() {
        try {
            room?.localParticipant?.setScreenShareEnabled(false)
            room?.disconnect()
            room?.release()
            room = null
        } catch (_: Exception) {}
    }

    override fun handleOnDestroy() {
        scope.launch { cleanup() }
        scope.cancel()
        super.handleOnDestroy()
    }
}
