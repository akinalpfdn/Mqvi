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
/// call state machine and hands this plugin only SDP and ICE. Audio and camera both run here;
/// the video is drawn by NativeCallVideo.
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
        CAPPluginMethod(name: "setRemoteVolume", returnType: CAPPluginReturnPromise),
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
    /// The peer's audio, held so the volume can reach it. Remote audio plays natively here, so
    /// the page's <audio> element — where the web engine applies the volume — never exists.
    private var remoteAudioTrack: LKRTCAudioTrack?
    /// Gain for the peer's audio; 1 is unchanged. Kept so a track that arrives later gets it.
    private var remoteGain: Double = 1
    private var camera: NativeCallCamera?
    private var callId: String?
    private var isCaller = false
    /// Renegotiation is the offerer's job; the answerer only ever answers.
    private var makingOffer = false
    /// Bumped by every start and every teardown. A start waits on permission prompts, and the
    /// call can end during that wait; whatever it does afterwards checks its generation first,
    /// so a cancelled start cannot build a connection or switch the microphone on.
    private var generation = 0
    /// Off until start has sent the one initial offer. Adding the audio track fires
    /// shouldNegotiate before the camera prompt has been answered, and letting that through
    /// produced an audio-only offer followed by a second one with video.
    private var negotiationArmed = false

    /// Serializes audio session hand-offs. The generation check and the switch happen in one
    /// step here, so a start cancelled mid-way can never turn the session on after its own
    /// teardown turned it off. Not done under `lock`: WebRTC's delegate callbacks take that lock,
    /// and holding it across a call into WebRTC risks a deadlock.
    private let audioQueue = DispatchQueue(label: "net.mqvi.call-audio")

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

        lock.lock()
        generation += 1
        let gen = generation
        lock.unlock()

        requestMicrophone { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("microphone permission denied")
                return
            }
            // The permission prompt can outlive the call: hung up while it was on screen.
            guard self.isCurrent(gen) else {
                call.reject("cancelled")
                return
            }

            // Take the session before the connection exists: when the call came in through
            // CallKit the system has already activated it, and this is what enables the audio
            // unit for it.
            self.beginAudio(for: gen)

            // Blank the surface before this call can put a box on screen. Teardown already does
            // it when a call ends cleanly, but a call that ended any other way would otherwise
            // leave its last frame to be shown at the start of this one.
            Task { @MainActor in
                if self.isCurrent(gen) { NativeCallVideo.shared.teardown() }
            }

            guard let built = self.makePeerConnection(iceServers: iceServers) else {
                call.reject("failed to create peer connection")
                return
            }
            let (pc, audio) = built
            guard self.adopt(pc, audio: audio, callId: callId, isCaller: isCaller, generation: gen) else {
                pc.close()
                call.reject("cancelled")
                return
            }

            // A video call publishes the camera from the start, both sides. Toggling it later
            // only flips the track, so a mid-call toggle never has to renegotiate.
            if wantsVideo {
                self.requestCamera { granted in
                    guard self.isCurrent(gen) else {
                        call.reject("cancelled")
                        return
                    }
                    if granted {
                        self.addVideoTrack(to: pc, generation: gen)
                    } else {
                        print("[p2p-native] camera permission denied; continuing with audio only")
                    }
                    if isCaller { self.sendInitialOffer(on: pc) }
                    // The button must follow the camera, not the intention: a denied camera
                    // leaves the call running with video off.
                    call.resolve(["video": granted])
                }
                return
            }
            // The offerer offers immediately; the answerer waits for the offer, which is what
            // creates its side of the negotiation.
            if isCaller { self.sendInitialOffer(on: pc) }
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
                    self.emitLocalDescription(from: pc, type: "answer", sdp: answer.sdp)
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

    /// The peer's volume as a percentage, 0–200 like the web slider. The audio source takes a
    /// gain in 0...10, so 100% is 1 and 200% is 2.
    @objc func setRemoteVolume(_ call: CAPPluginCall) {
        let percent = min(max(call.getDouble("volume") ?? 100, 0), 200)
        lock.lock()
        remoteGain = percent / 100
        let track = remoteAudioTrack
        let gain = remoteGain
        lock.unlock()
        track?.source.volume = gain
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

    private func addVideoTrack(to pc: LKRTCPeerConnection, generation gen: Int) {
        let source = Self.factory.videoSource()
        let track = Self.factory.videoTrack(with: source, trackId: "mqvi-video")
        pc.add(track, streamIds: ["mqvi"])

        lock.lock()
        if generation == gen { videoTrack = track }
        lock.unlock()

        // The capturer and the views are main-actor bound: they drive UIKit and the capture
        // session, both of which expect the main thread.
        Task { @MainActor in
            let camera = NativeCallCamera(source: source)
            // Checked and stored in one step: teardown reads `camera` under the same lock, so
            // either it sees this one and stops it, or this sees the call is over and never
            // starts it. A camera started after teardown ran would record with no call.
            self.lock.lock()
            let current = self.generation == gen
            if current { self.camera = camera }
            self.lock.unlock()
            guard current else { return }
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

    private func makePeerConnection(iceServers: [LKRTCIceServer]) -> (LKRTCPeerConnection, LKRTCAudioTrack)? {
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
        return (pc, track)
    }

    /// Makes `pc` this call's connection, unless the call ended while it was being built. Any
    /// connection still held is closed rather than overwritten: dropping the reference alone
    /// left it running, holding the microphone and emitting into the next call.
    private func adopt(
        _ pc: LKRTCPeerConnection,
        audio: LKRTCAudioTrack,
        callId: String,
        isCaller: Bool,
        generation gen: Int
    ) -> Bool {
        lock.lock()
        guard generation == gen else {
            lock.unlock()
            return false
        }
        let previous = peerConnection
        peerConnection = pc
        audioTrack = audio
        self.callId = callId
        self.isCaller = isCaller
        negotiationArmed = false
        lock.unlock()
        previous?.close()
        return true
    }

    /// The caller's single initial offer, sent once every track the call starts with is in
    /// place. Later renegotiations (ICE restart) go through shouldNegotiate, which this arms.
    private func sendInitialOffer(on pc: LKRTCPeerConnection) {
        lock.lock()
        negotiationArmed = true
        lock.unlock()
        createOffer(on: pc)
    }

    private func isCurrent(_ gen: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return generation == gen
    }

    /// The call a delegate event belongs to, or nil when it comes from a connection this plugin
    /// has already let go of — those must not reach whichever call is running now.
    private func callId(owning pc: LKRTCPeerConnection) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return pc === peerConnection ? callId : nil
    }

    private func beginAudio(for gen: Int) {
        audioQueue.sync {
            guard self.isCurrent(gen) else { return }
            CallAudioSession.begin()
        }
    }

    private func endAudio() {
        audioQueue.sync { CallAudioSession.end() }
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
                self.emitLocalDescription(from: pc, type: "offer", sdp: offer.sdp)
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
        // The generation moves first, so a start still waiting on a permission prompt sees that
        // its call is over and builds nothing when the prompt is answered.
        lock.lock()
        generation += 1
        let pc = peerConnection
        let camera = self.camera
        peerConnection = nil
        audioTrack = nil
        videoTrack = nil
        remoteAudioTrack = nil
        remoteGain = 1
        self.camera = nil
        callId = nil
        makingOffer = false
        negotiationArmed = false
        lock.unlock()

        endAudio()
        Task { @MainActor in
            camera?.stop()
            NativeCallVideo.shared.teardown()
        }
        pc?.close()
    }

    /// Call events are never retained. The engine subscribes before it starts the call, so a
    /// retained event only ever had one audience: the next call's listeners, which Capacitor
    /// hands everything it held the moment they attach. A stale offer delivered that way was
    /// forwarded to the new peer and broke the call.
    private func emitLocalDescription(from pc: LKRTCPeerConnection, type: String, sdp: String) {
        guard let callId = callId(owning: pc) else { return }
        notifyListeners("localDescription", data: ["callId": callId, "type": type, "sdp": sdp])
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
    // Every event below is dropped unless it comes from the connection this call owns. A closed
    // connection can still deliver a few callbacks, and by then the listeners belong to the next
    // call.

    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        guard let callId = callId(owning: peerConnection) else { return }
        notifyListeners("iceCandidate", data: [
            "callId": callId,
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid ?? "",
            "sdpMLineIndex": Int(candidate.sdpMLineIndex)
        ])
    }

    // Spelled out because this one is optional in the protocol: a signature Swift infers
    // differently compiles fine and is simply never called.
    @objc(peerConnection:didChangeConnectionState:)
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        guard let callId = callId(owning: peerConnection) else { return }
        notifyListeners("connectionState", data: ["callId": callId, "state": Self.name(for: newState)])
    }

    /// The remote tracks arrive here: audio is kept for the volume, video goes to the surface.
    /// Optional in the protocol, so the selector is spelled out.
    @objc(peerConnection:didAddReceiver:streams:)
    public func peerConnection(
        _ peerConnection: LKRTCPeerConnection,
        didAdd rtpReceiver: LKRTCRtpReceiver,
        streams mediaStreams: [LKRTCMediaStream]
    ) {
        guard let callId = callId(owning: peerConnection) else { return }
        if let audio = rtpReceiver.track as? LKRTCAudioTrack {
            lock.lock()
            remoteAudioTrack = audio
            let gain = remoteGain
            lock.unlock()
            audio.source.volume = gain
            return
        }
        guard let track = rtpReceiver.track as? LKRTCVideoTrack else { return }
        Task { @MainActor in NativeCallVideo.shared.setRemoteTrack(track) }
        notifyListeners("remoteVideo", data: ["callId": callId, "available": true])
    }

    @objc(peerConnection:didRemoveReceiver:)
    public func peerConnection(
        _ peerConnection: LKRTCPeerConnection,
        didRemove rtpReceiver: LKRTCRtpReceiver
    ) {
        guard let callId = callId(owning: peerConnection),
              rtpReceiver.track is LKRTCVideoTrack else { return }
        Task { @MainActor in NativeCallVideo.shared.setRemoteTrack(nil) }
        notifyListeners("remoteVideo", data: ["callId": callId, "available": false])
    }

    public func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {
        // The answerer never offers: doing so mid-call is what produces glare. The caller waits
        // for start to send its one initial offer; see `negotiationArmed`.
        lock.lock()
        let mayOffer = peerConnection === self.peerConnection && isCaller && negotiationArmed
        lock.unlock()
        guard mayOffer, peerConnection.signalingState == .stable else { return }
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
