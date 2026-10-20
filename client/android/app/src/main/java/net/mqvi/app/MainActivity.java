package net.mqvi.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
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

        installInsetHandling();
        installKeyboardInsetTracking();
    }

    // The page owns every inset: the WebView is edge-to-edge and never resizes, the system bars
    // reach CSS as --safe-area-inset-*, the keyboard as --keyboard-inset (below). Same model as iOS.
    //
    // Capacitor's SystemBars plugin listens on the WebView's container and pads its bottom by the
    // keyboard height whenever the keyboard is up, adjustNothing or not. That shrank the WebView
    // on top of --keyboard-inset, and keyboardScroll.ts (which measures the visible bottom as
    // innerHeight minus the keyboard) then subtracted the keyboard twice and scrolled fields that
    // were in plain view. Replacing that listener drops the padding; it also took Capacitor's
    // safe-area injection with it, so the WebView listener below writes the safe areas on every
    // SDK — one writer. Runs after super.onCreate, which is where SystemBars installs its own.
    private void installInsetHandling() {
        final WebView webView = getBridge().getWebView();

        ViewCompat.setOnApplyWindowInsetsListener(
            (View) webView.getParent(),
            (container, windowInsets) -> {
                container.setPadding(0, 0, 0, 0);
                return windowInsets;
            }
        );

        // Also replaces the WebView's own inset handling, so nothing in Chromium resizes its
        // viewport for the keyboard either.
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
    // --keyboard-inset, set every frame of the keyboard animation, and keyboardScroll.ts brings the
    // focused field up from the `mqvikeyboard` events sent as the animation starts and ends.
    //
    // The callback sits on the root view and replaces the Keyboard plugin's: the plugin's root
    // callback is DISPATCH_MODE_STOP, and a STOP callback keeps the animation from every view
    // below it (ViewGroup#dispatchWindowInsetsAnimation*), so one on the WebView never ran. That
    // also ends the plugin's keyboard events on Android; nothing here listens to them any more.
    // Runs after super.onCreate, where the plugin installs its own.
    private void installKeyboardInsetTracking() {
        final WebView webView = getBridge().getWebView();
        final View root = findViewById(android.R.id.content).getRootView();

        ViewCompat.setWindowInsetsAnimationCallback(
            root,
            new WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE
            ) {
                @Override
                public WindowInsetsAnimationCompat.BoundsCompat onStart(
                    WindowInsetsAnimationCompat animation,
                    WindowInsetsAnimationCompat.BoundsCompat bounds
                ) {
                    // onStart sees the insets the animation ends on.
                    WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(root);
                    if (isKeyboard(animation) && insets != null) {
                        boolean showing = insets.isVisible(WindowInsetsCompat.Type.ime());
                        emitKeyboardEvent(webView, showing ? "willShow" : "willHide", insets, animation.getDurationMillis());
                    }
                    return bounds;
                }

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
                    WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(root);
                    if (insets == null) {
                        return;
                    }
                    emitKeyboardInset(webView, insets);
                    if (isKeyboard(animation)) {
                        boolean showing = insets.isVisible(WindowInsetsCompat.Type.ime());
                        emitKeyboardEvent(webView, showing ? "didShow" : "didHide", insets, 0);
                    }
                }
            }
        );
    }

    private static boolean isKeyboard(WindowInsetsAnimationCompat animation) {
        return (animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0;
    }

    /** `height` is the whole keyboard from the screen's bottom edge, as keyboardScroll.ts expects. */
    private void emitKeyboardEvent(WebView webView, String phase, WindowInsetsCompat insets, long durationMs) {
        float density = getResources().getDisplayMetrics().density;
        float height = insets.isVisible(WindowInsetsCompat.Type.ime())
            ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom / density
            : 0f;
        String js = String.format(
            Locale.US,
            "window.dispatchEvent(new CustomEvent('mqvikeyboard',{detail:{phase:'%s',height:%.1f,duration:%d}}));",
            phase,
            height,
            durationMs
        );
        webView.evaluateJavascript(js, null);
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
