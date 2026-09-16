import AVFoundation
import Foundation
import LiveKitWebRTC

/// Who owns the audio session during a native p2p call.
///
/// WebRTC starts and stops its audio unit on its own unless it is told not to. With CallKit
/// in the picture that race is what silences a call: the system activates the session when
/// the user answers, WebRTC activates its own, and the microphone ends up belonging to
/// neither. Manual mode hands the decision to us — the session is enabled once, from whichever
/// side actually owns the call.
///
/// Manual mode is scoped to the call on purpose. The LiveKit SDK that carries channel voice
/// drives the same shared session without these flags, so leaving them set would put channel
/// audio behind a switch nothing flips. `begin` turns it on, `end` hands it straight back.
enum CallAudioSession {
    private static let session = LKRTCAudioSession.sharedInstance()

    /// A native call is starting. Safe to call when CallKit has already activated the session.
    static func begin() {
        session.useManualAudio = true

        if !session.isActive {
            // No CallKit call: this is an outgoing call, or one answered inside the app, so
            // nobody else is going to activate the session.
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

    /// The call is over. Gives the session model back to whatever runs next.
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
