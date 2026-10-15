// swift-tools-version: 5.9
import PackageDescription

// Foundation-only native call logic, tested without an iOS runtime. The app compiles the
// same source directly; no extra runtime dependency is introduced.
let package = Package(
    name: "CallSupport",
    platforms: [.macOS(.v12)],
    targets: [
        .target(name: "CallSupport"),
        .testTarget(name: "CallSupportTests", dependencies: ["CallSupport"])
    ]
)
