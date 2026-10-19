import SwiftUI

/// Brand tokens shared with the desktop app and the website.
enum Vox {
    static let ink = Color(hex: 0x15150F)
    static let paper = Color(hex: 0xF4F1EA)
    static let panel = Color(hex: 0xFBF9F4)
    static let line = Color(hex: 0xDCD6C8)
    static let accent = Color(hex: 0xFF5A2E)
    static let deck = Color(hex: 0x17170F)
    static let muted = Color(hex: 0x6F6C60)
    static let darkBg = Color(hex: 0x0E0E0A)
    static let darkPanel = Color(hex: 0x17170F)
    static let darkLine = Color(hex: 0x2C2C23)
    static let darkMuted = Color(hex: 0x9C968A)
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }
}

/// The app follows the system unless the user chooses a theme explicitly.
struct ThemeChoice: Equatable {
    var value: String = "system"

    var scheme: ColorScheme? {
        switch value {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}

struct Card<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    var padding: CGFloat = 18
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(scheme == .dark ? Vox.darkPanel : Vox.panel)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(scheme == .dark ? Vox.darkLine : Vox.line, lineWidth: 1)
            )
    }
}

struct Eyebrow: View {
    @Environment(\.colorScheme) private var scheme
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(1.6)
            .foregroundStyle(scheme == .dark ? Vox.darkMuted : Vox.muted)
    }
}

struct Display: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    var size: CGFloat = 32

    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .regular, design: .serif))
            .foregroundStyle(scheme == .dark ? Vox.paper : Vox.ink)
            .lineLimit(2)
            .minimumScaleFactor(0.7)
    }
}

struct Mono: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    var size: CGFloat = 11
    var tint: Color?

    var body: some View {
        Text(text)
            .font(.system(size: size, design: .monospaced))
            .foregroundStyle(tint ?? (scheme == .dark ? Vox.darkMuted : Vox.muted))
            .lineLimit(1)
            .truncationMode(.middle)
    }
}

struct PillButton: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    var selected = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity)
                .background(selected ? (scheme == .dark ? Vox.paper : Vox.ink) : .clear)
                .foregroundStyle(selected ? (scheme == .dark ? Vox.ink : Vox.paper) : (scheme == .dark ? Vox.paper : Vox.ink))
                .clipShape(Capsule())
                .overlay(
                    Capsule().stroke(scheme == .dark ? Vox.darkLine : Vox.line, lineWidth: selected ? 0 : 1)
                )
        }
        .buttonStyle(.plain)
    }
}

struct BigButton: View {
    let title: String
    var accent = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
                .background(accent ? Vox.accent : .clear)
                .foregroundStyle(accent ? .white : Vox.ink)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(accent ? Color.clear : Vox.line, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}

/// Live input meter. 28 bars, centre-weighted, accent on the last few.
struct LevelBars: View {
    @Environment(\.colorScheme) private var scheme
    var level: Float
    var peak: Float
    var muted: Bool

    private let bars = 28

    var body: some View {
        HStack(alignment: .bottom, spacing: 3) {
            ForEach(0..<bars, id: \.self) { index in
                let t = Double(index) / Double(bars - 1)
                let shape = 0.35 + 0.65 * sin(.pi * t)
                let energy = muted ? 0 : min(1, max(0, Double(level) * 3.2 * (0.4 + shape)))
                let active = peak > 0.004 && !muted
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(
                        !active
                            ? (scheme == .dark ? Vox.darkLine : Vox.line)
                            : (index > Int(Double(bars) * 0.86)
                                ? Vox.accent
                                : (scheme == .dark ? Vox.paper : Vox.ink).opacity(0.2 + 0.8 * t))
                    )
                    .frame(height: max(3, energy * 60))
            }
        }
        .frame(height: 64, alignment: .bottom)
        .animation(.linear(duration: 0.08), value: level)
    }
}
