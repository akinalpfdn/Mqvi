import Foundation
import Capacitor
import LiveKit
import ReplayKit

/// Capacitor plugin for iOS native screen share via ReplayKit + LiveKit Swift SDK.
///
/// Flow:
/// 1. JS calls start({url, token}) — plugin connects to LiveKit room natively
/// 2. Plugin enables screen share which triggers RPSystemBroadcastPickerView
/// 3. Broadcast extension captures frames → forwards to main app via App Groups
/// 4. LiveKit Swift SDK publishes screen share track to the room
/// 5. JS calls stop() — plugin disables screen share and disconnects
@objc(ScreenSharePlugin)
public class ScreenSharePlugin: CAPPlugin, CAPBridgedPlugin, RoomDelegate {
    public let identifier = "ScreenSharePlugin"
    public let jsName = "ScreenShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isActive", returnType: CAPPluginReturnPromise)
    ]

    private var room: Room?
    private var isScreenSharing = false

    /// Start screen share: connect to LiveKit room and enable screen share track.
    /// Expects: { url: string, token: string }
    @objc func start(_ call: CAPPluginCall) {
        guard let url = call.getString("url"),
              let token = call.getString("token") else {
            call.reject("url and token are required")
            return
        }

        Task { @MainActor in
            do {
                let room = Room(delegate: self)
                self.room = room

                // Configure for screen share — broadcast capture mode (ReplayKit extension)
                let roomOptions = RoomOptions(
                    defaultScreenShareCaptureOptions: ScreenShareCaptureOptions(
                        appAudio: true,
                        useBroadcastExtension: true
                    )
                )

                try await room.connect(url: url, token: token, roomOptions: roomOptions)

                // Enable screen share — this triggers the system broadcast picker
                try await room.localParticipant.setScreenShare(enabled: true)
                self.isScreenSharing = true

                call.resolve(["started": true])
            } catch {
                self.cleanup()
                call.reject("Failed to start screen share: \(error.localizedDescription)")
            }
        }
    }

    /// Stop screen share and disconnect from the LiveKit room.
    @objc func stop(_ call: CAPPluginCall) {
        Task { @MainActor in
            await stopScreenShare()
            call.resolve(["stopped": true])
        }
    }

    /// Check if screen share is currently active.
    @objc func isActive(_ call: CAPPluginCall) {
        call.resolve(["active": isScreenSharing])
    }

    // RoomDelegate — detect when screen share track is unpublished (e.g., user stops from Control Center)
    public func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        if publication.source == .screenShareVideo {
            Task { @MainActor in
                await self.stopScreenShare()
                self.notifyListeners("screenShareStopped", data: [:])
            }
        }
    }

    private func stopScreenShare() async {
        guard let room = self.room else { return }

        do {
            try await room.localParticipant.setScreenShare(enabled: false)
        } catch {
            print("[ScreenSharePlugin] Error disabling screen share: \(error)")
        }

        await room.disconnect()
        cleanup()
    }

    private func cleanup() {
        room = nil
        isScreenSharing = false
    }
}
