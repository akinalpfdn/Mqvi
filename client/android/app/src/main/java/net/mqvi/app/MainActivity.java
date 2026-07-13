package net.mqvi.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    public static final String EXTRA_INCOMING_CALL = "incoming_call";
    public static final String EXTRA_CALL_ID = "call_id";
    // Toggled by onResume/onPause so MqviMessagingService rings natively only when the
    // app isn't in the foreground (foreground = the in-app overlay handles the ring).
    public static volatile boolean isAppForeground = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceCallPlugin.class);
        registerPlugin(ScreenSharePlugin.class);
        registerPlugin(P2PCallPlugin.class);
        super.onCreate(savedInstanceState);
        handleCallLaunch(getIntent());

        // Inject real safe area inset values as CSS custom properties on <html>.
        // Android WebView's env(safe-area-inset-*) returns 0 (Chromium < 140 bug),
        // so we read WindowInsets natively and set --safe-area-inset-* via JS.
        // Ref: https://medium.com/androiddevelopers/make-webviews-edge-to-edge-a6ef319adfac
        ViewCompat.setOnApplyWindowInsetsListener(
            getBridge().getWebView(),
            (view, windowInsets) -> {
                Insets insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                );
                float density = getResources().getDisplayMetrics().density;
                float top = insets.top / density;
                float bottom = insets.bottom / density;
                float left = insets.left / density;
                float right = insets.right / density;

                String js = String.format(
                    "document.documentElement.style.setProperty('--safe-area-inset-top','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-bottom','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-left','%.1fpx');"
                    + "document.documentElement.style.setProperty('--safe-area-inset-right','%.1fpx');",
                    top, bottom, left, right
                );
                getBridge().getWebView().evaluateJavascript(js, null);

                return windowInsets;
            }
        );

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
        // A notification posted while we were backgrounded keeps looping its ringtone
        // (FLAG_INSISTENT) even once the app is open and the in-app overlay is ringing.
        // The overlay owns the ring from here on.
        P2PCallPlugin.Companion.cancelCallNotification(this);
    }

    @Override
    public void onPause() {
        super.onPause();
        isAppForeground = false;
    }
}
