import Foundation
import Capacitor

/// Capacitor plugin to manage background voice call state on iOS.
/// iOS background audio is handled by AVAudioSession (configured in AppDelegate),
/// so this plugin is primarily for API parity with Android's foreground service.
@objc(VoiceCallPlugin)
public class VoiceCallPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceCallPlugin"
    public let jsName = "VoiceCallService"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    @objc func start(_ call: CAPPluginCall) {
        // iOS: background audio is managed by AVAudioSession + UIBackgroundModes.
        // No additional setup needed — just resolve for API parity with Android.
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        call.resolve()
    }
}
