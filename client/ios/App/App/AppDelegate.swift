import UIKit
import AVFoundation
import UserNotifications
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Configure audio session for voice/video calls.
        // .playAndRecord: simultaneous input + output (required for calls).
        // .allowBluetooth: support AirPods / BT headsets.
        // .defaultToSpeaker: route to speaker when no headphones connected.
        // .mixWithOthers: don't interrupt other audio apps when not in a call.
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
            )
            // Minimize audio latency — 0.005s (5ms) buffer duration.
            // Default is ~0.023s (23ms). Lower = less delay, especially in background.
            try audioSession.setPreferredIOBufferDuration(0.005)
            try audioSession.setActive(true)
        } catch {
            print("Failed to configure AVAudioSession: \(error.localizedDescription)")
        }

        // Listen for audio session interruptions (phone calls, Siri, etc.)
        // and reactivate when the interruption ends to resume WebRTC audio.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioInterruption),
            name: AVAudioSession.interruptionNotification,
            object: audioSession
        )

        // Register for VoIP pushes + CallKit at launch so a cold-launch incoming-call
        // push is reported to CallKit before the WebView loads.
        CallManager.shared.start()

        return true
    }

    /// Reactivate audio session after interruption (e.g., phone call ends).
    /// Without this, WebRTC audio stays muted after an interruption.
    @objc private func handleAudioInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

        if type == .ended {
            do {
                try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
            } catch {
                print("Failed to reactivate audio session after interruption: \(error)")
            }
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // Forward APNs registration to Capacitor so @capacitor/push-notifications emits the
    // device token to JS (its "registration" event). Without this the plugin never fires,
    // so the iOS APNs message token is never registered and DM pushes never arrive. (VoIP
    // is unaffected — PushKit is wired directly in CallManager, not via this delegate.)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // dm_read retraction — the iOS counterpart of MqviMessagingService's native handling on
    // Android. The server sends a silent content-available push when a conversation is read on
    // another device; the delivered DM notification's identifier is its apns-collapse-id
    // ("dm:<channelId>", see dmNotificationTag on the server), so it can be removed directly.
    // Handled natively because the WebView may be suspended while backgrounded. Best-effort by
    // iOS design (background pushes are throttled, never delivered to a force-quit app) — the
    // reconnect sweep in pushDismiss.ts is the backstop.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let type = userInfo["type"] as? String, type == "dm_read",
              let channelID = userInfo["dm_channel_id"] as? String, !channelID.isEmpty else {
            completionHandler(.noData)
            return
        }

        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["dm:" + channelID])
        completionHandler(.newData)
    }

}
