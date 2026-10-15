import AVFoundation
import Foundation
import LiveKitWebRTC

/// SDK adapter. Only CallAudioOwnership's serial executor calls these setters.
private final class WebRTCCallAudioDriver: CallAudioDriver {
    private let session = LKRTCAudioSession.sharedInstance()

    var manualAudio: Bool {
        get { session.useManualAudio }
        set { session.useManualAudio = newValue }
    }
    var audioEnabled: Bool {
        get { session.isAudioEnabled }
        set { session.isAudioEnabled = newValue }
    }

    func activate() throws {
        let config = LKRTCAudioSessionConfiguration.webRTC()
        config.categoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        // Even if already active, acquire our own reference; never borrow CallKit's count.
        try session.setConfiguration(config, active: true)
    }

    func deactivate() {
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        do {
            try session.setActive(false)
        } catch {
            print("[call-audio] deactivate failed: \(error.localizedDescription)")
        }
    }
}

/// CallKit callbacks have no call ID. Keep their SDK accounting intact, then let the current
/// media owner decide whether to wait for CallKit or restore its independently activated audio.
enum CallAudioSession {
    private static let ownership = CallAudioOwnership(driver: WebRTCCallAudioDriver())
    /// Installed/read on main only; a failed restoration ends the matching native call.
    static var onFailure: ((String) -> Void)?

    static func begin(callId: String) throws { try ownership.begin(callId: callId) }
    static func end(callId: String) { ownership.end(callId: callId) }
    static func expectCallKit(callId: String) { ownership.expectCallKit(callId: callId) }

    static func callKitCallEnded(callId: String) {
        if let failed = ownership.callKitCallEnded(callId: callId) { onFailure?(failed) }
    }

    static func callKitDidActivate(_ audioSession: AVAudioSession) {
        ownership.didActivate { LKRTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession) }
    }

    static func callKitDidDeactivate(_ audioSession: AVAudioSession) {
        if let failed = ownership.didDeactivate(notifySDK: {
            LKRTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
        }) {
            onFailure?(failed)
        }
    }
}
