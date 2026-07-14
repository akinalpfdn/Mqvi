package net.mqvi.app;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Screen orientation. The app is portrait on a phone: its layout is a single column and the
 * landscape viewport is wide enough to trip the desktop breakpoint, which lays three columns
 * out on a 400px-tall screen. Watching someone's desktop stream is the one thing worth turning
 * the phone for, and that is what lockLandscape is for.
 *
 * A tablet is left alone — it is wide enough for the desktop layout in either orientation, and
 * that layout is the right one there.
 *
 * Written rather than pulled in as @capacitor/screen-orientation: this is one call to
 * setRequestedOrientation, and the project already carries its own plugins.
 */
@CapacitorPlugin(name = "Orientation")
public class OrientationPlugin extends Plugin {

    /** Anything under 600dp on its shortest edge is a phone — the same line Android draws. */
    static boolean isPhone(Configuration config) {
        return config.smallestScreenWidthDp < 600;
    }

    /** Called at startup so the app opens portrait on a phone. */
    static void applyDefault(android.app.Activity activity) {
        activity.setRequestedOrientation(
            isPhone(activity.getResources().getConfiguration())
                ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        );
    }

    @PluginMethod
    public void lockLandscape(PluginCall call) {
        getActivity().runOnUiThread(() ->
            // SENSOR_LANDSCAPE, not LANDSCAPE: the user turns the phone whichever way they like
            // and the picture follows. A fixed LANDSCAPE would be upside down half the time.
            getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        );
        call.resolve();
    }

    /** Back to what the device is entitled to: portrait on a phone, free on a tablet. */
    @PluginMethod
    public void restoreDefault(PluginCall call) {
        getActivity().runOnUiThread(() -> applyDefault(getActivity()));
        call.resolve();
    }
}
