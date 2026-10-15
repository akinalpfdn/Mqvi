import Foundation

/// Each successful activate must be balanced by our own deactivate, independently of CallKit.
protocol CallAudioDriver: AnyObject {
    var manualAudio: Bool { get set }
    var audioEnabled: Bool { get set }
    func activate() throws
    func deactivate()
}

/// One executor for app ownership, CallKit events and all of this call subsystem's audio writes.
/// CallKit reports a provider-wide session, not a call ID. Always forward those events to the
/// SDK, then reconcile with the current media owner instead of unconditionally muting it.
final class CallAudioOwnership {
    private let queue = DispatchQueue(label: "net.mqvi.call-audio")
    private let driver: CallAudioDriver
    private var owner: String?
    private var ownerUsesCallKit = false
    private var expectedCallKitCall: String?
    private var callKitActive = false
    private var activeCallKitCall: String?
    private var ownsActivation = false

    init(driver: CallAudioDriver) { self.driver = driver }

    func expectCallKit(callId: String) {
        queue.sync { expectedCallKitCall = callId }
    }

    func begin(callId: String) throws {
        try queue.sync {
            if owner == callId { return }
            if owner != nil { endCurrent() }
            owner = callId
            ownerUsesCallKit = expectedCallKitCall == callId
            driver.manualAudio = true
            driver.audioEnabled = false
            if ownerUsesCallKit {
                // An answered incoming call waits for the system activation if not here yet.
                driver.audioEnabled = callKitActive && activeCallKitCall == callId
            } else {
                try acquireActivation()
                driver.audioEnabled = true
            }
        }
    }

    func end(callId: String) {
        queue.sync {
            guard owner == callId else { return }
            endCurrent()
        }
    }

    /// The app can dismiss CallKit while keeping the same media (answered inside the app).
    /// Returns the owner to end if activation failed; never leave an apparently active silent call.
    func callKitCallEnded(callId: String) -> String? {
        queue.sync {
            if expectedCallKitCall == callId { expectedCallKitCall = nil }
            guard owner == callId, ownerUsesCallKit else { return nil }
            ownerUsesCallKit = false
            return restoreAppAudio()
        }
    }

    func didActivate(notifySDK: () -> Void) {
        queue.sync {
            notifySDK()
            callKitActive = true
            activeCallKitCall = expectedCallKitCall
            // A delayed activation after teardown must not re-enable an ownerless microphone.
            if let owner { driver.audioEnabled = !ownerUsesCallKit || activeCallKitCall == owner }
        }
    }

    func didDeactivate(notifySDK: () -> Void) -> String? {
        queue.sync {
            notifySDK()
            callKitActive = false
            activeCallKitCall = nil
            guard owner != nil else { return nil }
            if ownerUsesCallKit {
                driver.audioEnabled = false // interruption of the current system-managed call
                return nil
            }
            // The SDK marks its session inactive even if a new app-owned call already began.
            // Release only our reference, then reacquire it to restore the actual audio session.
            releaseActivation()
            return restoreAppAudio()
        }
    }

    private func acquireActivation() throws {
        guard !ownsActivation else { return }
        try driver.activate()
        ownsActivation = true
    }

    private func releaseActivation() {
        guard ownsActivation else { return }
        ownsActivation = false
        driver.deactivate()
    }

    private func restoreAppAudio() -> String? {
        do {
            try acquireActivation()
            driver.audioEnabled = true
            return nil
        } catch {
            driver.audioEnabled = false
            print("[call-audio] restore failed: \(error.localizedDescription)")
            return owner
        }
    }

    private func endCurrent() {
        driver.audioEnabled = false
        releaseActivation()
        driver.manualAudio = false
        owner = nil
        ownerUsesCallKit = false
    }
}
