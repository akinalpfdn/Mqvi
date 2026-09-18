import AVFoundation
import Foundation
import LiveKitWebRTC
import UIKit

/// The video surface for a native call.
///
/// A native video track cannot be drawn inside WKWebView, so the two feeds live in their own
/// views layered over it. The web layer stays in charge: it sends the rectangles, this places
/// the views in them, and it sends nothing when the video must not be seen — a modal, another
/// tab, a backgrounded app.
///
/// Over rather than under on purpose. Under would need every ancestor of the call screen to be
/// transparent, from the body down through the panel, which is five layers of styling that any
/// future change could quietly close. Over costs the page the ability to draw on top of the
/// video, and the page compensates by pulling the rectangles when something should cover it.
@MainActor
final class NativeCallVideo: NSObject, LKRTCVideoViewDelegate {
    static let shared = NativeCallVideo()

    /// Reports a feed's shape, as "remote"/"local" and its pixel size. The page sizes the
    /// picture-in-picture box and has no element to measure for a natively drawn feed, so
    /// without this a portrait camera ends up in a box left at the browser's default 2:1.
    var onVideoSize: ((String, CGSize) -> Void)?

    private let container = UIView()
    // Replaced whenever the track they draw changes — see `swap`. Not constants for that reason.
    private var remoteView = LKRTCMTLVideoView()
    private var localView = LKRTCMTLVideoView()

    // Strong on purpose. A receiver hands out a fresh Obj-C wrapper for its track every time it
    // is asked, and nothing else keeps that wrapper alive; letting it go deallocates it, and its
    // dealloc unhooks the renderer from the native track, so the surface never sees a frame.
    private var remoteTrack: LKRTCVideoTrack?
    private var localTrack: LKRTCVideoTrack?
    private var attached = false
    /// The web view the rectangles are measured against; its origin turns them into our parent's
    /// coordinates.
    private weak var hostView: UIView?

    private override init() {
        super.init()
        container.isUserInteractionEnabled = false
        container.backgroundColor = .clear
        for view in [remoteView, localView] {
            prepare(view)
            container.addSubview(view)
        }
    }

    private func prepare(_ view: LKRTCMTLVideoView) {
        // Fit, not fill, to match the web's `object-fit: contain`: the same call must not be
        // framed one way on the desktop and cropped another way here.
        view.videoContentMode = .scaleAspectFit
        view.clipsToBounds = true
        view.isHidden = true
        view.delegate = self
    }

    /// Retires a view and puts a blank one in its place, keeping its geometry.
    ///
    /// A Metal view holds on to the last frame it drew, and hiding it does not erase that. Reusing
    /// one across calls therefore showed the previous call's final picture the moment the next
    /// call's box appeared — before any new frame had arrived. So a view never outlives the track
    /// it drew.
    private func swap(_ old: LKRTCMTLVideoView) -> LKRTCMTLVideoView {
        let fresh = LKRTCMTLVideoView()
        prepare(fresh)
        fresh.frame = old.frame
        fresh.transform = old.transform
        fresh.layer.cornerRadius = old.layer.cornerRadius
        old.delegate = nil
        container.insertSubview(fresh, aboveSubview: old)
        old.removeFromSuperview()
        return fresh
    }

    // MARK: - lifecycle

    /// Puts the container over the web view, without taking touches from it.
    func attach(to webView: UIView) {
        hostView = webView
        guard !attached, let parent = webView.superview else { return }
        container.clipsToBounds = true
        parent.insertSubview(container, aboveSubview: webView)
        attached = true
    }

    func setRemoteTrack(_ track: LKRTCVideoTrack?) {
        guard remoteTrack !== track else { return }
        remoteTrack?.remove(remoteView)
        remoteTrack = track
        remoteView = swap(remoteView)
        track?.add(remoteView)
        remoteView.isHidden = track == nil
    }

    func setLocalTrack(_ track: LKRTCVideoTrack?) {
        guard localTrack !== track else { return }
        localTrack?.remove(localView)
        localTrack = track
        localView = swap(localView)
        track?.add(localView)
        localView.isHidden = track == nil
    }

    /// Positions, in web-view points, straight from the call screen's layout. `clip` is the call
    /// area the page keeps its boxes inside; the views are bounded by it for the same reason the
    /// page sets `overflow: hidden` on it — a box that grows past the edge, because a swap gave
    /// it a wider feed, must be cut off rather than drawn across the rest of the app.
    func layout(clip: CGRect?, remote: CGRect?, local: CGRect?, cornerRadius: CGFloat, mirrorLocal: Bool) {
        guard let clip, clip.width > 1, clip.height > 1 else {
            hide()
            return
        }
        let origin = hostView?.frame.origin ?? .zero
        container.frame = clip.offsetBy(dx: origin.x, dy: origin.y)

        apply(rect: remote?.offsetBy(dx: -clip.minX, dy: -clip.minY), to: remoteView, cornerRadius: 0, mirrored: false)
        apply(rect: local?.offsetBy(dx: -clip.minX, dy: -clip.minY), to: localView, cornerRadius: cornerRadius, mirrored: mirrorLocal)

        // Which feed is the small one changes when the page swaps them, and the subview added
        // last always draws on top. Without this the picture-in-picture sits under the full-size
        // feed the moment the two are swapped.
        if let remote, let local {
            let remoteIsSmaller = remote.width * remote.height <= local.width * local.height
            container.bringSubviewToFront(remoteIsSmaller ? remoteView : localView)
        }
    }

