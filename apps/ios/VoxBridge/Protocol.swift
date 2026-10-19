import Foundation
import os

/// Wire constants from docs/PROTOCOL.md. Keep these in sync with the desktop
/// receiver and the Android client.
enum Proto {
    static let magic: UInt8 = 0x56
    static let version: UInt8 = 1
    static let headerBytes = 12
    static let codecPcm16: UInt8 = 0
    static let codecAdpcm: UInt8 = 1
    static let defaultPort = 8720
    static let defaultCodec = "pcm16"
    static let defaultFrameMs = 20
    static let maxPayload = 1400

    /// 12-byte little-endian header followed by the codec payload.
    static func packet(codec: UInt8, seq: UInt16, payload: Data, flags: UInt8 = 0) -> Data {
        var out = Data(capacity: headerBytes + payload.count)
        out.append(magic)
        out.append(version)
        out.append(codec)
        out.append(flags)
        let seqValue = seq.littleEndian
        withUnsafeBytes(of: seqValue) { out.append(contentsOf: $0) }
        var ts = UInt32(truncatingIfNeeded: Int(Date().timeIntervalSince1970 * 1000))
        ts = ts.littleEndian
        withUnsafeBytes(of: ts) { out.append(contentsOf: $0) }
        var len = UInt16(payload.count).littleEndian
        withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }
}

struct StreamConfig: Equatable {
    var rate = 48_000
    var codec = Proto.defaultCodec
    var frameMs = Proto.defaultFrameMs

    var frameSamples: Int { max(1, rate * frameMs / 1000) }
}

enum ConnectionState: String {
    case idle, connecting, connected, failed, closed

    var label: String {
        switch self {
        case .idle: return "Standby"
        case .connecting: return "Connecting"
        case .connected: return "Live"
        case .failed: return "Offline"
        case .closed: return "Stopped"
        }
    }
}

struct SessionStats {
    var rtt = 0
    var jitter = 0
    var lost = 0
    var buffer = 0
    var bitrate = 0.0
    var level: Float = 0
    var peak: Float = 0
    var packetsSent: UInt64 = 0
}

struct SavedHost: Codable, Identifiable, Equatable {
    var id: String { "\(address):\(port)" }
    var name: String
    var address: String
    var port: Int = Proto.defaultPort
    var lastSeen: TimeInterval = Date().timeIntervalSince1970
}

/// Settings that survive launches. Mirrors the keys used on Android.
final class Prefs {
    private let defaults = UserDefaults.standard

    var themeChoice: String {
        get { defaults.string(forKey: "theme") ?? "system" }
        set { defaults.set(newValue, forKey: "theme") }
    }
    var lastHost: String? {
        get { defaults.string(forKey: "last_host") }
        set { defaults.set(newValue, forKey: "last_host") }
    }
    var lastCode: String? {
        get { defaults.string(forKey: "last_code") }
        set { defaults.set(newValue, forKey: "last_code") }
    }
    var rememberDevice: Bool {
        get { defaults.object(forKey: "remember") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "remember") }
    }
    var deviceId: String {
        if let value = defaults.string(forKey: "device_id") { return value }
        let value = UUID().uuidString
        defaults.set(value, forKey: "device_id")
        return value
    }
    var rate: Int {
        get { defaults.object(forKey: "rate") as? Int ?? 48_000 }
        set { defaults.set(newValue, forKey: "rate") }
    }
    var codec: String {
        get { defaults.string(forKey: "codec") ?? Proto.defaultCodec }
        set { defaults.set(newValue, forKey: "codec") }
    }
    var denoise: Int {
        get { defaults.object(forKey: "denoise") as? Int ?? 3 }
        set { defaults.set(newValue, forKey: "denoise") }
    }
    var agc: Bool {
        get { defaults.object(forKey: "agc") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "agc") }
    }
    var gate: Bool {
        get { defaults.object(forKey: "gate") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "gate") }
    }
    var limiter: Bool {
        get { defaults.object(forKey: "limiter") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "limiter") }
    }
    var inputGainDb: Int {
        get { defaults.object(forKey: "input_gain") as? Int ?? 0 }
        set { defaults.set(newValue, forKey: "input_gain") }
    }

    var hosts: [SavedHost] {
        get {
            guard let data = defaults.data(forKey: "saved_hosts"),
                  let list = try? JSONDecoder().decode([SavedHost].self, from: data) else { return [] }
            return list.sorted { $0.lastSeen > $1.lastSeen }
        }
        set {
            let list = Array(newValue.sorted { $0.lastSeen > $1.lastSeen }.prefix(6))
            if let data = try? JSONEncoder().encode(list) { defaults.set(data, forKey: "saved_hosts") }
        }
    }

    func remember(_ host: SavedHost) {
        var list = hosts.filter { $0.address != host.address || $0.port != host.port }
        list.insert(host, at: 0)
        hosts = list
    }

    func forget(_ address: String) {
        hosts = hosts.filter { $0.address != address }
    }
}

let voxLog = Logger(subsystem: "app.voxbridge.mic", category: "session")
