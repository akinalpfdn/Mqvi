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
final class NativeCallVideo {
    static let shared = NativeCallVideo()

    private let container = UIView()
    private let remoteView = LKRTCMTLVideoView()
    private let localView = LKRTCMTLVideoView()

    private weak var remoteTrack: LKRTCVideoTrack?
    private weak var localTrack: LKRTCVideoTrack?
    private var attached = false

    private init() {
        container.isUserInteractionEnabled = false
        container.backgroundColor = .clear
        for view in [remoteView, localView] {
            view.videoContentMode = .scaleAspectFill
            view.clipsToBounds = true
            view.isHidden = true
            container.addSubview(view)
        }
    }

    // MARK: - lifecycle

    /// Puts the container over the web view, without taking touches from it.
    func attach(to webView: UIView) {
        guard !attached, let parent = webView.superview else { return }
        container.frame = webView.frame
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        parent.insertSubview(container, aboveSubview: webView)
        attached = true
    }

    func setRemoteTrack(_ track: LKRTCVideoTrack?) {
        if let current = remoteTrack, current !== track {
            current.remove(remoteView)
        }
        remoteTrack = track
        track?.add(remoteView)
        remoteView.isHidden = track == nil
    }

    func setLocalTrack(_ track: LKRTCVideoTrack?) {
        if let current = localTrack, current !== track {
            current.remove(localView)
        }
        localTrack = track
        track?.add(localView)
        localView.isHidden = track == nil
    }

    /// Positions, in web-view points, straight from the call screen's layout.
    func layout(remote: CGRect?, local: CGRect?, cornerRadius: CGFloat, mirrorLocal: Bool) {
        apply(rect: remote, to: remoteView, cornerRadius: 0, mirrored: false)
        apply(rect: local, to: localView, cornerRadius: cornerRadius, mirrored: mirrorLocal)
    }

    /// The call screen is gone (tab switch, call ended, app backgrounded): show nothing, but
    /// keep the tracks so coming back needs no renegotiation.
    func hide() {
        remoteView.isHidden = true
        localView.isHidden = true
    }

    func teardown() {
        remoteTrack?.remove(remoteView)
        localTrack?.remove(localView)
        remoteTrack = nil
        localTrack = nil
        hide()
    }

    // MARK: - internals

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

    init(source: LKRTCVideoSource) {
        self.source = source
        capturer = LKRTCCameraVideoCapturer(delegate: source)
    }

    var isFrontFacing: Bool { position == .front }

    func start(position: AVCaptureDevice.Position = .front) {
        guard let device = Self.device(for: position),
              let format = Self.format(for: device),
              let fps = Self.frameRate(for: format) else { return }
        self.position = position
        capturing = true
        capturer.startCapture(with: device, format: format, fps: fps)
    }

    func stop() {
        guard capturing else { return }
        capturing = false
        capturer.stopCapture()
    }

    /// Flips to the other camera and reports where it ended up, so the web layer never claims
    /// a switch that a single-camera device could not make.
    func flip(completion: @escaping (AVCaptureDevice.Position) -> Void) {
        let next: AVCaptureDevice.Position = position == .front ? .back : .front
        guard Self.device(for: next) != nil else {
            completion(position)
            return
        }
        capturer.stopCapture { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.start(position: next)
                completion(self.position)
            }
        }
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
