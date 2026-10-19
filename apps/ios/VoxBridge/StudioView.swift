import SwiftUI

struct StudioView: View {
    @EnvironmentObject private var session: MicSession
    @Environment(\.colorScheme) private var scheme
    @State private var denoise = 3
    @State private var gain: Double = 0
    @State private var agc = true
    @State private var gate = true
    @State private var limiter = true
    @State private var rate = 48_000
    @State private var codec = "pcm16"
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Eyebrow(text: "Studio")
                    Display(text: "Sound, tuned.", size: 32)
                    Text("Processing happens on the iPhone before a single byte leaves it. Same presets as the desktop app.")
                        .font(.system(size: 13))
                        .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)

                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "Noise suppression")
                        Card {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack(spacing: 6) {
                                    ForEach(Array(["Off", "Low", "Mid", "High", "Max"].enumerated()), id: \.offset) { index, label in
                                        PillButton(title: label, selected: denoise == index) {
                                            denoise = index
                                            session.prefs.denoise = index
                                        }
                                    }
                                }
                                Text("Spectral subtraction learns the room tone and removes it without hollowing out your voice.")
                                    .font(.system(size: 11))
                                    .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "Input gain")
                        Card {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text("\(Int(gain)) dB")
                                        .font(.system(size: 22, design: .serif))
                                        .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                                    Spacer()
                                    Mono(text: "range −12 … +24", size: 10)
                                }
                                Slider(value: $gain, in: -12...24, step: 1) { editing in
                                    if !editing {
                                        session.prefs.inputGainDb = Int(gain)
                                        session.applyGain()
                                    }
                                }
                                .tint(scheme == .dark ? Vox.paper : Vox.ink)
                                Text("Boost applies after the compressor, so quiet rooms stay quiet and close speech stays clean.")
                                    .font(.system(size: 11))
                                    .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "Dynamics")
                        Card(padding: 4) {
                            VStack(spacing: 0) {
                                ToggleRow(title: "Automatic gain", subtitle: "Holds your voice around −19 dBFS.", value: $agc) { value in
                                    session.prefs.agc = value
                                }
                                Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line)
                                ToggleRow(title: "Noise gate", subtitle: "Closes the mic between phrases.", value: $gate) { value in
                                    session.prefs.gate = value
                                }
                                Divider().overlay(scheme == .dark ? Vox.darkLine : Vox.line)
                                ToggleRow(title: "Safety limiter", subtitle: "Prevents clipping at the desktop end.", value: $limiter) { value in
                                    session.prefs.limiter = value
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "Transport")
                        Card {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack(spacing: 6) {
                                    ForEach([16_000, 24_000, 32_000, 44_100, 48_000], id: \.self) { option in
                                        PillButton(title: option % 1000 == 0 ? "\(option / 1000)k" : String(format: "%.1fk", Double(option) / 1000), selected: rate == option) {
                                            rate = option
                                            session.prefs.rate = option
                                        }
                                    }
                                }
                                HStack(spacing: 8) {
                                    PillButton(title: "PCM16 · clean", selected: codec == "pcm16") {
                                        codec = "pcm16"
                                        session.prefs.codec = codec
                                    }
                                    PillButton(title: "ADPCM · 4× light", selected: codec == "adpcm") {
                                        codec = "adpcm"
                                        session.prefs.codec = codec
                                    }
                                }
                                Text(session.connection == .connected
                                     ? "Transport changes apply the next time you reconnect."
                                     : "Transport changes apply on the next connection.")
                                    .font(.system(size: 11))
                                    .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
                            }
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 30)
            }
            .background((scheme == .dark ? Vox.darkBg : Vox.paper).ignoresSafeArea())
            .navigationBarHidden(true)
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        denoise = session.prefs.denoise
        gain = Double(session.prefs.inputGainDb)
        agc = session.prefs.agc
        gate = session.prefs.gate
        limiter = session.prefs.limiter
        rate = session.prefs.rate
        codec = session.prefs.codec
    }
}

struct ToggleRow: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let subtitle: String
    @Binding var value: Bool
    var onChange: (Bool) -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14))
                    .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
            }
            Spacer()
            Toggle("", isOn: $value)
                .labelsHidden()
                .tint(scheme == .dark ? Vox.paper : Vox.ink)
                .onChange(of: value) { newValue in onChange(newValue) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
    }
}
