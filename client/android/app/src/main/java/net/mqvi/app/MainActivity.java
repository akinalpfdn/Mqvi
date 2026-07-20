package net.mqvi.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.List;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    public static final String EXTRA_INCOMING_CALL = "incoming_call";
    public static final String EXTRA_CALL_ID = "call_id";
    // Toggled by onResume/onPause so MqviMessagingService rings natively only when the
    // app isn't in the foreground (foreground = the in-app overlay handles the ring).
    public static volatile boolean isAppForeground = false;

    // Last insets seen, as the JS that applies them. Main thread only.
    private String pendingInsetJs = null;

    // Last keyboard height pushed to the page (px, 1-decimal). Skips redundant emits — including
    // the 0s that non-IME inset animations would otherwise fire. Main thread only.
    private float lastKeyboardPx = -1f;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceCallPlugin.class);
        registerPlugin(ScreenSharePlugin.class);
        registerPlugin(P2PCallPlugin.class);
        registerPlugin(OrientationPlugin.class);
        registerPlugin(MediaPosterPlugin.class);
        super.onCreate(savedInstanceState);
        handleCallLaunch(getIntent());

        // Portrait on a phone, free on a tablet. The JS side turns this to landscape while a
        // stream is being watched full-screen, and puts it back on the way out.
        OrientationPlugin.applyDefault(this);

        installSafeAreaFallback();
        installKeyboardInsetTracking();
    }

    // Capacitor's SystemBars plugin owns safe areas. With viewport-fit=cover and WebView 140+ it
    // stops padding the WebView's container and hands the insets to the page instead — but it
    // only injects --safe-area-inset-* when SDK >= 35, and env(safe-area-inset-*) still reads 0
    // in the Android WebView (measured on Chromium 143). So on Android < 15 with a current
    // WebView the page is edge-to-edge with no insets at all and the header lands behind the
    // status bar. That gap is the only thing this fills. On 15+ Capacitor does it and we stay out
    // of the way — two writers on the same custom properties is what made this flaky before.
    private void installSafeAreaFallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            return;
        }

        final WebView webView = getBridge().getWebView();

        // Downstream of Capacitor's listener, which sits on the parent: it passes the real insets
        // through when it leaves the WebView edge-to-edge, and zeroes them when it padded the
        // container itself. Either way, what arrives here is what the page actually needs.
        ViewCompat.setOnApplyWindowInsetsListener(
            webView,
            (view, windowInsets) -> {
                Insets insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                float density = getResources().getDisplayMetrics().density;

                // Locale.US: "%.1f" of 24.0 renders as "24,0" wherever the decimal separator is a
                // comma, and "padding-top: 24,0px" is invalid at computed-value time — the padding
                // silently falls back to 0.
                pendingInsetJs = String.format(
                    Locale.US,
                    "document.documentElement.style.setProperty('--safe-area-inset-top','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-bottom','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-left','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-right','%.1fpx');",
                    insets.top / density,
                    insets.bottom / density,
                    insets.left / density,
                    insets.right / density
                );
                webView.evaluateJavascript(pendingInsetJs, null);

                return windowInsets;
            }
        );

        // The injection writes an inline style on <html>. Insets are dispatched on the first
        // layout, and the document that was live then is replaced by the app's — taking the
        // custom properties with it. Replay on every page so the value cannot go missing.
        getBridge()
            .addWebViewListener(
                new WebViewListener() {
                    @Override
                    public void onPageCommitVisible(WebView view, String url) {
                        super.onPageCommitVisible(view, url);
                        replaySafeArea(view);
                    }

                    @Override
                    public void onPageLoaded(WebView view) {
                        super.onPageLoaded(view);
                        replaySafeArea(view);
                    }
                }
            );

        ViewCompat.requestApplyInsets(webView);
    }

    private void replaySafeArea(WebView view) {
        if (pendingInsetJs != null) {
            view.evaluateJavascript(pendingInsetJs, null);
        }
    }

    // The soft keyboard is tracked separately from the safe-area insets. adjustNothing means the
    // window never resizes when the IME opens, so the web layer lifts itself against
    // --keyboard-inset instead. The animation callback is a different slot from
    // setOnApplyWindowInsetsListener, so it disturbs neither the safe-area listener nor
    // Capacitor's own inset handling on API 35+.
    private void installKeyboardInsetTracking() {
        final WebView webView = getBridge().getWebView();

        ViewCompat.setWindowInsetsAnimationCallback(
            webView,
            new WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP
            ) {
                @Override
                public WindowInsetsCompat onProgress(
                    WindowInsetsCompat insets,
                    List<WindowInsetsAnimationCompat> runningAnimations
                ) {
                    emitKeyboardInset(webView, insets);
                    return insets;
                }

                @Override
                public void onEnd(WindowInsetsAnimationCompat animation) {
                    // Authoritative resting value, in case the per-frame progress was choppy.
                    WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView);
                    if (insets != null) {
                        emitKeyboardInset(webView, insets);
                    }
                }
            }
        );
    }

    private void emitKeyboardInset(WebView webView, WindowInsetsCompat insets) {
        float density = getResources().getDisplayMetrics().density;
        int ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
        int nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
        // Keyboard height ABOVE the nav bar: #root already reserves the nav bar via
        // --safe-area-inset-bottom, so folding the full ime inset in would double-count it.
        float keyboard = Math.max(0, ime - nav) / density;
        float rounded = Math.round(keyboard * 10f) / 10f;
        if (rounded == lastKeyboardPx) {
            return;
        }
        lastKeyboardPx = rounded;
        String js = String.format(
            Locale.US,
            "document.documentElement.style.setProperty('--keyboard-inset','%.1fpx');",
            rounded
        );
        webView.evaluateJavascript(js, null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleCallLaunch(intent);
    }

    // When launched/resumed for an incoming call (via the full-screen intent), show
    // over the lock screen and turn the screen on. The actual answer/decline is handled
    // by the in-app overlay, which the server's WS connect-replay raises.
    private void handleCallLaunch(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(EXTRA_INCOMING_CALL, false)) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            );
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        isAppForeground = true;
    }

    @Override
    public void onPause() {
        super.onPause();
        isAppForeground = false;
    }
}