    /// The call screen is gone (tab switch, call ended, app backgrounded): show nothing, but
    /// keep the tracks so coming back needs no renegotiation.
    func hide() {
        remoteView.isHidden = true
        localView.isHidden = true
    }

    /// End of call. Detaching the tracks retires both views with them, so the last frame of this
    /// call is destroyed here rather than waiting to be painted over by the next one.
    func teardown() {
        setRemoteTrack(nil)
        setLocalTrack(nil)
        hide()
    }

    // MARK: - internals

    @objc nonisolated public func videoView(_ videoView: LKRTCVideoRenderer, didChangeVideoSize size: CGSize) {
        Task { @MainActor in
            guard size.width > 0, size.height > 0 else { return }
            self.onVideoSize?(videoView === self.remoteView ? "remote" : "local", size)
        }
    }

    private func apply(rect: CGRect?, to view: LKRTCMTLVideoView, cornerRadius: CGFloat, mirrored: Bool) {
        guard let rect, rect.width > 1, rect.height > 1 else {
            view.isHidden = true
            return
        }
        view.frame = rect
        view.layer.cornerRadius = cornerRadius
        // The front camera is shown mirrored, the way every video call app shows your own face.
        view.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        view.isHidden = false
    }
}

/// Camera capture for a native call. Front by default; the switch is one call away because the
/// capturer only needs a different device.
@MainActor
final class NativeCallCamera {
    private let capturer: LKRTCCameraVideoCapturer
    private let source: LKRTCVideoSource
    private(set) var position: AVCaptureDevice.Position = .front
    private var capturing = false

    /// Whether the call wants the camera on. iOS refuses camera capture in the background, so
    /// a call answered from the lock screen starts with no picture; this is what says the
    /// picture is owed once the app comes forward.
    private var wanted = false
    private var observers: [NSObjectProtocol] = []

    init(source: LKRTCVideoSource) {
        self.source = source
        capturer = LKRTCCameraVideoCapturer(delegate: source)

        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.wanted, !self.capturing else { return }
                self.start(position: self.position)
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.capturing else { return }
                // iOS interrupts the session anyway; stopping cleanly keeps the capturer in a
                // state it can be restarted from.
                self.capturer.stopCapture()
                self.capturing = false
            }
        })
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    var isFrontFacing: Bool { position == .front }

    func start(position: AVCaptureDevice.Position = .front) {
        wanted = true
        guard UIApplication.shared.applicationState != .background else {
            // Nothing to do yet: the notification above starts it when the app comes forward.
            self.position = position
            return
        }
        guard let device = Self.device(for: position),
              let format = Self.format(for: device),
              let fps = Self.frameRate(for: format) else { return }
        self.position = position

        // Starting while a session is still running — or still tearing down — leaves the
        // capturer producing nothing, and the other side sits on the last frame it received.
        // Always go through a completed stop first.
        if capturing {
            capturing = false
            capturer.stopCapture { [weak self] in
                Task { @MainActor in
                    guard let self, self.wanted else { return }
                    self.capturing = true
                    self.capturer.startCapture(with: device, format: format, fps: fps)
                }
            }
            return
        }
        capturing = true
        capturer.startCapture(with: device, format: format, fps: fps)
    }

    func stop() {
        wanted = false
        guard capturing else { return }
        capturing = false
        capturer.stopCapture()
    }

    /// Turning the camera off and on again: the session is stopped and started cleanly, so the
    /// picture resumes instead of freezing where it stopped.
    func setEnabled(_ enabled: Bool) {
        if enabled { start(position: position) } else { stop() }
    }

    /// Flips to the other camera and reports where it ended up, so the web layer never claims
    /// a switch that a single-camera device could not make.
    func flip(completion: @escaping (AVCaptureDevice.Position) -> Void) {
        let next: AVCaptureDevice.Position = position == .front ? .back : .front
        guard Self.device(for: next) != nil else {
            completion(position)
            return
        }
        // `start` already goes through a completed stop; stopping here as well stopped it twice.
        start(position: next)
        completion(position)
    }

    private static func device(for position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        LKRTCCameraVideoCapturer.captureDevices().first { $0.position == position }
    }

    /// 720p is the sweet spot for a phone call: 1080p costs battery and uplink for detail the
    /// other side's view cannot show anyway.
    private static func format(for device: AVCaptureDevice) -> AVCaptureDevice.Format? {
        let formats = LKRTCCameraVideoCapturer.supportedFormats(for: device)
        let target = 1280 * 720
        return formats.min { lhs, rhs in
            let l = CMVideoFormatDescriptionGetDimensions(lhs.formatDescription)
            let r = CMVideoFormatDescriptionGetDimensions(rhs.formatDescription)
            return abs(Int(l.width * l.height) - target) < abs(Int(r.width * r.height) - target)
        }
    }

    private static func frameRate(for format: AVCaptureDevice.Format) -> Int? {
        format.videoSupportedFrameRateRanges.map { Int($0.maxFrameRate) }.max().map { min($0, 30) }
    }
}
