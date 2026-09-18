import AVFoundation
import Capacitor
import Foundation
import LiveKitWebRTC

/// Native media for p2p calls on iOS; the JS layer keeps the call state and signalling.
/// WKWebView cannot capture the microphone while CallKit owns the audio session.
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
        CAPPluginMethod(name: "getVideoSizes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setIceServers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restartIce", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resendPendingOffer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardOrphanedCall", returnType: CAPPluginReturnPromise)
    ]

    /// One factory per process: a second audio device module would fight over the microphone.
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
    private var videoSource: LKRTCVideoSource?
    /// Held for the volume: remote audio plays here, not in the page.
    private var remoteAudioTrack: LKRTCAudioTrack?
    private var remoteGain: Double = 1
    /// Kept apart from the track: a mute can arrive before the track exists.
    private var micEnabled = true
    /// Last change wins, and no WebRTC call runs under `lock`.
    private let micQueue = DispatchQueue(label: "net.mqvi.call-mic")
    /// Only an audio session this plugin opened may be closed by it (audioQueue only).
    private var audioOwned = false
    private var camera: NativeCallCamera?
    private var callId: String?
    private var isCaller = false
    /// Renegotiation is the offerer's job; the answerer only ever answers.
    private var makingOffer = false
    /// Bumped by start and teardown; work finishing after a prompt checks it first.
    private var generation = 0
    /// Holds shouldNegotiate back until start sends the single initial offer.
    private var negotiationArmed = false

    /// Check-and-switch of the audio session in one step. Not under `lock`: delegates take it.
    private let audioQueue = DispatchQueue(label: "net.mqvi.call-audio")

    // MARK: - JS surface

    public override func load() {
        Task { @MainActor in
            NativeCallVideo.shared.onVideoSize = { [weak self] source, size in
                // Not retained: Capacitor would queue every change, a late subscriber pulls
                // the current sizes with getVideoSizes instead.
                self?.notifyListeners("videoSize", data: [
                    "source": source,
                    "width": Double(size.width),
                    "height": Double(size.height)
                ])
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

            // Before the connection exists: this enables the audio unit for a CallKit session.
            self.beginAudio(for: gen)

            // Blank the surface, in case the previous call did not end cleanly.
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

            // Video calls publish the camera from the start, so a toggle never renegotiates. Only
            // the capturer needs the permission, so audio never waits on a camera prompt iOS
            // holds back until the phone is unlocked.
            let access = AVCaptureDevice.authorizationStatus(for: .video)
            let video = wantsVideo && (access == .authorized || access == .notDetermined)
            if wantsVideo && !video {
                print("[p2p-native] camera permission denied; continuing with audio only")
            }
            if video {
                self.addVideoTrack(to: pc, generation: gen)
                self.requestCamera { granted in
                    Task { @MainActor in
                        if granted {
                            self.startCamera(generation: gen)
                        } else {
                            self.cameraFailed(generation: gen)
                        }
                    }
                }
            }
            if isCaller { self.sendInitialOffer(on: pc) }
            call.resolve(["video": video])
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
        // Both sides offered at once: the caller's offer wins, and the peer answers it instead.
        lock.lock()
        let offering = makingOffer
        lock.unlock()
        if isCallerNow() && (offering || pc.signalingState != .stable) {
            call.resolve()
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
        micEnabled = enabled
        lock.unlock()
        applyMic()
        call.resolve()
    }

    /// 0–200%, as on the web; the source takes a gain where 1 is unchanged.
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

    /// Fresh TURN credentials for a relayed reconnect.
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
        let requested = call.getBool("enabled") ?? true
        lock.lock()
        let track = videoTrack
        let camera = self.camera
        let gen = generation
        lock.unlock()

        guard let track else {
            call.resolve(["enabled": false])
            return
        }
        // Denied: nothing can capture, so the button must not light. Undecided: the prompt's
        // answer starts the camera or reports it failed.
        let access = AVCaptureDevice.authorizationStatus(for: .video)
        let enabled = requested && (access == .authorized || access == .notDetermined)
        track.isEnabled = enabled
        Task { @MainActor in
            if let camera {
                camera.setEnabled(enabled)
            } else if enabled && access == .authorized {
                // Allowed in Settings after the call started without it.
                self.startCamera(generation: gen)
            }
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

    @objc func setVideoLayout(_ call: CAPPluginCall) {
        let clip = Self.rect(from: call.getObject("clip"))
        let holes = (call.getArray("holes") ?? []).compactMap { Self.rect(from: $0 as? JSObject) }
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
                holes: holes,
                cornerRadius: CGFloat(radius),
                mirrorLocal: mirror
            )
            call.resolve()
        }
    }

    @objc func getVideoSizes(_ call: CAPPluginCall) {
        Task { @MainActor in
            var result = JSObject()
            for (source, size) in NativeCallVideo.shared.sizes {
                let entry: JSObject = ["width": Double(size.width), "height": Double(size.height)]
                result[source] = entry
            }
            call.resolve(result)
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
        guard isCallerNow() else {
            call.resolve()
            return
        }
        // An unanswered offer blocks a restart until the answer comes; it may have been lost on
        // the way, so send it again instead.
        if !resendPendingOffer(on: pc) {
            pc.restartIce()
        }
        call.resolve()
    }

    @objc func resendPendingOffer(_ call: CAPPluginCall) {
        guard let pc = currentPeerConnection() else {
            call.resolve(["resent": false])
            return
        }
        call.resolve(["resent": resendPendingOffer(on: pc)])
    }

    private func resendPendingOffer(on pc: LKRTCPeerConnection) -> Bool {
        lock.lock()
        let offering = makingOffer
        lock.unlock()
        guard pc.signalingState == .haveLocalOffer, !offering, let offer = pc.localDescription else { return false }
        emitLocalDescription(from: pc, type: "offer", sdp: offer.sdp)
        return true
    }

    @objc func closeCall(_ call: CAPPluginCall) {
        teardown()
        call.resolve()
    }

    /// Called at page load: a reload keeps this plugin, so a call the old page ran is ended here.
    @objc func discardOrphanedCall(_ call: CAPPluginCall) {
        lock.lock()
        let orphan = callId
        lock.unlock()
        // Unconditionally: this also cancels a start still behind a permission prompt.
        teardown()
        guard let orphan else {
            call.resolve(["discarded": false])
            return
        }
        DispatchQueue.main.async {
            CallManager.shared.endCall(callId: orphan, reason: "failed")
            call.resolve(["discarded": true, "callId": orphan])
        }
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
        if generation == gen {
            videoTrack = track
            videoSource = source
        }
        lock.unlock()
    }

    /// Builds the capturer once the permission is there; it starts only if the video is on.
    @MainActor
    private func startCamera(generation gen: Int) {
        lock.lock()
        let source = generation == gen && camera == nil ? videoSource : nil
        lock.unlock()
        guard let source else { return }

        let camera = NativeCallCamera(source: source)
        camera.onStartFailed = { [weak self] in self?.cameraFailed(generation: gen) }
        // Checked and stored under the lock teardown reads it with, so a camera never outlives its call.
        lock.lock()
        let current = generation == gen && self.camera == nil
        if current { self.camera = camera }
        let track = videoTrack
        lock.unlock()
        // Turned off while the permission prompt was up: built, not started.
        guard current, let track, track.isEnabled else { return }
        camera.start()
        NativeCallVideo.shared.setLocalTrack(track)
    }

    /// Turns the video off and tells the page, so the button and the peer stop showing a picture.
    @MainActor
    private func cameraFailed(generation gen: Int) {
        lock.lock()
        let track = generation == gen ? videoTrack : nil
        let callId = self.callId
        lock.unlock()
        guard let track, let callId else { return }
        track.isEnabled = false
        NativeCallVideo.shared.setLocalTrack(nil)
        notifyListeners("localVideo", data: ["callId": callId, "available": false])
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
        lock.lock()
        let enabled = micEnabled
        lock.unlock()
        track.isEnabled = enabled
        pc.add(track, streamIds: ["mqvi"])
        return (pc, track)
    }

    /// Adopts `pc` unless the call ended meanwhile; a previous connection is closed, not dropped.
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
        applyMic()
        return true
    }

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

    /// Nil for a connection this plugin has let go of.
    private func callId(owning pc: LKRTCPeerConnection) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return pc === peerConnection ? callId : nil
    }

    private func beginAudio(for gen: Int) {
        audioQueue.sync {
            guard self.isCurrent(gen) else { return }
            CallAudioSession.begin()
            self.audioOwned = true
        }
    }

    private func endAudio() {
        audioQueue.sync {
            guard self.audioOwned else { return }
            self.audioOwned = false
            CallAudioSession.end()
        }
    }

    private func applyMic() {
        micQueue.async {
            self.lock.lock()
            let track = self.audioTrack
            let enabled = self.micEnabled
            self.lock.unlock()
            track?.isEnabled = enabled
        }
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
        // Generation first, so a start behind a permission prompt builds nothing.
        lock.lock()
        generation += 1
        let pc = peerConnection
        let camera = self.camera
        peerConnection = nil
        audioTrack = nil
        videoTrack = nil
        videoSource = nil
        remoteAudioTrack = nil
        remoteGain = 1
        micEnabled = true
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

    /// Never retained: Capacitor would hand a stale event to the next call's listeners.
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
    // Events from a connection this call no longer owns are dropped.

    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        guard let callId = callId(owning: peerConnection) else { return }
        notifyListeners("iceCandidate", data: [
            "callId": callId,
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid ?? "",
            "sdpMLineIndex": Int(candidate.sdpMLineIndex)
        ])
    }

    // Selector spelled out: an optional method with a mismatched signature is never called.
    @objc(peerConnection:didChangeConnectionState:)
    public func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        guard let callId = callId(owning: peerConnection) else { return }
        notifyListeners("connectionState", data: ["callId": callId, "state": Self.name(for: newState)])
    }

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
        // Only the caller offers (no glare), and only after start's initial offer.
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
