import LiveKit
import ReplayKit

/// Broadcast Upload Extension sample handler.
/// Captures ReplayKit screen frames and forwards them to the main app
/// via App Groups IPC. The main app's LiveKit SDK publishes the frames.
///
/// This is intentionally minimal — LiveKit's LKSampleHandler handles all
/// the heavy lifting (shared memory, Darwin notifications, frame forwarding).
#if os(iOS)
@available(iOS 14.0, *)
class SampleHandler: LKSampleHandler {
    override var enableLogging: Bool { true }
}
#endif
