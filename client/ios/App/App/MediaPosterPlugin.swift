import AVFoundation
import Capacitor
import Foundation
import UIKit

/// Extracts a still frame from a video the WebView cannot decode.
///
/// The browser path (canvas + <video>) covers whatever WKWebView will draw into a canvas, which
/// leaves out some camera-recorded HEVC — the format iPhones record in. Those videos posted a blank
/// frame. AVFoundation goes through the platform decoders instead, so it handles what the WebView
/// will not.
///
/// Only reachable because attachments are picked natively: this needs a URL it can open, and a web
/// File is not one. The iOS half of MediaPosterPlugin.kt — same plugin name, same method, same
/// argument and return shape, because one JS caller drives both.
@objc(MediaPosterPlugin)
public class MediaPosterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MediaPosterPlugin"
    public let jsName = "MediaPoster"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "extractPoster", returnType: CAPPluginReturnPromise)
    ]

    /// Matches THUMBNAIL_MAX_EDGE in the web thumbnail path so both produce the same size.
    private static let maxEdge: CGFloat = 800
    private static let jpegQuality: CGFloat = 0.82
    /// Wide on purpose: an exact-frame request fails outright on a clip whose sync samples are
    /// sparse, which is most of them. Android's OPTION_CLOSEST_SYNC has the same effect.
    private static let seekTolerance = CMTime(seconds: 1, preferredTimescale: 600)

    /**
     * Returns a base64 JPEG of one frame, plus its dimensions.
     *
     * Base64 is affordable here in a way it is not for the video itself: a poster is tens of
     * kilobytes, so the encoding overhead is noise, while base64ing the source video would not be.
     */
    @objc func extractPoster(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), !path.isEmpty else {
            call.reject("path is required")
            return
        }
        guard let url = Self.fileURL(from: path) else {
            call.reject("path is not a readable file URL")
            return
        }
        let atSeconds = call.getDouble("atSeconds") ?? 0.5

        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        // Without this a portrait video yields a sideways poster: the rotation lives in the track's
        // preferred transform, not in the pixels.
        generator.appliesPreferredTrackTransform = true
        // Decode straight to the target size, so a 4K frame is never materialised at full
        // resolution just to be shrunk afterwards.
        generator.maximumSize = CGSize(width: Self.maxEdge, height: Self.maxEdge)
        generator.requestedTimeToleranceBefore = Self.seekTolerance
        generator.requestedTimeToleranceAfter = Self.seekTolerance

        // Static helpers throughout: the callbacks below must resolve the call even if this plugin
        // instance were gone, and a weakly captured self that turns nil would hang the JS promise
        // instead of rejecting it.
        Self.frame(from: generator, at: atSeconds) { image in
            if let image = image {
                Self.resolve(call, with: image)
                return
            }
            // A clip shorter than the requested offset fails rather than clamping, so fall back to
            // the first frame instead of reporting failure for a short clip.
            Self.frame(from: generator, at: 0) { fallback in
                guard let fallback = fallback else {
                    // A poster is an enhancement; the caller falls back to sending without one.
                    call.reject("no decodable frame")
                    return
                }
                Self.resolve(call, with: fallback)
            }
        }
    }

    /// The asynchronous generator rather than copyCGImage(at:actualTime:), which is deprecated and
    /// would block whichever queue the bridge dispatched the call on.
    private static func frame(
        from generator: AVAssetImageGenerator,
        at seconds: Double,
        then handler: @escaping (CGImage?) -> Void
    ) {
        let time = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        generator.generateCGImagesAsynchronously(forTimes: [NSValue(time: time)]) { _, image, _, result, _ in
            handler(result == .succeeded ? image : nil)
        }
    }

    private static func resolve(_ call: CAPPluginCall, with frame: CGImage) {
        // Scale 1 keeps points and pixels the same, so the size reported to JS is the pixel size.
        let scaled = scaleWithin(UIImage(cgImage: frame, scale: 1, orientation: .up))
        guard let jpeg = scaled.jpegData(compressionQuality: jpegQuality) else {
            call.reject("frame could not be encoded as JPEG")
            return
        }
        call.resolve([
            "data": jpeg.base64EncodedString(),
            "width": Int(scaled.size.width),
            "height": Int(scaled.size.height)
        ])
    }

    /// No-op when the frame already fits, which is the usual case after maximumSize did the work.
    private static func scaleWithin(_ source: UIImage) -> UIImage {
        let longest = max(source.size.width, source.size.height)
        guard longest > maxEdge else { return source }
        let ratio = maxEdge / longest
        let target = CGSize(
            width: max(1, (source.size.width * ratio).rounded()),
            height: max(1, (source.size.height * ratio).rounded())
        )
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            source.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    /// The picker hands back an absolute file URL string, which is percent-encoded and so cannot go
    /// through URL(fileURLWithPath:). A bare path is tolerated in case some caller passes one.
    private static func fileURL(from path: String) -> URL? {
        if let url = URL(string: path), url.scheme != nil {
            return url.isFileURL ? url : nil
        }
        return URL(fileURLWithPath: path)
    }
}
