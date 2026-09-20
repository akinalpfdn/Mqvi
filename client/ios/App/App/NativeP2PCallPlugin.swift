import AVFoundation
import Capacitor
import Foundation
import LiveKitWebRTC
import UIKit

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
        CAPPluginMethod(name: "discardOrphanedCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "adoptableCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOwner", returnType: CAPPluginReturnPromise)
    ]

    /// The page running the call, and what the native layer needs to hang up without it.
    private struct CallOwner {
        let callId: String
        var instanceId: String?
        var endKey: String?
        var serverUrl: String?
    }

    private static let controlLabel = "mqvi-control"
    private static let bye = "bye"
    /// The goodbye needs a moment on the wire before the connection closes under it.
    private static let byeFlushDelay: TimeInterval = 0.25

    /// How long a dead connection is left alone in the background before this side ends it.
    private static let backgroundDeadCallDelay: TimeInterval = 20
    /// A call that has not connected by now is given up, as the page's first-connect window does.
    private static let firstConnectDelay: TimeInterval = 60

    /// One factory per process: a second audio device module would fight over the microphone.
    private static let factory: LKRTCPeerConnectionFactory = {
        LKRTCPeerConnectionFactory(
            encoderFactory: LKRTCDefaultVideoEncoderFactory(),
            decoderFactory: LKRTCDefaultVideoDecoderFactory()
        )
    }()

    /// Lifecycle changes (start/adopt/teardown) run on main, as do video effects. The lock
    /// protects snapshots and signalling fields also read by the bridge/WebRTC queues.
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
    private var camera: NativeCallCamera?
    private var callId: String?
    /// The call this plugin is serving and the page instance that started it, from the moment
    /// start is called (a reload can land on a permission prompt). A reload hangs it up in that
    /// instance's name, the only one the server lets end an answered call.
    private var owner: CallOwner?
    /// The call's own channel, agreed on both sides; carries the goodbye past a suspended page.
    private var controlChannel: LKRTCDataChannel?
    /// Main queue only. See watchForDeadCall.
    private var deadCallCheck: DispatchWorkItem?
    private var isCaller = false
    /// Renegotiation is the offerer's job; the answerer only ever answers.
    private var makingOffer = false
    /// Bumped by start and teardown; work finishing after a prompt checks it first.
    private var generation = 0
    /// Holds shouldNegotiate back until start sends the single initial offer.
    private var negotiationArmed = false

    // MARK: - JS surface

    public override func load() {
        CallAudioSession.onFailure = { [weak self] callId in
            guard let self else { return }
            self.endIfServing(callId)
            self.notifyListeners("connectionState", data: ["callId": callId, "state": "closed"])
            CallManager.shared.endCall(callId: callId, reason: "failed")
        }
        // Hung up on the system call screen: the page may be suspended and unable to stop the
        // media, so the microphone is released here; the page ends the call on the server later.
        CallManager.shared.onEndedBySystem = { [weak self] callId in
            self?.endIfServing(callId)
        }
        CallManager.shared.onMutedBySystem = { [weak self] callId, muted in
            self?.muteIfServing(callId, muted: muted)
        }
        CallManager.shared.onProviderReset = { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let callId = self.owner?.callId
            self.lock.unlock()
            guard let callId else { return }
            // Outgoing native calls need cleanup too, even when CallKit has no incoming entry.
            self.endIfServing(callId)
            self.notifyListeners("connectionState", data: ["callId": callId, "state": "closed"])
        }
        Self.deliverPendingHangups()
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            Self.deliverPendingHangups()
        }
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
        DispatchQueue.main.async { self.startOnMain(call) }
    }

    private func startOnMain(_ call: CAPPluginCall) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let callId = call.getString("callId") else {
            call.reject("callId is required")
            return
        }
        let isCaller = call.getBool("isCaller") ?? false
        let wantsVideo = call.getString("callType") == "video"
        let iceServers = Self.parseIceServers(call.getArray("iceServers"))
        let instanceId = call.getString("instanceId")

        lock.lock()
        generation += 1
        let gen = generation
        owner = CallOwner(
            callId: callId,
            instanceId: instanceId,
            endKey: call.getString("endKey"),
            serverUrl: call.getString("serverUrl")
        )
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
            do {
                try CallAudioSession.begin(callId: callId)
            } catch {
                self.endIfServing(callId)
                call.reject("audio session activation failed: \(error.localizedDescription)")
                return
            }

            // Blank the surface, in case the previous call did not end cleanly.
            Task { @MainActor in
                if self.isCurrent(gen) { NativeCallVideo.shared.teardown() }
            }

            guard let built = self.makePeerConnection(iceServers: iceServers) else {
                call.reject("failed to create peer connection")
                return
            }
            let (pc, audio, control) = built
            guard self.adopt(pc, audio: audio, control: control, callId: callId, isCaller: isCaller, generation: gen) else {
                pc.close()
                call.reject("cancelled")
                return
            }
            // A call that never connects (its offer never came) changes no state to watch for.
            DispatchQueue.main.async {
                guard self.callId(owning: pc) == callId else { return }
                self.deadCallCheck?.cancel()
                self.scheduleDeadCallCheck(pc, callId: callId, after: Self.firstConnectDelay)
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
        Task { @MainActor in
            guard self.isCurrent(gen) else {
                call.resolve(["enabled": false])
                return
            }
            track.isEnabled = enabled
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
        let gen = generation
        lock.unlock()

        guard let camera else {
            call.resolve(["facing": "front"])
            return
        }
        Task { @MainActor in
            guard self.isCurrent(gen) else {
                call.reject("call no longer active")
                return
            }
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
        DispatchQueue.main.async {
            self.teardown()
            call.resolve()
        }
    }

    /// Which call the native side still runs, so a page waking from suspension can tell whether
    /// the call it remembers ended while it slept.
    @objc func currentCall(_ call: CAPPluginCall) {
        lock.lock()
        let callId = owner?.callId
        lock.unlock()
        call.resolve(["callId": callId ?? NSNull()])
    }

    /// A call a previous page left running with its media still alive, for the new page to take
    /// over instead of hanging up (the page died under memory pressure, not the call).
    @objc func adoptableCall(_ call: CAPPluginCall) {
        lock.lock()
        let owner = self.owner
        let pc = peerConnection
        let isCaller = self.isCaller
        let micEnabled = self.micEnabled
        let videoEnabled = videoTrack?.isEnabled ?? false
        let volume = remoteGain * 100
        let camera = self.camera
        lock.unlock()
        guard let owner, let pc, pc.connectionState != .failed, pc.connectionState != .closed else {
            call.resolve(["callId": NSNull()])
            return
        }
        let state = Self.name(for: pc.connectionState)
        Task { @MainActor in
            guard self.callId(owning: pc) == owner.callId else {
                call.resolve(["callId": NSNull()])
                return
            }
            var result: [String: Any] = [
                "callId": owner.callId,
                "isCaller": isCaller,
                "state": state,
                "micEnabled": micEnabled,
                "videoEnabled": videoEnabled,
                "facing": camera?.position == .back ? "back" : "front",
                "remoteVideo": NativeCallVideo.shared.hasRemoteTrack,
                "volume": volume,
                "inCallKit": CallManager.shared.holds(callId: owner.callId)
            ]
            if let instanceId = owner.instanceId { result["instanceId"] = instanceId }
            call.resolve(result)
        }
    }

    @objc func setOwner(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId") else {
            call.reject("callId is required")
            return
        }
        let instanceId = call.getString("instanceId")
        let endKey = call.getString("endKey")
        DispatchQueue.main.async {
            self.lock.lock()
            guard self.owner?.callId == callId else {
                self.lock.unlock()
                call.reject("call no longer active")
                return
            }
            if let instanceId { self.owner?.instanceId = instanceId }
            if let endKey { self.owner?.endKey = endKey }
            self.lock.unlock()
            call.resolve()
        }
    }

    /// Called at page load: a reload keeps this plugin, so a call the old page ran is ended here.
    @objc func discardOrphanedCall(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.discardOrphanOnMain(call) }
    }

    private func discardOrphanOnMain(_ call: CAPPluginCall) {
        lock.lock()
        let orphan = owner
        lock.unlock()
        // Unconditionally: this also cancels a start still behind a permission prompt.
        teardown()
        if let orphan { reportHangup(orphan) }
        guard let orphan else {
            call.resolve(["discarded": false])
            return
        }
        DispatchQueue.main.async {
            CallManager.shared.endCall(callId: orphan.callId, reason: "failed")
            var result: [String: Any] = ["discarded": true, "callId": orphan.callId]
            if let instanceId = orphan.instanceId { result["instanceId"] = instanceId }
            call.resolve(result)
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

    private func makePeerConnection(iceServers: [LKRTCIceServer]) -> (LKRTCPeerConnection, LKRTCAudioTrack, LKRTCDataChannel?)? {
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

        // Pre-agreed id on both sides, so it needs no announcing; an older peer never opens it.
        let controlConfig = LKRTCDataChannelConfiguration()
        controlConfig.isNegotiated = true
        controlConfig.channelId = 0
        let control = pc.dataChannel(forLabel: Self.controlLabel, configuration: controlConfig)
        control?.delegate = self
        return (pc, track, control)
    }

    /// Adopts `pc` unless the call ended meanwhile; a previous connection is closed, not dropped.
    private func adopt(
        _ pc: LKRTCPeerConnection,
        audio: LKRTCAudioTrack,
        control: LKRTCDataChannel?,
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
        controlChannel = control
        self.callId = callId
        self.isCaller = isCaller
        makingOffer = false
        negotiationArmed = false
        lock.unlock()
        previous?.close()
        applyMic()
        return true
    }

    private func sendInitialOffer(on pc: LKRTCPeerConnection) {
        lock.lock()
        guard pc === peerConnection else {
            lock.unlock()
            return
        }
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
        if pc !== peerConnection || makingOffer {
            lock.unlock()
            return
        }
        makingOffer = true
        lock.unlock()

        pc.offer(for: Self.mediaConstraints()) { [weak self] offer, error in
            guard let self else { return }
            guard let offer else {
                self.finishOffer(on: pc)
                print("[p2p-native] createOffer: \(error?.localizedDescription ?? "unknown")")
                return
            }
            guard self.callId(owning: pc) != nil else { return }
            pc.setLocalDescription(offer) { error in
                self.finishOffer(on: pc)
                if let error {
                    print("[p2p-native] setLocalDescription(offer): \(error.localizedDescription)")
                    return
                }
                self.emitLocalDescription(from: pc, type: "offer", sdp: offer.sdp)
            }
        }
    }

    private func finishOffer(on pc: LKRTCPeerConnection) {
        lock.lock()
        if pc === peerConnection { makingOffer = false }
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

    private func muteIfServing(_ callId: String, muted: Bool) {
        lock.lock()
        let serving = owner?.callId == callId
        if serving { micEnabled = !muted }
        lock.unlock()
        if serving { applyMic() }
    }

    private func endIfServing(_ callId: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        lock.lock()
        let serving = owner?.callId == callId ? owner : nil
        lock.unlock()
        guard let serving else { return }
        teardown()
        reportHangup(serving)
    }

    /// The page may be suspended, and its hang-up would not reach the server until it wakes:
    /// both users would stay "in a call". This side's key lets the native layer say it directly.
    private func reportHangup(_ owner: CallOwner) {
        guard let key = owner.endKey, let serverUrl = owner.serverUrl else { return }
        let pending = PendingCallHangup(callId: owner.callId, key: key, serverUrl: serverUrl, since: Date())
        // Teardown can remove our background audio entitlement. Keep time for secure storage
        // before deliver() acquires its own background task for the HTTP request.
        var storageTask = UIBackgroundTaskIdentifier.invalid
        let finishStorage = {
            guard storageTask != .invalid else { return }
            UIApplication.shared.endBackgroundTask(storageTask)
            storageTask = .invalid
        }
        storageTask = UIApplication.shared.beginBackgroundTask(withName: "p2p-hangup-storage", expirationHandler: finishStorage)
        Self.hangupStorageQueue.async {
            Self.pendingHangups.remember(pending)
            Self.deliver(pending, attempt: 0)
            DispatchQueue.main.async(execute: finishStorage)
        }
    }

    /// A hang-up the server has not acknowledged yet. Kept on disk: the request often goes out
    /// exactly when there is no network (the connection died), and nothing else frees the call
    /// until the page wakes — which may be hours.
    private static let hangupStorageQueue = DispatchQueue(label: "net.mqvi.hangup-storage")
    private static let pendingHangups = PendingCallHangups()
    private static let hangupRetryDelays: [TimeInterval] = [2, 5]

    /// Retries the call's own hang-up a few times, then leaves it on disk for the next launch.
    private static func deliver(_ hangup: PendingCallHangup, attempt: Int) {
        guard Date().timeIntervalSince(hangup.since) < PendingCallHangup.ttl else {
            hangupStorageQueue.async { pendingHangups.forget(hangup) }
            return
        }
        guard let url = URL(string: "\(hangup.serverUrl)/api/calls/\(hangup.callId)/hangup"),
              let body = try? JSONSerialization.data(withJSONObject: ["key": hangup.key]) // a [String: String] always encodes
        else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        DispatchQueue.main.async {
            // Hanging up lets the app be suspended; ask for the moment the request needs.
            var task = UIBackgroundTaskIdentifier.invalid
            let finish = {
                guard task != .invalid else { return }
                UIApplication.shared.endBackgroundTask(task)
                task = .invalid
            }
            task = UIApplication.shared.beginBackgroundTask(withName: "p2p-hangup", expirationHandler: finish)
            URLSession.shared.dataTask(with: request) { _, response, error in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                // The server answers a call it no longer has the same way, so 2xx means done.
                if (200...299).contains(status) {
                    hangupStorageQueue.async { pendingHangups.forget(hangup) }
                    DispatchQueue.main.async(execute: finish)
                    return
                }
                print("[p2p-native] hang-up not accepted (status \(status)): \(error?.localizedDescription ?? "-")")
                guard attempt < hangupRetryDelays.count else {
                    // Left on disk; retried when the app is opened again.
                    DispatchQueue.main.async(execute: finish)
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + hangupRetryDelays[attempt]) {
                    finish()
                    deliver(hangup, attempt: attempt + 1)
                }
            }.resume()
        }
    }

    /// Hang-ups no network would take when they happened; the app is up now, so try again.
    private static func deliverPendingHangups() {
        hangupStorageQueue.async {
            for hangup in pendingHangups.snapshot() {
                deliver(hangup, attempt: hangupRetryDelays.count) // no backoff loop: the app is awake
            }
        }
    }

    /// In the background the page is suspended, so nothing in JS can recover or end a call whose
    /// connection died (the peer hung up, the network went). If it is still dead after a while,
    /// this side ends it: media off, CallKit told; the page ends it on the server when it wakes.
    private func watchForDeadCall(_ pc: LKRTCPeerConnection, callId: String, state: LKRTCPeerConnectionState) {
        DispatchQueue.main.async {
            guard self.callId(owning: pc) == callId else { return }
            if state == .connected {
                self.deadCallCheck?.cancel()
                self.deadCallCheck = nil
                return
            }
            guard state == .failed || state == .disconnected, self.deadCallCheck == nil else { return }
            self.scheduleDeadCallCheck(pc, callId: callId, after: Self.backgroundDeadCallDelay)
        }
    }

    /// Main queue. In the foreground the page recovers or ends the call itself, but it can be
    /// suspended any moment after, so the check keeps coming back until the connection is up or
    /// the call is gone.
    private func scheduleDeadCallCheck(_ pc: LKRTCPeerConnection, callId: String, after delay: TimeInterval) {
        let check = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.callId(owning: pc) == callId else { return }
            self.deadCallCheck = nil
            guard pc.connectionState != .connected else { return }
            guard UIApplication.shared.applicationState == .background else {
                self.scheduleDeadCallCheck(pc, callId: callId, after: Self.backgroundDeadCallDelay)
                return
            }
            print("[p2p-native] no connection in the background; ending call \(callId)")
            self.lock.lock()
            let owner = self.owner
            self.lock.unlock()
            self.notifyListeners("connectionState", data: ["callId": callId, "state": "closed"])
            self.teardown()
            CallManager.shared.endCall(callId: callId, reason: "failed")
            if let owner { self.reportHangup(owner) }
        }
        deadCallCheck = check
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: check)
    }

    private func teardown() {
        dispatchPrecondition(condition: .onQueue(.main))
        // Generation first, so a start behind a permission prompt builds nothing.
        lock.lock()
        generation += 1
        let gen = generation
        let audioCallId = owner?.callId
        let pc = peerConnection
        let camera = self.camera
        let control = controlChannel
        controlChannel = nil
        peerConnection = nil
        audioTrack = nil
        videoTrack = nil
        videoSource = nil
        remoteAudioTrack = nil
        remoteGain = 1
        micEnabled = true
        self.camera = nil
        callId = nil
        owner = nil
        makingOffer = false
        negotiationArmed = false
        lock.unlock()

        if let audioCallId { CallAudioSession.end(callId: audioCallId) }
        Task { @MainActor in
            camera?.stop()
            guard self.isCurrent(gen) else { return }
            NativeCallVideo.shared.teardown()
            self.deadCallCheck?.cancel()
            self.deadCallCheck = nil
        }
        // Tell the peer directly: the server cannot reach its page if that page is suspended.
        if let control, control.readyState == .open,
           control.sendData(LKRTCDataBuffer(data: Data(Self.bye.utf8), isBinary: false)) {
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.byeFlushDelay) { pc?.close() }
        } else {
            pc?.close()
        }
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
        watchForDeadCall(peerConnection, callId: callId, state: newState)
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
            guard peerConnection === self.peerConnection else {
                lock.unlock()
                return
            }
            remoteAudioTrack = audio
            let gain = remoteGain
            lock.unlock()
            audio.source.volume = gain
            return
        }
        guard let track = rtpReceiver.track as? LKRTCVideoTrack else { return }
        Task { @MainActor in
            guard self.callId(owning: peerConnection) == callId else { return }
            NativeCallVideo.shared.setRemoteTrack(track)
            self.notifyListeners("remoteVideo", data: ["callId": callId, "available": true])
        }
    }

    @objc(peerConnection:didRemoveReceiver:)
    public func peerConnection(
        _ peerConnection: LKRTCPeerConnection,
        didRemove rtpReceiver: LKRTCRtpReceiver
    ) {
        guard let callId = callId(owning: peerConnection),
              rtpReceiver.track is LKRTCVideoTrack else { return }
        Task { @MainActor in
            guard self.callId(owning: peerConnection) == callId else { return }
            NativeCallVideo.shared.setRemoteTrack(nil)
            self.notifyListeners("remoteVideo", data: ["callId": callId, "available": false])
        }
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

// MARK: - LKRTCDataChannelDelegate

extension NativeP2PCallPlugin: LKRTCDataChannelDelegate {
    @objc(dataChannelDidChangeState:)
    public func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {}

    /// The peer hung up. Ended here even while the page is suspended; it learns on waking.
    @objc(dataChannel:didReceiveMessageWithBuffer:)
    public func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        guard !buffer.isBinary, String(data: buffer.data, encoding: .utf8) == Self.bye else { return }
        DispatchQueue.main.async {
            self.lock.lock()
            let callId = self.controlChannel === dataChannel ? self.callId : nil
            self.lock.unlock()
            guard let callId else { return }
            self.notifyListeners("peerHungUp", data: ["callId": callId])
            self.teardown()
            CallManager.shared.endCall(callId: callId, reason: "remoteEnded")
        }
    }
}
