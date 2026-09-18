import Foundation
import PushKit
import CallKit
import AVFoundation

/// Bridges PushKit VoIP pushes + CallKit to the JS layer. Owned as a singleton and
/// started from AppDelegate.didFinishLaunching so the VoIP delegate is ready for a
/// cold-launch incoming-call push (iOS terminates the app if a VoIP push isn't
/// reported to CallKit before the push handler returns).
///
/// Events (voip token, call answered, call ended) are buffered until the Capacitor
/// plugin attaches as the listener — on a cold launch the push/token arrive before
/// the WebView and JS load.
protocol CallManagerListener: AnyObject {
    func onVoipToken(_ token: String)
    func onCallAnswered(callId: String)
    func onCallEnded(callId: String)
    /// The system call screen's mute button was toggled.
    func onCallMuted(callId: String, muted: Bool)
    /// CallKit accepted the incoming call and is ringing it. The app must not ring on top.
    func onCallReported(callId: String)
}

final class CallManager: NSObject {
    static let shared = CallManager()

    weak var listener: CallManagerListener? {
        didSet { flushBuffer() }
    }

    private var voipRegistry: PKPushRegistry?
    private let provider: CXProvider
    private let callController = CXCallController()
    private var calls: [UUID: String] = [:] // CallKit UUID -> our call_id
    /// Mute as CallKit shows it, so the app echoing a CallKit toggle does not send it back.
    private var mutedState: [UUID: Bool] = [:]
    /// Mute actions the app requested. Their perform is our own echo, and a stale one would
    /// briefly undo a newer toggle if it reached the app.
    private var ownMuteActions: Set<UUID> = []
    /// Calls the app asked CallKit to end, so the end action's echo is not reported back as the user's.
    private var endingInApp: Set<UUID> = []

    private var bufferedToken: String?
    private var bufferedAnswered: [String] = []
    private var bufferedEnded: [String] = []
    private var bufferedMuted: [(String, Bool)] = []
    private var bufferedReported: [String] = []

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// Category and mode only: for a CallKit call the system activates the session (didActivate).
    private func configureAudioSessionForCall() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
            )
            try session.setPreferredIOBufferDuration(0.005)
        } catch {
            print("[callkit] audio session configuration failed: \(error.localizedDescription)")
        }
    }

    /// Register for VoIP pushes. Call from AppDelegate.didFinishLaunching.
    func start() {
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
    }

    func currentVoipToken() -> String? { bufferedToken }

    /// Dismiss the CallKit call from the app side. "local" is this user hanging up or declining
    /// in the app, which the call history records as theirs; anything else is reported with its reason.
    func endCall(callId: String, reason: String) {
        guard let uuid = UUID(uuidString: callId) else { return }
        guard reason == "local" else {
            report(uuid, endedWith: Self.endedReason(reason))
            return
        }
        // Already gone from CallKit (the user ended it there): nothing left to end.
        guard calls[uuid] != nil else { return }
        endingInApp.insert(uuid)
        callController.request(CXTransaction(action: CXEndCallAction(call: uuid))) { [weak self] error in
            guard let self, let error else { return }
            print("[callkit] end call failed: \(error.localizedDescription)")
            self.endingInApp.remove(uuid)
            self.report(uuid, endedWith: .remoteEnded)
        }
    }

    private func report(_ uuid: UUID, endedWith reason: CXCallEndedReason) {
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
        calls.removeValue(forKey: uuid)
        mutedState.removeValue(forKey: uuid)
    }

    private static func endedReason(_ reason: String) -> CXCallEndedReason {
        switch reason {
        case "unanswered": return .unanswered
        case "answeredElsewhere": return .answeredElsewhere
        case "declinedElsewhere": return .declinedElsewhere
        case "failed": return .failed
        default: return .remoteEnded
        }
    }

    /// Mirrors an in-app mute onto a call CallKit is showing.
    func setMuted(callId: String, muted: Bool) {
        guard let uuid = UUID(uuidString: callId), calls[uuid] != nil else { return }
        guard mutedState[uuid, default: false] != muted else { return }
        mutedState[uuid] = muted
        let action = CXSetMutedCallAction(call: uuid, muted: muted)
        ownMuteActions.insert(action.uuid)
        callController.request(CXTransaction(action: action)) { [weak self] error in
            if let error {
                self?.ownMuteActions.remove(action.uuid)
                print("[callkit] set muted failed: \(error.localizedDescription)")
            }
        }
    }

    private func reportIncomingCall(callId: String, callerName: String, hasVideo: Bool, completion: @escaping () -> Void) {
        let uuid = UUID(uuidString: callId) ?? UUID()
        calls[uuid] = callId
        configureAudioSessionForCall()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = hasVideo
        // Holding is not implemented: an unhandled hold action times out and CallKit may end the
        // call, so the button must not be offered at all.
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error = error {
                print("[callkit] reportNewIncomingCall failed: \(error.localizedDescription)")
            } else {
                self?.notifyReported(callId: callId)
            }
            completion()
        }
    }

    private func notifyReported(callId: String) {
        if let listener = listener {
            listener.onCallReported(callId: callId)
        } else {
            bufferedReported.append(callId)
        }
    }

    private func flushBuffer() {
        guard let listener = listener else { return }
        if let token = bufferedToken { listener.onVoipToken(token) }
        bufferedAnswered.forEach { listener.onCallAnswered(callId: $0) }
        bufferedEnded.forEach { listener.onCallEnded(callId: $0) }
        bufferedMuted.forEach { listener.onCallMuted(callId: $0.0, muted: $0.1) }
        bufferedReported.forEach { listener.onCallReported(callId: $0) }
        bufferedReported.removeAll()
        bufferedAnswered.removeAll()
        bufferedEnded.removeAll()
        bufferedMuted.removeAll()
    }
}

