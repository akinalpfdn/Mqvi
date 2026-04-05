import UIKit
import WebKit
import AVFoundation
import Capacitor

class MqviViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceCallPlugin())
        bridge?.registerPluginInstance(ScreenSharePlugin())
        bridge?.registerPluginInstance(NativeVoicePlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        if let webView = self.webView {
            webView.configuration.mediaTypesRequiringUserActionForPlayback = []

            if #available(iOS 16.4, *) {
                webView.isInspectable = true
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    @objc private func appDidEnterBackground() {
        // Keep audio session active
        do {
            try AVAudioSession.sharedInstance().setActive(true, options: [])
        } catch {
            print("[MqviViewController] Failed to keep audio session active: \(error)")
        }

        // iOS 15+: Tell WKWebView NOT to suspend media playback.
        // This is the key API — without it, WebRTC audio freezes when backgrounded.
        if #available(iOS 15.0, *) {
            webView?.setAllMediaPlaybackSuspended(false, completionHandler: nil)
        }
    }

    @objc private func appWillEnterForeground() {
        do {
            try AVAudioSession.sharedInstance().setActive(true, options: [])
        } catch {
            print("[MqviViewController] Failed to reactivate audio session: \(error)")
        }

        // Resume media in case it was partially suspended
        if #available(iOS 15.0, *) {
            webView?.setAllMediaPlaybackSuspended(false, completionHandler: nil)
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
