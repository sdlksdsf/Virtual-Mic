import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var session: MicSession
    @AppStorage("theme") private var theme = "system"
    @State private var tab: Tab = .connect

    enum Tab: String, CaseIterable {
        case connect = "Connect"
        case studio = "Studio"
        case settings = "Settings"

        var icon: String {
            switch self {
            case .connect: return "mic"
            case .studio: return "waveform"
            case .settings: return "slider.horizontal.3"
            }
        }
    }

    var body: some View {
        TabView(selection: $tab) {
            ConnectView()
                .tabItem { Label(Tab.connect.rawValue, systemImage: Tab.connect.icon) }
                .tag(Tab.connect)
            StudioView()
                .tabItem { Label(Tab.studio.rawValue, systemImage: Tab.studio.icon) }
                .tag(Tab.studio)
            SettingsView()
                .tabItem { Label(Tab.settings.rawValue, systemImage: Tab.settings.icon) }
                .tag(Tab.settings)
        }
        .tint(Vox.accent)
        .preferredColorScheme(scheme)
    }

    private var scheme: ColorScheme? {
        switch theme {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}

struct ConnectView: View {
    @EnvironmentObject private var session: MicSession
    @Environment(\.colorScheme) private var scheme
    @AppStorage("theme") private var theme = "system"
    @FocusState private var focus: Field?

    enum Field { case host, code }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    statusCard
                    nearby
                    manual
                    footerNote
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 28)
            }
            .background((scheme == .dark ? Vox.darkBg : Vox.paper).ignoresSafeArea())
            .navigationBarHidden(true)
        }
        .onAppear { session.startDiscovery() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                MarkView()
                VStack(alignment: .leading, spacing: 2) {
                    Text("VoxBridge")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                    Mono(text: "phone → PC microphone", size: 10)
                }
                Spacer()
                Button {
                    theme = theme == "dark" ? "light" : "dark"
                } label: {
                    Image(systemName: theme == "dark" ? "sun.max" : "moon")
                        .font(.system(size: 16))
                        .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                        .frame(width: 38, height: 38)
                        .background(scheme == .dark ? Vox.darkPanel : Vox.panel)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(scheme == .dark ? Vox.darkLine : Vox.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 14)

            Eyebrow(text: session.connection == .connected ? "On air" : session.connection == .connecting ? "Connecting" : "Standby")
                .padding(.top, 14)
            Display(text: session.hostName.isEmpty ? "Your PC" : session.hostName, size: 34)
            Text(subtitle)
                .font(.system(size: 13))
                .foregroundStyle(session.connection == .failed ? Vox.accent : (scheme == .dark ? Vox.darkMuted : Vox.muted))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var subtitle: String {
        switch session.connection {
        case .connected:
            return "Every app on your PC hears this iPhone now. Lock the screen and put it in your pocket."
        case .connecting:
            return "Handshaking with the desktop receiver…"
        case .failed:
            return session.detail.isEmpty ? "Could not reach the PC." : session.detail
        default:
            return "Pick the PC you want to send audio to. Wi-Fi and USB tethering both work."
        }
    }

    private var statusCard: some View {
        Card {
            VStack(spacing: 14) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                    Mono(text: statusText, size: 11, tint: session.connection == .connected ? Color(hex: 0x2FA36B) : nil)
                    Spacer()
                    Mono(text: "\(session.config.rate / 1000) kHz · \(session.config.codec == "adpcm" ? "ADPCM" : "PCM")", size: 10)
                }
                LevelBars(level: session.stats.level, peak: session.stats.peak, muted: session.muted)
                HStack {
                    MiniStat(label: "LATENCY", value: session.connection == .connected ? "\(session.stats.rtt) ms" : "—")
                    Spacer()
                    MiniStat(label: "BUFFER", value: session.connection == .connected ? "\(session.stats.buffer) ms" : "—")
                    Spacer()
                    MiniStat(label: "JITTER", value: session.connection == .connected ? "\(session.stats.jitter) ms" : "—")
                    Spacer()
                    MiniStat(label: "SENT", value: session.connection == .connected ? "\(session.stats.packetsSent)" : "—")
                }
                if session.connection == .connected || session.connection == .connecting {
                    HStack(spacing: 10) {
                        BigButton(title: session.muted ? "Unmute" : "Mute", accent: false) {
                            session.toggleMute()
                        }
                        BigButton(title: "Stop") {
                            session.disconnect()
                        }
                    }
                } else {
                    BigButton(title: "Start streaming") {
                        let host = session.targetHost.isEmpty ? session.savedHosts.first?.address ?? "" : session.targetHost
                        if !host.isEmpty { session.connect(to: host) }
                    }
                }
            }
        }
    }

    private var statusColor: Color {
        switch session.connection {
        case .connected: return Color(hex: 0x2FA36B)
        case .connecting: return Vox.accent
        case .failed: return Vox.accent
        default: return scheme == .dark ? Vox.darkLine : Vox.line
        }
    }

    private var statusText: String {
        session.connection.label.uppercased()
    }

    @ViewBuilder
    private var nearby: some View {
        if !session.discovered.isEmpty || !session.savedHosts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Eyebrow(text: "Nearby PCs")
                    Spacer()
                    Button("Rescan") { session.startDiscovery() }
                        .font(.system(size: 12))
                        .foregroundStyle(Vox.accent)
                }
                Card(padding: 6) {
                    VStack(spacing: 0) {
                        ForEach(Array(session.discovered.enumerated()), id: \.element.id) { index, host in
                            HostRow(host: host, tag: "discovered") {
                                session.code = session.code.isEmpty ? "" : session.code
                                session.connect(to: host.address)
                            }
                            if index != session.discovered.count - 1 { Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line) }
                        }
                        ForEach(Array(session.savedHosts.enumerated()), id: \.element.id) { index, host in
                            if !session.discovered.contains(where: { $0.address == host.address }) {
                                HostRow(host: host, tag: "saved") { session.connect(to: host.address) }
                                if index != session.savedHosts.count - 1 { Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line) }
                            }
                        }
                    }
                }
            }
        }
    }

    private var manual: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: "Connect by address")
            Card {
                VStack(spacing: 10) {
                    TextField("192.168.1.20", text: $session.targetHost)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .host)
                        .font(.system(size: 15, design: .monospaced))
                        .padding(12)
                        .background(scheme == .dark ? Vox.darkBg : Vox.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .stroke(scheme == .dark ? Vox.darkLine : Vox.line, lineWidth: 1)
                        )
                    HStack(spacing: 8) {
                        TextField("Code (optional)", text: $session.code)
                            .keyboardType(.numberPad)
                            .focused($focus, equals: .code)
                            .font(.system(size: 15, design: .monospaced))
                            .padding(12)
                            .background(scheme == .dark ? Vox.darkBg : Vox.paper)
                            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                    .stroke(scheme == .dark ? Vox.darkLine : Vox.line, lineWidth: 1)
                            )
                            .onChange(of: session.code) { value in
                                session.code = String(value.filter(\.isNumber).prefix(6))
                            }
                        BigButton(title: "Connect") {
                            focus = nil
                            if !session.targetHost.isEmpty { session.connect(to: session.targetHost) }
                        }
                        .frame(width: 118)
                    }
                    Text("The 4-digit code appears on the desktop the first time an iPhone connects.")
                        .font(.system(size: 11))
                        .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var footerNote: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "wifi")
                .font(.system(size: 12))
                .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
            Text("Discovery is blocked on some Wi-Fi networks. USB tethering or a manual IP always works.")
                .font(.system(size: 11))
                .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
        }
        .padding(.top, 4)
    }
}

struct HostRow: View {
    @Environment(\.colorScheme) private var scheme
    let host: SavedHost
    let tag: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "mic")
                    .font(.system(size: 15))
                    .frame(width: 34, height: 34)
                    .background((scheme == .dark ? Vox.paper : Vox.ink).opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                VStack(alignment: .leading, spacing: 2) {
                    Text(host.name)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                    Mono(text: "\(host.address):\(host.port)", size: 10)
                }
                Spacer()
                Text(tag)
                    .font(.system(size: 10))
                    .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
                Text("→").foregroundStyle(Vox.accent)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}

struct MiniStat: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Mono(text: label, size: 9)
            Text(value)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
        }
    }
}

struct MarkView: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<5, id: \.self) { index in
                Capsule()
                    .fill(index == 2 ? Vox.accent : (scheme == .dark ? Vox.paper : Vox.paper))
                    .frame(width: 2, height: CGFloat(6 + index * 4))
            }
        }
        .frame(width: 34, height: 34)
        .background(scheme == .dark ? Vox.paper.opacity(0.12) : Vox.ink)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
