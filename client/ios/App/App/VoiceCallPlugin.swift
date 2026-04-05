import Foundation
import Capacitor

/// Capacitor plugin to manage background voice call state on iOS.
/// Background keep-alive is now handled by @anuradev/capacitor-background-mode plugin.
/// This plugin remains for API parity with Android's foreground service.
@objc(VoiceCallPlugin)
public class VoiceCallPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceCallPlugin"
    public let jsName = "VoiceCallService"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    @objc func start(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        call.resolve()
    }
}
