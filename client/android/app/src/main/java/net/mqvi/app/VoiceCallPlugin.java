package net.mqvi.app;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin to start/stop the VoiceCallService foreground service.
 * Called from JS when user joins/leaves a voice channel.
 */
@CapacitorPlugin(name = "VoiceCallService")
public class VoiceCallPlugin extends Plugin {

    @PluginMethod()
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), VoiceCallService.class);
        getContext().startForegroundService(intent);
        call.resolve();
    }

    @PluginMethod()
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), VoiceCallService.class);
        getContext().stopService(intent);
        call.resolve();
    }
}
