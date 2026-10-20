import Foundation
import Combine
import Network
import UIKit

/// Owns the socket, the capture engine and the published state the UI reads.
@MainActor
final class MicSession: ObservableObject {
    @Published var connection: ConnectionState = .idle
    @Published var detail = ""
    @Published var hostName = ""
    @Published var targetHost = ""
    @Published var code = ""
    @Published var stats = SessionStats()
    @Published var muted = false
    @Published var config = StreamConfig()
    @Published var savedHosts: [SavedHost] = []
    @Published var discovered: [SavedHost] = []
    @Published var lastError: String?

    let prefs = Prefs()
    private var socket: URLSessionWebSocketTask?
    private let urlSession = URLSession(configuration: .default)
    private let audio = AudioEngine()
    private var pingTimer: Timer?
    private var lastPingAt = Date()
    private var seq: UInt16 = 0
    private var encoder = AdpcmEncoder()
    private var browser: NetworkBrowser?

    init() {
        savedHosts = prefs.hosts
        targetHost = prefs.lastHost ?? ""
        code = prefs.lastCode ?? ""
        audio.onFrame = { [weak self] frame in
            Task { @MainActor in self?.send(frame: frame) }
        }
        audio.onLevel = { [weak self] rms, peak in
            Task { @MainActor in
                guard let self else { return }
                self.stats.level = rms
                self.stats.peak = max(peak, self.stats.peak * 0.9)
            }
        }
    }

    // MARK: - Discovery

    func startDiscovery() {
        browser?.stop()
        browser = NetworkBrowser { [weak self] hosts in
            Task { @MainActor in
                guard let self else { return }
                self.discovered = hosts
            }
        }
        browser?.start()
    }

    func stopDiscovery() {
        browser?.stop()
        browser = nil
    }

    // MARK: - Connection

