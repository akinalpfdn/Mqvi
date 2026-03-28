import UIKit
import Capacitor

class MqviViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceCallPlugin())
        bridge?.registerPluginInstance(ScreenSharePlugin())
    }
}
