package net.mqvi.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom native plugins before super.onCreate
        registerPlugin(VoiceCallPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
