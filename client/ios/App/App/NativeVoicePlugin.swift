import Foundation
import AVFoundation
import Capacitor
import LiveKit

/// Native voice plugin for iOS — handles LiveKit voice connection natively
/// instead of through WKWebView, so audio continues when app is backgrounded.
///
/// On iOS Capacitor, this replaces the JS SDK LiveKit connection for voice.
/// All other platforms (Electron, web, Android) continue using JS SDK.
@objc(NativeVoicePlugin)
public class NativeVoicePlugin: CAPPlugin, CAPBridgedPlugin, RoomDelegate {
    public let identifier = "NativeVoicePlugin"
    public let jsName = "NativeVoice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMicEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDeafened", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise)
    ]

    private var room: Room?

    // MARK: - Connect / Disconnect

    /// Connect to a LiveKit room natively.
    /// Expects: { url: string, token: string, isMuted: boolean, isDeafened: boolean }
    @objc func connect(_ call: CAPPluginCall) {
        guard let url = call.getString("url"),
              let token = call.getString("token") else {
            call.reject("url and token are required")
            return
        }

        let isMuted = call.getBool("isMuted") ?? false
        let isDeafened = call.getBool("isDeafened") ?? false

        Task { @MainActor in
            do {
                // Disconnect existing room if any
                if let existing = self.room {
                    await existing.disconnect()
                }

                let room = Room(delegate: self)
                self.room = room

                try await room.connect(url: url, token: token)

                // Set initial mic state
                try await room.localParticipant.setMicrophone(enabled: !isMuted)

                // Set initial deafen state
                if isDeafened {
                    self.setAllRemoteAudio(enabled: false)
                }

                call.resolve(["connected": true])
            } catch {
                self.room = nil
                call.reject("Failed to connect: \(error.localizedDescription)")
            }
        }
    }

    /// Disconnect from the LiveKit room.
    @objc func disconnect(_ call: CAPPluginCall) {
        Task { @MainActor in
            if let room = self.room {
                await room.disconnect()
            }
            self.room = nil
            call.resolve(["disconnected": true])
        }
    }

    // MARK: - Mic / Deafen

    /// Enable or disable the microphone.
    /// Expects: { enabled: boolean }
    @objc func setMicEnabled(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("enabled is required")
            return
        }

        Task { @MainActor in
            guard let room = self.room else {
                call.reject("Not connected")
                return
            }
            do {
                try await room.localParticipant.setMicrophone(enabled: enabled)
                call.resolve(["micEnabled": enabled])
            } catch {
                call.reject("Failed to set mic: \(error.localizedDescription)")
            }
        }
    }

    /// Enable or disable all remote audio (deafen).
    /// Expects: { deafened: boolean }
    @objc func setDeafened(_ call: CAPPluginCall) {
        guard let deafened = call.getBool("deafened") else {
            call.reject("deafened is required")
            return
        }

        setAllRemoteAudio(enabled: !deafened)
        call.resolve(["deafened": deafened])
    }

    /// Check if currently connected.
    @objc func isConnected(_ call: CAPPluginCall) {
        let connected = room?.connectionState == .connected
        call.resolve(["connected": connected])
    }

    // MARK: - Private Helpers

    private func setAllRemoteAudio(enabled: Bool) {
        guard let room = self.room else { return }
        Task {
            for (_, participant) in room.remoteParticipants {
                for (_, pub) in participant.trackPublications {
                    if pub.source == .microphone, let remotePub = pub as? RemoteTrackPublication {
                        try? await remotePub.set(subscribed: enabled)
                    }
                }
            }
        }
    }

    // MARK: - RoomDelegate

    public func room(_ room: Room, didDisconnectWithError error: (any Error)?) {
        // Notify JS that native voice disconnected unexpectedly
        self.notifyListeners("nativeVoiceDisconnected", data: [
            "error": error?.localizedDescription ?? ""
        ])
    }
}
