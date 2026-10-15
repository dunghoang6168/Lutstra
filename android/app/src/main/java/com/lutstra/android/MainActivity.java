package com.lutstra.android;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlaybackPlugin.class);
        registerPlugin(AndroidLibraryPlugin.class);
        registerPlugin(AndroidFolderPlugin.class);
        registerPlugin(AndroidPlaylistPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