extension CallManager: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        bufferedToken = token
        listener?.onVoipToken(token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let dict = payload.dictionaryPayload
        let callId = dict["call_id"] as? String ?? UUID().uuidString

        // A "cancel" push: the call was hung up / declined / timed out before it was
        // answered — dismiss the CallKit UI instead of ringing.
        let isCancel = (dict["cancel"] as? Bool == true) || ((dict["cancel"] as? NSNumber)?.boolValue == true)
        if isCancel {
            cancelIncomingCall(callId: callId, completion: completion)
            return
        }

        let callerName = dict["caller_name"] as? String ?? "Incoming call"
        let hasVideo = (dict["call_type"] as? String) == "video"
        // iOS 13+: must report to CallKit before completion() returns, or the app is
        // terminated and future VoIP pushes are throttled.
        reportIncomingCall(callId: callId, callerName: callerName, hasVideo: hasVideo, completion: completion)
    }

    /// Handle a "cancel" VoIP push: the call was answered, declined, or timed out elsewhere.
    ///
    /// The server never sends this to the device that acted, so it can never arrive for a call
    /// this device is in. That matters, because every branch here MUST end with CallKit having
    /// been told about the call: since iOS 13 a VoIP push whose handler completes without a
    /// reportNewIncomingCall gets the app killed and its VoIP delivery revoked. If the call was
    /// never reported in this process (the app was killed between the two pushes), report it and
    /// end it immediately.
    private func cancelIncomingCall(callId: String, completion: @escaping () -> Void) {
        let uuid = UUID(uuidString: callId) ?? UUID()
        if calls[uuid] != nil {
            provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
            calls.removeValue(forKey: uuid)
            mutedState.removeValue(forKey: uuid)
            completion()
            return
        }
        calls[uuid] = callId
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: "")
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
            self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
            self?.calls.removeValue(forKey: uuid)
            self?.mutedState.removeValue(forKey: uuid)
            completion()
        }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        bufferedToken = nil
    }
}

extension CallManager: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        calls.removeAll()
        mutedState.removeAll()
        endingInApp.removeAll()
        ownMuteActions.removeAll()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        if let callId = calls[action.callUUID] {
            if let listener = listener {
                listener.onCallAnswered(callId: callId)
            } else {
                bufferedAnswered.append(callId)
            }
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if endingInApp.remove(action.callUUID) != nil {
            calls.removeValue(forKey: action.callUUID)
            mutedState.removeValue(forKey: action.callUUID)
        } else if let callId = calls[action.callUUID] {
            if let listener = listener {
                listener.onCallEnded(callId: callId)
            } else {
                bufferedEnded.append(callId)
            }
            calls.removeValue(forKey: action.callUUID)
            mutedState.removeValue(forKey: action.callUUID)
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        if ownMuteActions.remove(action.uuid) != nil {
            action.fulfill()
            return
        }
        mutedState[action.callUUID] = action.isMuted
        if let callId = calls[action.callUUID] {
            if let listener = listener {
                listener.onCallMuted(callId: callId, muted: action.isMuted)
            } else {
                bufferedMuted.append((callId, action.isMuted))
            }
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        CallAudioSession.callKitDidActivate(audioSession)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        CallAudioSession.callKitDidDeactivate(audioSession)
    }
}
