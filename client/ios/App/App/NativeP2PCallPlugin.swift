import AVFoundation
import Capacitor
import Foundation
import LiveKitWebRTC

/// Native peer connection for p2p calls on iOS.
///
/// The media runs here instead of in WKWebView because the WebView cannot capture the
/// microphone while CallKit owns the audio session: a call answered from the system screen
/// connected but stayed silent in both directions. The call itself is unchanged — still
/// peer to peer, still signalled over the app's WebSocket by the JS layer, which owns the
/// call state machine and hands this plugin only SDP and ICE.
///
/// This phase carries audio. Video keeps running in the WebView until the native render
/// layer lands.
@objc(NativeP2PCallPlugin)
public class NativeP2PCallPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeP2PCallPlugin"
    public let jsName = "NativeP2PCall"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptRemoteOffer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptRemoteAnswer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addIceCandidate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMicEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVideoEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "switchCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVideoLayout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hideVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setIceServers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restartIce", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeCall", returnType: CAPPluginReturnPromise)
    ]

    /// One factory for the process: it owns the audio device module, and a second one would
    /// fight the first over the microphone.
    private static let factory: LKRTCPeerConnectionFactory = {
        LKRTCPeerConnectionFactory(
            encoderFactory: LKRTCDefaultVideoEncoderFactory(),
            decoderFactory: LKRTCDefaultVideoDecoderFactory()
        )
    }()

    /// Everything below is touched from JS calls and from WebRTC's own delegate queue.
    private let lock = NSLock()
    private var peerConnection: LKRTCPeerConnection?
    private var audioTrack: LKRTCAudioTrack?
    private var videoTrack: LKRTCVideoTrack?
    private var camera: NativeCallCamera?
    private var callId: String?
    private var isCaller = false
    /// Renegotiation is the offerer's job; the answerer only ever answers.
    private var makingOffer = false

    // MARK: - JS surface

    public override func load() {
        Task { @MainActor in
            NativeCallVideo.shared.onVideoSize = { [weak self] source, size in
                // Retained: the camera's first frame can land before the call screen has
                // subscribed, and a shape that never changes again would never be re-sent.
                self?.notifyListeners("videoSize", data: [
                    "source": source,
                    "width": Double(size.width),
                    "height": Double(size.height)
                ], retainUntilConsumed: true)
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId") else {
            call.reject("callId is required")
            return
        }
        let isCaller = call.getBool("isCaller") ?? false
        let wantsVideo = call.getString("callType") == "video"
        let iceServers = Self.parseIceServers(call.getArray("iceServers"))

        requestMicrophone { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("microphone permission denied")
                return
            }
            self.lock.lock()
            self.callId = callId
            self.isCaller = isCaller
            self.lock.unlock()

            // Take the session before the connection exists: when the call came in through
            // CallKit the system has already activated it, and this is what enables the audio
            // unit for it.
            CallAudioSession.begin()

            // Blank the surface before this call can put a box on screen. Teardown already does
            // it when a call ends cleanly, but a call that ended any other way would otherwise
            // leave its last frame to be shown at the start of this one.
            Task { @MainActor in NativeCallVideo.shared.teardown() }

            guard let pc = self.buildPeerConnection(iceServers: iceServers) else {
                CallAudioSession.end()
                call.reject("failed to create peer connection")
                return
            }

            // A video call publishes the camera from the start, both sides. Toggling it later
            // only flips the track, so a mid-call toggle never has to renegotiate.
            if wantsVideo {
                self.requestCamera { granted in
                    if granted {
                        self.addVideoTrack(to: pc)
                    } else {
                        print("[p2p-native] camera permission denied; continuing with audio only")
                    }
                    if isCaller { self.createOffer(on: pc) }
                    // The button must follow the camera, not the intention: a denied camera
                    // leaves the call running with video off.
                    call.resolve(["video": granted])
                }
                return
            }
            // The offerer offers immediately; the answerer waits for the offer, which is what
            // creates its side of the negotiation.
            if isCaller {
                self.createOffer(on: pc)
            }
            call.resolve(["video": false])
        }
    }

    @objc func acceptRemoteOffer(_ call: CAPPluginCall) {
        guard let sdp = call.getString("sdp") else {
            call.reject("sdp is required")
            return
        }
        guard let pc = currentPeerConnection() else {
            call.reject("no active call")
            return
        }
        let offer = LKRTCSessionDescription(type: .offer, sdp: sdp)
        pc.setRemoteDescription(offer) { [weak self] error in
            guard let self else { return }
            if let error {
                call.reject("setRemoteDescription(offer) failed: \(error.localizedDescription)")
                return
            }
            pc.answer(for: Self.mediaConstraints()) { answer, error in
                guard let answer else {
                    call.reject("createAnswer failed: \(error?.localizedDescription ?? "unknown")")
                    return
                }
                pc.setLocalDescription(answer) { error in
                    if let error {
                        call.reject("setLocalDescription(answer) failed: \(error.localizedDescription)")
                        return
                    }
                    self.emitLocalDescription(type: "answer", sdp: answer.sdp)
                    call.resolve()
                }
            }
        }
    }

    @objc func acceptRemoteAnswer(_ call: CAPPluginCall) {
        guard let sdp = call.getString("sdp") else {
            call.reject("sdp is required")
            return
        }
        guard let pc = currentPeerConnection() else {
            call.reject("no active call")
            return
        }
        pc.setRemoteDescription(LKRTCSessionDescription(type: .answer, sdp: sdp)) { error in
            if let error {
                // A late answer against a stable state is survivable; the call keeps running.
                print("[p2p-native] setRemoteDescription(answer): \(error.localizedDescription)")
            }
            call.resolve()
        }
    }

    @objc func addIceCandidate(_ call: CAPPluginCall) {
        guard let sdp = call.getString("candidate") else {
            call.reject("candidate is required")
            return
        }
        guard let pc = currentPeerConnection() else {
            call.resolve() // the call is gone; the candidate is meaningless
            return
        }
        let candidate = LKRTCIceCandidate(
            sdp: sdp,
            sdpMLineIndex: Int32(call.getInt("sdpMLineIndex") ?? 0),
            sdpMid: call.getString("sdpMid")
        )
        pc.add(candidate) { error in
            if let error {
                print("[p2p-native] addIceCandidate: \(error.localizedDescription)")
            }
            call.resolve()
        }
    }

    @objc func setMicEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        lock.lock()
        audioTrack?.isEnabled = enabled
        lock.unlock()
        call.resolve()
    }

    /// Fresh TURN credentials mid-call: a relayed reconnect may need a new allocation, and
    /// the one the call started with can be near expiry.
    @objc func setIceServers(_ call: CAPPluginCall) {
        guard let pc = currentPeerConnection() else {
            call.resolve()
            return
        }
        let config = pc.configuration
        config.iceServers = Self.parseIceServers(call.getArray("iceServers"))
        if !pc.setConfiguration(config) {
            print("[p2p-native] setConfiguration during recovery failed")
        }
        call.resolve()
    }

    @objc func setVideoEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        lock.lock()
        let track = videoTrack
        let camera = self.camera
        lock.unlock()

        guard let track else {
            call.resolve(["enabled": false])
            return
        }
        track.isEnabled = enabled
        Task { @MainActor in
            camera?.setEnabled(enabled)
            NativeCallVideo.shared.setLocalTrack(enabled ? track : nil)
            call.resolve(["enabled": enabled])
        }
    }

    @objc func switchCamera(_ call: CAPPluginCall) {
        lock.lock()
        let camera = self.camera
        lock.unlock()

        guard let camera else {
            call.resolve(["facing": "front"])
            return
        }
        Task { @MainActor in
            camera.flip { position in
                call.resolve(["facing": position == .front ? "front" : "back"])
            }
        }
    }

    /// Where the two feeds belong, in web-view points. The call screen owns the layout; this
    /// only follows it.
    @objc func setVideoLayout(_ call: CAPPluginCall) {
        let clip = Self.rect(from: call.getObject("clip"))
        let remote = Self.rect(from: call.getObject("remote"))
        let local = Self.rect(from: call.getObject("local"))
        let radius = call.getDouble("cornerRadius") ?? 0
        let mirror = call.getBool("mirrorLocal") ?? true
        Task { @MainActor in
            if let webView = self.webView {
                NativeCallVideo.shared.attach(to: webView)
            }
            NativeCallVideo.shared.layout(
                clip: clip,
                remote: remote,
                local: local,
                cornerRadius: CGFloat(radius),
                mirrorLocal: mirror
            )
            call.resolve()
        }
    }

    @objc func hideVideo(_ call: CAPPluginCall) {
        Task { @MainActor in
            NativeCallVideo.shared.hide()
            call.resolve()
        }
    }

    @objc func restartIce(_ call: CAPPluginCall) {
        guard let pc = currentPeerConnection() else {
            call.resolve()
            return
        }
        // Only the offerer can restart; the answerer asks the peer to, in the JS layer.
        if isCallerNow() {
            pc.restartIce()
        }
        call.resolve()
    }

    @objc func closeCall(_ call: CAPPluginCall) {
        teardown()
        call.resolve()
    }

    // MARK: - internals

    private func requestCamera(_ completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            completion(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        default:
            completion(false)
        }
    }

    private func addVideoTrack(to pc: LKRTCPeerConnection) {
        let source = Self.factory.videoSource()
        let track = Self.factory.videoTrack(with: source, trackId: "mqvi-video")
        pc.add(track, streamIds: ["mqvi"])

        lock.lock()
        videoTrack = track
        lock.unlock()

        // The capturer and the views are main-actor bound: they drive UIKit and the capture
        // session, both of which expect the main thread.
        Task { @MainActor in
            let camera = NativeCallCamera(source: source)
            self.lock.lock()
            self.camera = camera
            self.lock.unlock()
            camera.start()
            NativeCallVideo.shared.setLocalTrack(track)
        }
    }

    private static func rect(from object: JSObject?) -> CGRect? {
        guard let object,
              let x = object["x"] as? Double,
              let y = object["y"] as? Double,
              let width = object["width"] as? Double,
              let height = object["height"] as? Double else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func requestMicrophone(_ completion: @escaping (Bool) -> Void) {
        let session = AVAudioSession.sharedInstance()
        switch session.recordPermission {
        case .granted:
            completion(true)
        case .denied:
            completion(false)
        default:
            session.requestRecordPermission { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        }
    }

    private func buildPeerConnection(iceServers: [LKRTCIceServer]) -> LKRTCPeerConnection? {
        let config = LKRTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        // Trickle ICE: candidates go out as they are gathered, the way the web engine does it.
        config.continualGatheringPolicy = .gatherContinually

        guard let pc = Self.factory.peerConnection(
            with: config,
            constraints: Self.mediaConstraints(),
            delegate: self
        ) else { return nil }

        let source = Self.factory.audioSource(with: Self.audioConstraints())
        let track = Self.factory.audioTrack(with: source, trackId: "mqvi-audio")
        pc.add(track, streamIds: ["mqvi"])

        lock.lock()
        peerConnection = pc
        audioTrack = track
        lock.unlock()
        return pc
    }

    private func createOffer(on pc: LKRTCPeerConnection) {
        lock.lock()
        if makingOffer {
            lock.unlock()
            return
        }
        makingOffer = true
        lock.unlock()

        pc.offer(for: Self.mediaConstraints()) { [weak self] offer, error in
            guard let self else { return }
            guard let offer else {
                self.finishOffer()
                print("[p2p-native] createOffer: \(error?.localizedDescription ?? "unknown")")
                return
            }
            pc.setLocalDescription(offer) { error in
                self.finishOffer()
                if let error {
                    print("[p2p-native] setLocalDescription(offer): \(error.localizedDescription)")
                    return
                }
                self.emitLocalDescription(type: "offer", sdp: offer.sdp)
            }
        }
    }

    private func finishOffer() {
        lock.lock()
        makingOffer = false
        lock.unlock()
    }

    private func currentPeerConnection() -> LKRTCPeerConnection? {
        lock.lock()
        defer { lock.unlock() }
        return peerConnection
    }

    private func isCallerNow() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return isCaller
    }

    private func teardown() {
        CallAudioSession.end()
        lock.lock()
        let pc = peerConnection
        let camera = self.camera
        peerConnection = nil
        audioTrack = nil
        videoTrack = nil
        self.camera = nil
        callId = nil
        makingOffer = false
        lock.unlock()

        Task { @MainActor in
            camera?.stop()
            NativeCallVideo.shared.teardown()
        }
        pc?.close()
    }

    private func emitLocalDescription(type: String, sdp: String) {
        notifyListeners("localDescription", data: ["type": type, "sdp": sdp], retainUntilConsumed: true)
    }

    private static func mediaConstraints() -> LKRTCMediaConstraints {
        LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    }

    /// Matches what the web engine asks getUserMedia for.
    private static func audioConstraints() -> LKRTCMediaConstraints {
        LKRTCMediaConstraints(
            mandatoryConstraints: [
                "googEchoCancellation": "true",
                "googNoiseSuppression": "true",
                "googAutoGainControl": "true"
            ],
            optionalConstraints: nil
        )
    }

    private static func parseIceServers(_ raw: JSArray?) -> [LKRTCIceServer] {
        guard let raw else { return [] }
        return raw.compactMap { entry in
            guard let dict = entry as? JSObject else { return nil }
            let urls: [String]
            if let list = dict["urls"] as? [String] {
                urls = list
            } else if let single = dict["urls"] as? String {
                urls = [single]
            } else {
                return nil
            }
            return LKRTCIceServer(
                urlStrings: urls,
                username: dict["username"] as? String,
                credential: dict["credential"] as? String
            )
        }
    }
}

