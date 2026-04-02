package net.mqvi.app;

import android.os.Bundle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceCallPlugin.class);
        registerPlugin(ScreenSharePlugin.class);
        super.onCreate(savedInstanceState);

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
}
