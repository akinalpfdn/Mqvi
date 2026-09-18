import AVFoundation
import Foundation
import LiveKitWebRTC
import UIKit

/// Native call video, drawn in views over the web view at the rectangles the page sends.
/// Over, not under: under would need every ancestor of the call screen to be transparent.
@MainActor
final class NativeCallVideo: NSObject, LKRTCVideoViewDelegate {
    static let shared = NativeCallVideo()

    /// A feed's pixel size, so the page can shape a box it has no element to measure.
    var onVideoSize: ((String, CGSize) -> Void)?
    /// Latest size per source, for a page that subscribes late. Cleared with each new view.
    private(set) var sizes: [String: CGSize] = [:]

    private let container = UIView()
    // Replaced with each new track; see `swap`.
    private var remoteView = LKRTCMTLVideoView()
    private var localView = LKRTCMTLVideoView()

    // Strong: a receiver's track wrapper has no other owner, and its dealloc unhooks the renderer.
    private var remoteTrack: LKRTCVideoTrack?
    private var localTrack: LKRTCVideoTrack?
    private var attached = false
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
        // Fit, like the web's `object-fit: contain`.
        view.videoContentMode = .scaleAspectFit
        view.clipsToBounds = true
        view.isHidden = true
        view.delegate = self
    }

    /// A fresh view per track: a Metal view keeps its last frame, which the next call would show.
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
        sizes["remote"] = nil
        track?.add(remoteView)
        remoteView.isHidden = track == nil
    }

    func setLocalTrack(_ track: LKRTCVideoTrack?) {
        guard localTrack !== track else { return }
        localTrack?.remove(localView)
        localTrack = track
        localView = swap(localView)
        sizes["local"] = nil
        track?.add(localView)
        localView.isHidden = track == nil
    }

    /// `clip` bounds the views like the page's `overflow: hidden` bounds its boxes.
    func layout(clip: CGRect?, remote: CGRect?, local: CGRect?, holes: [CGRect], cornerRadius: CGFloat, mirrorLocal: Bool) {
        guard let clip, clip.width > 1, clip.height > 1 else {
            hide()
            return
        }
        let origin = hostView?.frame.origin ?? .zero
        container.frame = clip.offsetBy(dx: origin.x, dy: origin.y)

        // What the page draws over the video is cut out, so it shows through instead of under it.
        // The page merges overlapping holes, which even-odd filling needs.
        if holes.isEmpty {
            container.layer.mask = nil
        } else {
            let path = UIBezierPath(rect: container.bounds)
            for hole in holes {
                path.append(UIBezierPath(rect: hole.offsetBy(dx: -clip.minX, dy: -clip.minY)))
            }
            let mask = CAShapeLayer()
            mask.path = path.cgPath
            mask.fillRule = .evenOdd
            container.layer.mask = mask
        }

        // The rounded corners and the top of the stack belong to the small box, whichever feed a
        // swap has put in it.
        var remoteIsSmaller = false
        if let remote, let local {
            remoteIsSmaller = remote.width * remote.height <= local.width * local.height
        }
        apply(rect: remote?.offsetBy(dx: -clip.minX, dy: -clip.minY), to: remoteView,
              cornerRadius: remoteIsSmaller ? cornerRadius : 0, mirrored: false)
        apply(rect: local?.offsetBy(dx: -clip.minX, dy: -clip.minY), to: localView,
              cornerRadius: remoteIsSmaller ? 0 : cornerRadius, mirrored: mirrorLocal)
        if remote != nil, local != nil {
            container.bringSubviewToFront(remoteIsSmaller ? remoteView : localView)
        }
    }

    /// Hides the views but keeps the tracks, so coming back needs no renegotiation.
    func hide() {
        remoteView.isHidden = true
        localView.isHidden = true
    }

    /// Retires both views, destroying the call's last frame.
    func teardown() {
        setRemoteTrack(nil)
        setLocalTrack(nil)
        hide()
    }

    // MARK: - internals

    @objc nonisolated public func videoView(_ videoView: LKRTCVideoRenderer, didChangeVideoSize size: CGSize) {
        Task { @MainActor in
            guard size.width > 0, size.height > 0 else { return }
            // A late callback from a retired view belongs to neither feed.
            let source: String
            if videoView === self.remoteView { source = "remote" }
            else if videoView === self.localView { source = "local" }
            else { return }
            self.sizes[source] = size
            self.onVideoSize?(source, size)
        }
    }

    private func apply(rect: CGRect?, to view: LKRTCMTLVideoView, cornerRadius: CGFloat, mirrored: Bool) {
        guard let rect, rect.width > 1, rect.height > 1 else {
            view.isHidden = true
            return
        }
        view.frame = rect
        view.layer.cornerRadius = cornerRadius
        view.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        view.isHidden = false
    }
}

