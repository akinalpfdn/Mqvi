import Foundation
import XCTest
@testable import CallSupport

private final class MemoryHangupStorage: PendingHangupStorage {
    var data: Data?
    var failRead = false
    var failWrite = false
    func read() throws -> Data? {
        if failRead { throw NSError(domain: "test", code: 1) }
        return data
    }
    func write(_ data: Data) throws {
        if failWrite { throw NSError(domain: "test", code: 2) }
        self.data = data
    }
}

final class PendingCallHangupsTests: XCTestCase {
    private var storage: MemoryHangupStorage!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        storage = MemoryHangupStorage()
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
        let store = PendingCallHangups(storage: storage, legacyDefaults: defaults)
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
        XCTAssertEqual(Set(PendingCallHangups(storage: storage, legacyDefaults: defaults).snapshot().map(\.callId)), Set(pending.map(\.callId)))
    }

    func testOldAcknowledgementDoesNotForgetAReplacementRecord() {
        let store = PendingCallHangups(storage: storage, legacyDefaults: defaults)
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
        let store = PendingCallHangups(storage: storage, legacyDefaults: defaults)
        let expired = hangup("expired", since: Date().addingTimeInterval(-PendingCallHangup.ttl - 1))
        store.remember(expired)
        XCTAssertTrue(store.snapshot().isEmpty)
        let current = hangup("current")
        store.remember(current)
        XCTAssertEqual(PendingCallHangups(storage: storage, legacyDefaults: defaults).snapshot(), [current])
    }
    func testMigratesLegacyKeysOnlyAfterSecureWriteAndDoesNotWriteNewKeysToDefaults() throws {
        let legacy = hangup("legacy")
        defaults.set(try JSONEncoder().encode([legacy]), forKey: "mqvi.p2p.pendingHangups")
        let store = PendingCallHangups(storage: storage, legacyDefaults: defaults)
        storage.failWrite = true
        XCTAssertEqual(store.snapshot(), [legacy])
        XCTAssertNotNil(defaults.data(forKey: "mqvi.p2p.pendingHangups"))
        storage.failWrite = false
        XCTAssertEqual(store.snapshot(), [legacy])
        XCTAssertNil(defaults.data(forKey: "mqvi.p2p.pendingHangups"))
        store.remember(hangup("new"))
        XCTAssertNil(defaults.data(forKey: "mqvi.p2p.pendingHangups"))
        XCTAssertEqual(PendingCallHangups(storage: storage, legacyDefaults: defaults).snapshot().count, 2)
    }

    func testReadFailureNeverOverwritesExistingKeysAndKeepsNewKeysForRetry() {
        let old = hangup("old")
        let new = hangup("new")
        PendingCallHangups(storage: storage, legacyDefaults: defaults).remember(old)
        let saved = storage.data
        storage.failRead = true
        let store = PendingCallHangups(storage: storage, legacyDefaults: defaults)
        store.remember(new)
        XCTAssertEqual(storage.data, saved)
        XCTAssertEqual(store.snapshot(), [new])
        XCTAssertNil(defaults.data(forKey: "mqvi.p2p.pendingHangups"))
        storage.failRead = false
        XCTAssertEqual(Set(store.snapshot().map(\.callId)), ["old", "new"])
        XCTAssertEqual(PendingCallHangups(storage: storage, legacyDefaults: defaults).snapshot().count, 2)
    }

    func testAcknowledgementDuringWriteFailureDoesNotResurrectOnRecovery() {
        let store = PendingCallHangups(storage: storage, legacyDefaults: defaults)
        let old = hangup("old")
        let new = hangup("new")
        store.remember(old)
        storage.failWrite = true
        store.remember(new)
        store.forget(old)
        XCTAssertEqual(store.snapshot(), [new])
        storage.failWrite = false
        XCTAssertEqual(store.snapshot(), [new])
        XCTAssertEqual(PendingCallHangups(storage: storage, legacyDefaults: defaults).snapshot(), [new])
    }

}
