package net.mqvi.app

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream

/**
 * Extracts a still frame from a video the WebView cannot decode.
 *
 * The browser path (canvas + <video>) covers whatever Chromium can play, which on Android leaves
 * out HEVC — the format iPhones record in. Those videos posted a blank frame. MediaMetadataRetriever
 * goes through the platform decoders instead, so it handles what the WebView will not.
 *
 * Only reachable because attachments are picked natively: this needs a URI it can open, and a web
 * File is not one.
 */
@CapacitorPlugin(name = "MediaPoster")
class MediaPosterPlugin : Plugin() {

    companion object {
        // Matches THUMBNAIL_MAX_EDGE in the web thumbnail path so both produce the same size.
        private const val MAX_EDGE = 800
        private const val JPEG_QUALITY = 82
    }

    /**
     * Returns a base64 JPEG of one frame, plus its dimensions.
     *
     * Base64 is affordable here in a way it is not for the video itself: a poster is tens of
     * kilobytes, so the encoding overhead is noise, while base64ing the source video would not be.
     */
    @PluginMethod
    fun extractPoster(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrBlank()) {
            call.reject("path is required")
            return
        }
        val atSeconds = call.getDouble("atSeconds") ?: 0.5

        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, Uri.parse(path))

            val timeUs = (atSeconds * 1_000_000).toLong()
            // A video shorter than the requested offset yields null rather than clamping, so fall
            // back to the first frame instead of reporting failure for a short clip.
            val frame = frameAt(retriever, timeUs) ?: frameAt(retriever, 0L)
            if (frame == null) {
                call.reject("no decodable frame")
                return
            }

            val scaled = scaleWithin(frame)
            val stream = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, stream)

            val result = JSObject()
            result.put("data", Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP))
            result.put("width", scaled.width)
            result.put("height", scaled.height)
            call.resolve(result)

            if (scaled != frame) scaled.recycle()
            frame.recycle()
        } catch (e: Exception) {
            // A poster is an enhancement; the caller falls back to sending without one.
            call.reject("poster extraction failed: ${e.message}", e)
        } finally {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                retriever.close()
            } else {
                @Suppress("DEPRECATION")
                retriever.release()
            }
        }
    }

    private fun frameAt(retriever: MediaMetadataRetriever, timeUs: Long): Bitmap? {
        // getScaledFrameAtTime decodes straight to the target size, so a 4K frame is never
        // materialised at full resolution just to be shrunk afterwards.
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            retriever.getScaledFrameAtTime(
                timeUs,
                MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                MAX_EDGE,
                MAX_EDGE
            )
        } else {
            retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        }
    }

    /** No-op when the frame already fits, which is the usual case after getScaledFrameAtTime. */
    private fun scaleWithin(source: Bitmap): Bitmap {
        val longest = maxOf(source.width, source.height)
        if (longest <= MAX_EDGE) return source
        val ratio = MAX_EDGE.toDouble() / longest
        return Bitmap.createScaledBitmap(
            source,
            (source.width * ratio).toInt().coerceAtLeast(1),
            (source.height * ratio).toInt().coerceAtLeast(1),
            true
        )
    }
}
