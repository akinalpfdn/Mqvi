import AVFoundation
import Foundation
import LiveKitWebRTC

/// Audio session ownership for a native p2p call. Manual mode stops WebRTC and CallKit both
/// activating it; it is scoped to the call because channel voice shares the session without it.
enum CallAudioSession {
    private static let session = LKRTCAudioSession.sharedInstance()

    /// A native call is starting. Safe to call when CallKit has already activated the session.
    static func begin() {
        session.useManualAudio = true

        if !session.isActive {
            // No CallKit call (outgoing, or answered in the app): nobody else will activate it.
            let config = LKRTCAudioSessionConfiguration.webRTC()
            config.categoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
            session.lockForConfiguration()
            do {
                try session.setConfiguration(config, active: true)
            } catch {
                print("[call-audio] activate failed: \(error.localizedDescription)")
            }
            session.unlockForConfiguration()
        }

        session.isAudioEnabled = true
    }

    static func end() {
        session.isAudioEnabled = false
        session.useManualAudio = false

        guard session.isActive else { return }
        session.lockForConfiguration()
        do {
            try session.setActive(false)
        } catch {
            // CallKit deactivates its own session; an error here usually means it already did.
            print("[call-audio] deactivate: \(error.localizedDescription)")
        }
        session.unlockForConfiguration()
    }

    /// CallKit activated the session for an answered call.
    static func callKitDidActivate(_ audioSession: AVAudioSession) {
        session.audioSessionDidActivate(audioSession)
        session.isAudioEnabled = true
    }

    /// CallKit released the session at the end of a call.
    static func callKitDidDeactivate(_ audioSession: AVAudioSession) {
        session.audioSessionDidDeactivate(audioSession)
        session.isAudioEnabled = false
    }
}
