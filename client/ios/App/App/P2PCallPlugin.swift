import Foundation
import Capacitor

/// JS bridge for VoIP/CallKit. CallManager (started in AppDelegate) owns PushKit +
/// CallKit; this plugin forwards its events to JS and exposes the VoIP token + a way
/// to dismiss the CallKit UI from the app.
///
/// Events use retainUntilConsumed so a cold-launch token/answer that fires before the
/// JS listener attaches is still delivered.
@objc(P2PCallPlugin)
public class P2PCallPlugin: CAPPlugin, CAPBridgedPlugin, CallManagerListener {
    public let identifier = "P2PCallPlugin"
    public let jsName = "P2PCall"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getVoipToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markAnswered", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        CallManager.shared.listener = self
    }

    /// Returns the current VoIP token (JS calls this on mount in case the token event
    /// fired before the listener was added).
    @objc func getVoipToken(_ call: CAPPluginCall) {
        call.resolve(["token": CallManager.shared.currentVoipToken() ?? ""])
    }

    /// Dismiss the CallKit call when the call ends/declines in the app.
    @objc func endCall(_ call: CAPPluginCall) {
        guard let callId = call.getString("call_id") else {
            call.reject("call_id is required")
            return
        }
        CallManager.shared.endCall(callId: callId)
        call.resolve()
    }

    /// Answered in-app: shield the call from the accept-time cancel push, which the server
    /// sends to every device of the receiver — including this one.
    @objc func markAnswered(_ call: CAPPluginCall) {
        guard let callId = call.getString("call_id") else {
            call.reject("call_id is required")
            return
        }
        CallManager.shared.markAnswered(callId: callId)
        call.resolve()
    }

    // MARK: - CallManagerListener

    func onVoipToken(_ token: String) {
        notifyListeners("voipToken", data: ["token": token], retainUntilConsumed: true)
    }

    func onCallAnswered(callId: String) {
        notifyListeners("callAnswered", data: ["call_id": callId], retainUntilConsumed: true)
    }

    func onCallEnded(callId: String) {
        notifyListeners("callEnded", data: ["call_id": callId], retainUntilConsumed: true)
    }
}
