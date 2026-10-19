import SwiftUI

@main
struct VoxBridgeApp: App {
    @StateObject private var session = MicSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(session)
                .preferredColorScheme(nil)
                .onOpenURL { url in
                    guard url.scheme == "voxbridge", url.host == "pair" else { return }
                    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                    let host = items.first { $0.name == "host" }?.value
                    let code = items.first { $0.name == "code" }?.value
                    if let host {
                        session.code = code ?? ""
                        session.connect(to: host)
                    }
                }
        }
    }
}
