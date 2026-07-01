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
}

final class CallManager: NSObject {
    static let shared = CallManager()

    weak var listener: CallManagerListener? {
        didSet { flushBuffer() }
    }

    private var voipRegistry: PKPushRegistry?
    private let provider: CXProvider
    private var calls: [UUID: String] = [:] // CallKit UUID -> our call_id

    private var bufferedToken: String?
    private var bufferedAnswered: [String] = []
    private var bufferedEnded: [String] = []

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// Register for VoIP pushes. Call from AppDelegate.didFinishLaunching.
    func start() {
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
    }

    func currentVoipToken() -> String? { bufferedToken }

    /// Dismiss the CallKit call from the app side (call ended / declined in-app, or
    /// the server ring timed out).
    func endCall(callId: String) {
        guard let uuid = UUID(uuidString: callId) else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        calls.removeValue(forKey: uuid)
    }

    private func reportIncomingCall(callId: String, callerName: String, hasVideo: Bool, completion: @escaping () -> Void) {
        let uuid = UUID(uuidString: callId) ?? UUID()
        calls[uuid] = callId
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = hasVideo
        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            if let error = error {
                print("[callkit] reportNewIncomingCall failed: \(error.localizedDescription)")
            }
            completion()
        }
    }

    private func flushBuffer() {
        guard let listener = listener else { return }
        if let token = bufferedToken { listener.onVoipToken(token) }
        bufferedAnswered.forEach { listener.onCallAnswered(callId: $0) }
        bufferedEnded.forEach { listener.onCallEnded(callId: $0) }
        bufferedAnswered.removeAll()
        bufferedEnded.removeAll()
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

    /// Handle a "cancel" VoIP push. iOS still requires every VoIP push to report a call
    /// to CallKit, so if this call was never reported in the current process (the app was
    /// killed between the incoming and cancel pushes), report it and immediately end it;
    /// otherwise just end the already-ringing CallKit call.
    private func cancelIncomingCall(callId: String, completion: @escaping () -> Void) {
        let uuid = UUID(uuidString: callId) ?? UUID()
        if calls[uuid] != nil {
            provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
            calls.removeValue(forKey: uuid)
            completion()
            return
        }
        calls[uuid] = callId
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: "")
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
            self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
            self?.calls.removeValue(forKey: uuid)
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
        if let callId = calls[action.callUUID] {
            if let listener = listener {
                listener.onCallEnded(callId: callId)
            } else {
                bufferedEnded.append(callId)
            }
            calls.removeValue(forKey: action.callUUID)
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // WebRTC/LiveKit uses the activated session for call audio.
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}