/// Camera capture. Requests set what the call wants; `reconcile` gets there with one
/// start or stop in flight, since starting on a session still stopping froze the picture.
@MainActor
final class NativeCallCamera {
    private let capturer: LKRTCCameraVideoCapturer
    private let source: LKRTCVideoSource
    /// The camera failed to start; the call has to stop claiming a picture.
    var onStartFailed: (@MainActor () -> Void)?

    private(set) var position: AVCaptureDevice.Position = .front
    private var wanted = false
    /// iOS refuses capture in the background; the picture is owed once the app comes forward.
    private var suspended: Bool
    private var running: AVCaptureDevice.Position?
    private var busy = false
    private var observers: [NSObjectProtocol] = []

    init(source: LKRTCVideoSource) {
        self.source = source
        capturer = LKRTCCameraVideoCapturer(delegate: source)
        // Here, not as a default: defaults run off the main actor.
        suspended = UIApplication.shared.applicationState == .background

        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.suspended = false
                self.reconcile()
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.suspended = true
                self.reconcile()
            }
        })
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    func start(position: AVCaptureDevice.Position = .front) {
        wanted = true
        self.position = position
        reconcile()
    }

    func stop() {
        wanted = false
        reconcile()
    }

    func setEnabled(_ enabled: Bool) {
        if enabled { start(position: position) } else { stop() }
    }

    /// Reports where it ended up; a single-camera device stays put.
    func flip(completion: @escaping (AVCaptureDevice.Position) -> Void) {
        let next: AVCaptureDevice.Position = position == .front ? .back : .front
        guard Self.device(for: next) != nil else {
            completion(position)
            return
        }
        position = next
        reconcile()
        completion(position)
    }

    /// One step toward the wanted state; each finished transition calls it again.
    private func reconcile() {
        guard !busy else { return }
        let target: AVCaptureDevice.Position? = wanted && !suspended ? position : nil
        guard running != target else { return }

        // Strong captures: a stop deferred behind a start must outlive the call's reference.
        if running != nil {
            busy = true
            capturer.stopCapture { [self] in
                Task { @MainActor in
                    self.busy = false
                    self.running = nil
                    self.reconcile()
                }
            }
            return
        }

        guard let target,
              let device = Self.device(for: target),
              let format = Self.format(for: device),
              let fps = Self.frameRate(for: format) else { return }
        busy = true
        running = target
        capturer.startCapture(with: device, format: format, fps: fps) { [self] error in
            Task { @MainActor in
                self.busy = false
                if let error {
                    // Not retried: a broken camera would loop, and the UI now says it is off.
                    print("[p2p-native] camera start failed: \(error.localizedDescription)")
                    self.running = nil
                    self.wanted = false
                    self.onStartFailed?()
                    return
                }
                self.reconcile()
            }
        }
    }

    private static func device(for position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        LKRTCCameraVideoCapturer.captureDevices().first { $0.position == position }
    }

    /// 720p: more costs battery and uplink the peer's view cannot show.
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