    func connect(to host: String) {
        guard let url = URL(string: "ws://\(host):\(Proto.defaultPort)/mic") else {
            detail = "That address does not look like a host or IP."
            return
        }
        disconnect(silently: true)
        targetHost = host
        connection = .connecting
        detail = ""
        let task = urlSession.webSocketTask(with: url)
        task.maximumMessageSize = 1 << 20
        socket = task
        task.resume()
        sendHello()
        receive()
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.ping() }
        }
    }

    func disconnect(silently: Bool = false) {
        pingTimer?.invalidate()
        pingTimer = nil
        audio.stop()
        if let socket {
            socket.send(.string(#"{"t":"bye"}"#)) { _ in }
            socket.cancel(with: .normalClosure, reason: nil)
        }
        socket = nil
        if !silently {
            connection = .closed
            detail = ""
        }
    }

    private func sendHello() {
        let payload: [String: Any] = [
            "t": "hello",
            "v": 1,
            "name": UIDevice.current.name,
            "device": "ios",
            "code": code,
            "token": "",
            "deviceId": prefs.deviceId,
            "app": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.1",
            "caps": ["pcm16", "adpcm", "stats"],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        socket?.send(.string(text)) { [weak self] error in
            if let error {
                Task { @MainActor in
                    self?.connection = .failed
                    self?.detail = error.localizedDescription
                }
            }
        }
    }

    private func receive() {
        socket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    if self.connection != .closed {
                        self.connection = .failed
                        self.detail = error.localizedDescription
                    }
                case .success(let message):
                    self.receive()
                    switch message {
                    case .string(let text): self.handle(text)
                    case .data(let data): self.handleBinary(data)
                    @unknown default: break
                    }
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["t"] as? String else { return }
        switch type {
        case "welcome":
            hostName = json["name"] as? String ?? "PC"
            if let stream = json["stream"] as? [String: Any] {
                config.rate = stream["rate"] as? Int ?? config.rate
                config.codec = stream["codec"] as? String ?? config.codec
                config.frameMs = stream["frame_ms"] as? Int ?? config.frameMs
            }
            startAudio()
            prefs.lastHost = targetHost
            prefs.lastCode = code
            prefs.remember(SavedHost(name: hostName, address: targetHost, port: Proto.defaultPort))
            savedHosts = prefs.hosts
            connection = .connected
            detail = ""
        case "denied":
            let hint = json["hint"] as? String ?? json["reason"] as? String ?? "Pairing rejected."
            detail = hint
            connection = .failed
            disconnect(silently: true)
        case "stats":
            stats.rtt = json["rtt"] as? Int ?? stats.rtt
            stats.jitter = json["jitter"] as? Int ?? stats.jitter
            stats.lost = json["lost"] as? Int ?? stats.lost
            stats.buffer = json["buffer"] as? Int ?? stats.buffer
            stats.bitrate = json["bitrate"] as? Double ?? stats.bitrate
        case "config":
            if let stream = json["stream"] as? [String: Any] {
                config.rate = stream["rate"] as? Int ?? config.rate
                config.codec = stream["codec"] as? String ?? config.codec
                config.frameMs = stream["frame_ms"] as? Int ?? config.frameMs
                if connection == .connected {
                    audio.stop()
                    startAudio()
                }
            }
        case "mute":
            muted = json["on"] as? Bool ?? false
        case "ping":
            let reply: [String: Any] = ["t": "pong", "id": json["id"] ?? 0, "ts": json["ts"] ?? 0]
            if let data = try? JSONSerialization.data(withJSONObject: reply),
               let text = String(data: data, encoding: .utf8) {
                socket?.send(.string(text)) { _ in }
            }
        case "pong":
            stats.rtt = Int(Date().timeIntervalSince(lastPingAt) * 1000)
        case "bye":
            disconnect()
        default:
            break
        }
    }

    private func handleBinary(_ data: Data) {
        // The desktop only sends control JSON today; binary audio would be
        // monitor playback and is intentionally ignored on iOS.
        _ = data.count
    }

    private func startAudio() {
        audio.configure(
            rate: config.rate,
            denoise: prefs.denoise,
            gate: prefs.gate,
            agc: prefs.agc,
            limiter: prefs.limiter,
            gainDb: prefs.inputGainDb
        )
        do {
            try audio.start()
        } catch {
            detail = "Microphone could not start: \(error.localizedDescription)"
            connection = .failed
            lastError = detail
        }
    }

    private func send(frame: [Int16]) {
        guard connection == .connected else { return }
        let payload: Data
        if config.codec == "adpcm" {
            payload = encoder.encode(frame)
        } else {
            var bytes = [UInt8](repeating: 0, count: frame.count * 2)
            for (index, sample) in frame.enumerated() {
                let value = UInt16(bitPattern: sample)
                bytes[index * 2] = UInt8(value & 0xff)
                bytes[index * 2 + 1] = UInt8((value >> 8) & 0xff)
            }
            payload = Data(bytes)
        }
        let codec: UInt8 = config.codec == "adpcm" ? Proto.codecAdpcm : Proto.codecPcm16
        let packet = Proto.packet(codec: codec, seq: seq, payload: muted ? Data(repeating: 0, count: payload.count) : payload)
        seq &+= 1
        stats.packetsSent += 1
        socket?.send(.data(packet)) { _ in }
    }

    private func ping() {
        guard socket != nil else { return }
        lastPingAt = Date()
        let payload: [String: Any] = ["t": "ping", "id": Int.random(in: 1...65535), "ts": Int(Date().timeIntervalSince1970 * 1000)]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let text = String(data: data, encoding: .utf8) {
            socket?.send(.string(text)) { _ in }
        }
        let quality: [String: Any] = ["t": "quality", "rtt": stats.rtt, "loss": 0, "sent": stats.packetsSent]
        if let data = try? JSONSerialization.data(withJSONObject: quality),
           let text = String(data: data, encoding: .utf8) {
            socket?.send(.string(text)) { _ in }
        }
    }

    func toggleMute() {
        muted.toggle()
        let payload: [String: Any] = ["t": "mute", "on": muted]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let text = String(data: data, encoding: .utf8) {
            socket?.send(.string(text)) { _ in }
        }
    }

    func applyGain() {
        audio.setGain(prefs.inputGainDb)
    }

    func forget(_ host: SavedHost) {
        prefs.forget(host.address)
        savedHosts = prefs.hosts
    }
}

/// Listens on UDP 8721 for the desktop's announcement. The desktop broadcasts
/// every two seconds; binding the same port keeps the iPhone in sync with the
/// Android client. Manual addresses remain available when a network filters
/// broadcast traffic.
final class NetworkBrowser {
    private var fd: Int32 = -1
    private let queue = DispatchQueue(label: "app.voxbridge.discovery", qos: .utility)
    private var running = false
    private let onUpdate: ([SavedHost]) -> Void
    private var found: [String: SavedHost] = [:]

    init(onUpdate: @escaping ([SavedHost]) -> Void) {
        self.onUpdate = onUpdate
    }

    func start() {
        guard !running else { return }
        running = true
        queue.async { [weak self] in
            self?.open()
            self?.loop()
        }
    }

    func stop() {
        running = false
        queue.async { [weak self] in
            guard let self else { return }
            if self.fd >= 0 { close(self.fd) }
            self.fd = -1
        }
        found.removeAll()
        onUpdate([])
    }

    private func open() {
        fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { return }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(8721).bigEndian
        address.sin_addr = in_addr(s_addr: INADDR_ANY)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bound != 0 { close(fd); fd = -1 }
    }

    private func loop() {
        var buffer = [UInt8](repeating: 0, count: 2048)
        while running, fd >= 0 {
            var sender = sockaddr_in()
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let count = withUnsafeMutablePointer(to: &sender) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                    recvfrom(fd, &buffer, buffer.count, 0, sockaddrPointer, &length)
                }
            }
            guard count > 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            var raw = sender.sin_addr
            inet_ntop(AF_INET, &raw, &host, socklen_t(INET_ADDRSTRLEN))
            parse(Data(buffer[0..<count]), address: String(cString: host))
        }
    }

    private func parse(_ data: Data, address: String) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["voxbridge"] as? Int == 1,
              let name = json["name"] as? String else { return }
        let port = json["port"] as? Int ?? Proto.defaultPort
        let host = SavedHost(name: name, address: address, port: port)
        found[host.id] = host
        let snapshot = Array(found.values).sorted { $0.name < $1.name }
        DispatchQueue.main.async { self.onUpdate(snapshot) }
    }
}
