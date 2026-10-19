import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var session: MicSession
    @Environment(\.colorScheme) private var scheme
    @AppStorage("theme") private var theme = "system"
    @State private var remember = true
    @State private var showLogs = false
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Eyebrow(text: "Settings")
                    Display(text: "The small print.", size: 32)

                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "Appearance")
                        Card {
                            HStack(spacing: 8) {
                                ForEach(["system", "light", "dark"], id: \.self) { option in
                                    PillButton(title: option.capitalized, selected: theme == option) {
                                        theme = option
                                        session.prefs.themeChoice = option
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "Pairing")
                        Card(padding: 4) {
                            VStack(spacing: 0) {
                                ToggleRow(title: "Remember this PC", subtitle: "Skips the pairing code next time.", value: $remember) { value in
                                    session.prefs.rememberDevice = value
                                }
                                Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line)
                                Button {
                                    UIPasteboard.general.string = session.prefs.deviceId
                                    copied = true
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text("This device")
                                                .font(.system(size: 14))
                                                .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                                            Mono(text: String(session.prefs.deviceId.prefix(18)) + "…", size: 10)
                                        }
                                        Spacer()
                                        Text(copied ? "Copied" : "Copy")
                                            .font(.system(size: 12))
                                            .foregroundStyle(Vox.accent)
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 13)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if !session.savedHosts.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Eyebrow(text: "Saved PCs")
                            Card(padding: 4) {
                                VStack(spacing: 0) {
                                    ForEach(Array(session.savedHosts.enumerated()), id: \.element.id) { index, host in
                                        HStack {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(host.name)
                                                    .font(.system(size: 14))
                                                    .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                                                Mono(text: "\(host.address):\(host.port)", size: 10)
                                            }
                                            Spacer()
                                            Button {
                                                session.forget(host)
                                            } label: {
                                                Image(systemName: "xmark")
                                                    .font(.system(size: 12, weight: .medium))
                                                    .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
                                                    .frame(width: 30, height: 30)
                                            }
                                            .buttonStyle(.plain)
                                        }
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 10)
                                        if index != session.savedHosts.count - 1 {
                                            Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "Diagnostics")
                        Card {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Circle()
                                        .fill(session.connection == .connected ? Color(hex: 0x2FA36B) : (scheme == .dark ? Vox.darkLine : Vox.line))
                                        .frame(width: 8, height: 8)
                                    Text(session.connection == .connected ? "Streaming" : "Not streaming")
                                        .font(.system(size: 13))
                                        .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                                    Spacer()
                                    Button(showLogs ? "Hide" : "Show") { showLogs.toggle() }
                                        .font(.system(size: 12))
                                        .foregroundStyle(Vox.accent)
                                }
                                if showLogs {
                                    Text(diagnostics)
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "About")
                        Card(padding: 4) {
                            VStack(spacing: 0) {
                                InfoRow(label: "Version", value: version)
                                Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line)
                                LinkRow(title: "Privacy policy", url: "https://voxbridge.vercel.app/privacy")
                                Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line)
                                LinkRow(title: "Setup guide", url: "https://voxbridge.vercel.app/setup")
                                Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line)
                                LinkRow(title: "Source code", url: "https://github.com/sdlksdsf/Virtual-Mic")
                            }
                        }
                    }

                    Text("VoxBridge \(version) · made for people who sound better than their laptop mic.")
                        .font(.system(size: 11))
                        .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 12)
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 30)
            }
            .background((scheme == .dark ? Vox.darkBg : Vox.paper).ignoresSafeArea())
            .navigationBarHidden(true)
        }
        .onAppear {
            remember = session.prefs.rememberDevice
            theme = session.prefs.themeChoice
        }
    }

    private var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
    }

    private var diagnostics: String {
        """
        state      \(session.connection.rawValue)
        host       \(session.targetHost.isEmpty ? "—" : session.targetHost)
        rate       \(session.config.rate) Hz
        codec      \(session.config.codec)
        frame      \(session.config.frameMs) ms
        rtt        \(session.stats.rtt) ms
        buffer     \(session.stats.buffer) ms
        jitter     \(session.stats.jitter) ms
        packets    \(session.stats.packetsSent)
        device     \(session.prefs.deviceId.prefix(8))…
        """
    }
}

struct InfoRow: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.system(size: 14))
                .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
            Spacer()
            Mono(text: value, size: 12, tint: scheme == .dark ? Vox.paper : Vox.ink)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 13)
    }
}

struct LinkRow: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let url: String

    var body: some View {
        Link(destination: URL(string: url)!) {
            HStack {
                Text(title)
                    .font(.system(size: 14))
                    .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                Spacer()
                Text("↗")
                    .font(.system(size: 14))
                    .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 13)
        }
    }
}
