//! Link settings that must hold however cargo is invoked. `.cargo/config.toml` applies only when
//! cargo runs from this directory, and CI builds through `--manifest-path`.

/// Cargo applies a dependency's `rustc-link-arg` to that dependency's own targets only, never to
/// ours. So the link args our macOS dependencies print for their consumers are repeated here. The
/// full list, from their build scripts: `-ObjC` (webrtc-sys, livekit) and the Swift rpath
/// (screencapturekit, apple-cf, apple-metal). Their extra Xcode-toolchain rpath is a dev-machine
/// fallback for old systems and does not exist on a user's Mac, so it is left out.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // libwebrtc's Objective-C SDK adds methods through categories, which the linker drops from
        // a static library unless told to keep them. Without it the first peer connection dies
        // with "+[NSString stringForAbslStringView:]: unrecognized selector".
        println!("cargo:rustc-link-arg=-ObjC");
        // The ScreenCaptureKit bridge is Swift and finds the Swift runtime by @rpath; macOS ships it
        // in /usr/lib/swift. Without it every binary aborts at launch with "Library not loaded:
        // @rpath/libswift_Concurrency.dylib".
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
