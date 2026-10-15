import Foundation
import Security

struct PendingCallHangup: Codable, Equatable {
    let callId: String
    let key: String
    let serverUrl: String
    let since: Date

    /// Past this the server has given the call up on its own.
    static let ttl: TimeInterval = 4 * 60 * 60
}

protocol PendingHangupStorage {
    func read() throws -> Data?
    func write(_ data: Data) throws
}

/// Available for locked-screen retries after first unlock, never synchronized to other devices.
struct KeychainHangupStorage: PendingHangupStorage {
    private let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "net.mqvi.p2p.pendingHangups",
        kSecAttrAccount as String: "queue",
        kSecAttrSynchronizable as String: false,
    ]

    private struct Failure: Error { let status: OSStatus }

    func read() throws -> Data? {
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure(status: status) }
        guard let data = result as? Data else { throw Failure(status: errSecDecode) }
        return data
    }

    func write(_ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure(status: status) }
    }
}

/// One store owns the queue; its lock covers migration, read/modify/write and acknowledgements.
/// Failed secure writes stay in memory for retries, never fall back to plaintext preferences.
final class PendingCallHangups: @unchecked Sendable {
    private enum Change {
        case remember(PendingCallHangup)
        case forget(PendingCallHangup)
    }
    private let lock = NSLock()
    private let storage: PendingHangupStorage
    private let legacyDefaults: UserDefaults
    private let legacyKey = "mqvi.p2p.pendingHangups"
    private var changes: [Change] = []
    private var cached: [PendingCallHangup] = []

    init(storage: PendingHangupStorage = KeychainHangupStorage(), legacyDefaults: UserDefaults = .standard) {
        self.storage = storage
        self.legacyDefaults = legacyDefaults
    }

    func remember(_ hangup: PendingCallHangup) {
        lock.lock()
        defer { lock.unlock() }
        changes.append(.remember(hangup))
        _ = settle()
    }

    func forget(_ hangup: PendingCallHangup) {
        lock.lock()
        defer { lock.unlock() }
        changes.append(.forget(hangup))
        _ = settle()
    }

    func snapshot() -> [PendingCallHangup] {
        lock.lock()
        defer { lock.unlock() }
        return settle()
    }

    private func merged(_ saved: [PendingCallHangup], legacy: [PendingCallHangup]) -> [PendingCallHangup] {
        var list = saved
        for entry in legacy {
            if let index = list.firstIndex(where: { $0.callId == entry.callId && $0.serverUrl == entry.serverUrl }) {
                if list[index].since < entry.since { list[index] = entry }
            } else {
                list.append(entry)
            }
        }
        for change in changes {
            switch change {
            case .remember(let entry):
                list.removeAll { $0.callId == entry.callId && $0.serverUrl == entry.serverUrl }
                list.append(entry)
            case .forget(let entry):
                // An old HTTP completion must not remove a replacement record for the same call.
                list.removeAll { $0 == entry }
            }
        }
        return list.filter { Date().timeIntervalSince($0.since) < PendingCallHangup.ttl }
    }

    /// Caller holds lock. A failed read must never be interpreted as an empty Keychain queue.
    private func settle() -> [PendingCallHangup] {
        let legacyData = legacyDefaults.data(forKey: legacyKey)
        let legacy = legacyData.flatMap { try? JSONDecoder().decode([PendingCallHangup].self, from: $0) } ?? []
        do {
            let data = try storage.read()
            let saved = try data.map { try JSONDecoder().decode([PendingCallHangup].self, from: $0) } ?? []
            cached = saved
            let next = merged(saved, legacy: legacy)
            if next != saved || !changes.isEmpty || legacyData != nil {
                try storage.write(JSONEncoder().encode(next))
            }
            cached = next
            changes.removeAll()
            // Only remove the old copy after the secure copy has been committed successfully.
            if legacyData != nil { legacyDefaults.removeObject(forKey: legacyKey) }
            return next
        } catch {
            // No credential data, URLs or decoder descriptions in logs.
            print("[p2p-native] secure hang-up storage unavailable; retrying in memory")
            return merged(cached, legacy: legacy)
        }
    }
}