// MARK: - LKRTCPeerConnectionDelegate

extension NativeP2PCallPlugin: LKRTCPeerConnectionDelegate {
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        notifyListeners("iceCandidate", data: [
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid ?? "",
            "sdpMLineIndex": Int(candidate.sdpMLineIndex)
        ], retainUntilConsumed: true)
    }

    // Spelled out because this one is optional in the protocol: a signature Swift infers
    // differently compiles fine and is simply never called.
    @objc(peerConnection:didChangeConnectionState:)
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        notifyListeners("connectionState", data: ["state": Self.name(for: newState)])
    }

    /// The remote video arrives here; the surface draws it. Optional in the protocol, so the
    /// selector is spelled out.
    @objc(peerConnection:didAddReceiver:streams:)
    public func peerConnection(
        _ peerConnection: LKRTCPeerConnection,
        didAdd rtpReceiver: LKRTCRtpReceiver,
        streams mediaStreams: [LKRTCMediaStream]
    ) {
        guard let track = rtpReceiver.track as? LKRTCVideoTrack else { return }
        Task { @MainActor in NativeCallVideo.shared.setRemoteTrack(track) }
        notifyListeners("remoteVideo", data: ["available": true])
    }

    @objc(peerConnection:didRemoveReceiver:)
    public func peerConnection(
        _ peerConnection: LKRTCPeerConnection,
        didRemove rtpReceiver: LKRTCRtpReceiver
    ) {
        guard rtpReceiver.track is LKRTCVideoTrack else { return }
        Task { @MainActor in NativeCallVideo.shared.setRemoteTrack(nil) }
        notifyListeners("remoteVideo", data: ["available": false])
    }

    public func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {
        // The answerer never offers: doing so mid-call is what produces glare.
        guard isCallerNow(), peerConnection.signalingState == .stable else { return }
        createOffer(on: peerConnection)
    }

    // Unused, but the protocol requires them.
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {}
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {}
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {}

    private static func name(for state: LKRTCPeerConnectionState) -> String {
        switch state {
        case .new: return "new"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .disconnected: return "disconnected"
        case .failed: return "failed"
        case .closed: return "closed"
        @unknown default: return "unknown"
        }
    }
}
