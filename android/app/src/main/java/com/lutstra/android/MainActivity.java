package com.lutstra.android;

import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlaybackPlugin.class);
        registerPlugin(AndroidLibraryPlugin.class);
        registerPlugin(AndroidFolderPlugin.class);
        registerPlugin(AndroidPlaylistPlugin.class);
        registerPlugin(AppShellPlugin.class);
        super.onCreate(savedInstanceState);
        // The web shell decides what Back does (close a sheet, go back a page) and calls moveToBack at its root.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() { bridge.triggerWindowJSEvent("lutstraback"); }
        });
    }

    /** Leaves the app the way the system Back does at a root screen: the task moves back and playback keeps going. */
    @CapacitorPlugin(name = "AppShell")
    public static final class AppShellPlugin extends Plugin {
        @PluginMethod
        public void moveToBack(PluginCall call) {
            getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
            call.resolve();
        }
    }
}
