import Foundation
import XCTest
@testable import CallSupport

final class PendingCallHangupsTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        suite = "mqvi.call-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private func hangup(_ id: String, since: Date = Date()) -> PendingCallHangup {
        PendingCallHangup(callId: id, key: "test-key", serverUrl: "https://example.invalid", since: since)
    }

    func testConcurrentNewHangupsAndAcknowledgementsPreserveEveryUnacknowledgedCall() {
        let store = PendingCallHangups(defaults: defaults)
        let acknowledged = (0..<100).map { hangup("old-\($0)") }
        acknowledged.forEach { store.remember($0) }
        let pending = (0..<100).map { hangup("new-\($0)") }

        DispatchQueue.concurrentPerform(iterations: 200) { index in
            if index.isMultiple(of: 2) {
                store.remember(pending[index / 2])
            } else {
                store.forget(acknowledged[index / 2])
            }
        }

        XCTAssertEqual(Set(store.snapshot().map(\.callId)), Set(pending.map(\.callId)))
        // A relaunch must see the same queue, not just an in-memory cache.
        XCTAssertEqual(Set(PendingCallHangups(defaults: defaults).snapshot().map(\.callId)), Set(pending.map(\.callId)))
    }

    func testOldAcknowledgementDoesNotForgetAReplacementRecord() {
        let store = PendingCallHangups(defaults: defaults)
        let old = hangup("call", since: Date().addingTimeInterval(-10))
        let replacement = hangup("call")
        store.remember(old)
        store.remember(replacement)
        store.forget(old)
        XCTAssertEqual(store.snapshot(), [replacement])
        store.forget(replacement)
        XCTAssertTrue(store.snapshot().isEmpty)
    }

    func testExpiredHangupsAreNotRetriedAndArePrunedOnMutation() {
        let store = PendingCallHangups(defaults: defaults)
        let expired = hangup("expired", since: Date().addingTimeInterval(-PendingCallHangup.ttl - 1))
        store.remember(expired)
        XCTAssertTrue(store.snapshot().isEmpty)
        let current = hangup("current")
        store.remember(current)
        XCTAssertEqual(PendingCallHangups(defaults: defaults).snapshot(), [current])
    }
}
