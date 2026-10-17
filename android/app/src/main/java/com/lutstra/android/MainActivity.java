package com.lutstra.android;

import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
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
        registerPlugin(AndroidHistoryPlugin.class);
        registerPlugin(AppShellPlugin.class);
        super.onCreate(savedInstanceState);
        // The web shell decides what Back does (close a sheet, go back a page) and calls moveToBack at its root.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() { bridge.triggerWindowJSEvent("lutstraback"); }
        });
    }

    /** Shell services for the web layer: leaving at the root screen, haptics, the mixer rate and the wallpaper palette. */
    @CapacitorPlugin(name = "AppShell")
    public static final class AppShellPlugin extends Plugin {
        /** Leaves the app the way the system Back does at a root screen: the task moves back and playback keeps going. */
        @PluginMethod
        public void moveToBack(PluginCall call) {
            getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
            call.resolve();
        }

        /** A gesture's buzz through the view's haptic feedback, so it follows the system touch-vibration setting. */
        @PluginMethod
        public void haptic(PluginCall call) {
            int sdk = android.os.Build.VERSION.SDK_INT;
            String kind = call.getString("kind", "tick");
            int feedback;
            switch (kind) {
                case "start": feedback = sdk >= 30 ? android.view.HapticFeedbackConstants.GESTURE_START : android.view.HapticFeedbackConstants.LONG_PRESS; break;
                case "end": feedback = sdk >= 30 ? android.view.HapticFeedbackConstants.GESTURE_END : android.view.HapticFeedbackConstants.CLOCK_TICK; break;
                case "activate": feedback = sdk >= 34 ? android.view.HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE : android.view.HapticFeedbackConstants.CLOCK_TICK; break;
                case "deactivate": feedback = sdk >= 34 ? android.view.HapticFeedbackConstants.GESTURE_THRESHOLD_DEACTIVATE : android.view.HapticFeedbackConstants.CLOCK_TICK; break;
                default: feedback = android.view.HapticFeedbackConstants.CLOCK_TICK;
            }
            getActivity().runOnUiThread(() -> getBridge().getWebView().performHapticFeedback(feedback));
            call.resolve();
        }

        /** The rate Android's mixer runs the primary output at; every app's audio is resampled to it. */
        @PluginMethod
        public void getOutputInfo(PluginCall call) {
            android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
            String rate = audio == null ? null : audio.getProperty(android.media.AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);
            JSObject result = new JSObject();
            try { result.put("sampleRate", rate == null ? null : Integer.parseInt(rate)); } catch (NumberFormatException error) { result.put("sampleRate", null); }
            call.resolve(result);
        }

        /** Material You: the system_accent1 tones from the wallpaper, keyed by tone (Android 12+). */
        @PluginMethod
        public void getDynamicColors(PluginCall call) {
            if (android.os.Build.VERSION.SDK_INT < 31) { call.reject("UNSUPPORTED", "UNSUPPORTED"); return; }
            int[] tones = { 10, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900 };
            int[] ids = {
                android.R.color.system_accent1_10, android.R.color.system_accent1_50, android.R.color.system_accent1_100,
                android.R.color.system_accent1_200, android.R.color.system_accent1_300, android.R.color.system_accent1_400,
                android.R.color.system_accent1_500, android.R.color.system_accent1_600, android.R.color.system_accent1_700,
                android.R.color.system_accent1_800, android.R.color.system_accent1_900,
            };
            JSObject palette = new JSObject();
            for (int i = 0; i < tones.length; i++) {
                palette.put(String.valueOf(tones[i]), String.format("#%06x", getContext().getColor(ids[i]) & 0xffffff));
            }
            JSObject result = new JSObject();
            result.put("palette", palette);
            call.resolve(result);
        }
    }
}
