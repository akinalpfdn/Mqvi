import Foundation

struct PendingCallHangup: Codable, Equatable {
    let callId: String
    let key: String
    let serverUrl: String
    let since: Date

    /// Past this the server has given the call up on its own.
    static let ttl: TimeInterval = 4 * 60 * 60
}

/// UserDefaults protects individual calls, not a read/filter/append/write transaction.
/// One store owns the queue; every snapshot and mutation holds its lock through encoding.
final class PendingCallHangups: @unchecked Sendable {
    private let lock = NSLock()
    private let defaults: UserDefaults
    private let storageKey = "mqvi.p2p.pendingHangups"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func remember(_ hangup: PendingCallHangup) {
        lock.lock()
        defer { lock.unlock() }
        var kept = read().filter { $0.callId != hangup.callId || $0.serverUrl != hangup.serverUrl }
        kept.append(hangup)
        store(kept)
    }

    func forget(_ hangup: PendingCallHangup) {
        lock.lock()
        defer { lock.unlock() }
        // An old HTTP completion must not remove a newer record for the same call.
        store(read().filter { $0 != hangup })
    }

    func snapshot() -> [PendingCallHangup] {
        lock.lock()
        defer { lock.unlock() }
        return read()
    }

    /// Caller holds lock until any corresponding write completes.
    private func read() -> [PendingCallHangup] {
        guard let data = defaults.data(forKey: storageKey),
              let list = try? JSONDecoder().decode([PendingCallHangup].self, from: data)
        else { return [] }
        return list.filter { Date().timeIntervalSince($0.since) < PendingCallHangup.ttl }
    }

    private func store(_ list: [PendingCallHangup]) {
        guard let data = try? JSONEncoder().encode(list) else { return } // Codable of plain values
        defaults.set(data, forKey: storageKey)
    }
}
