package com.lutstra.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.common.util.concurrent.ListenableFuture;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.function.Consumer;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(
    name = "AndroidPlayback",
    permissions = { @Permission(alias = "bluetooth", strings = { android.Manifest.permission.BLUETOOTH_CONNECT }) }
)
public final class PlaybackPlugin extends Plugin {
    private ListenableFuture<MediaController> controllerFuture;
    private MediaController controller;
    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onEvents(Player player, Player.Events events) {
            notifyListeners("state", stateOf(player));
        }

        @Override
        public void onMediaItemTransition(MediaItem mediaItem, int reason) {
            JSObject event = new JSObject();
            event.put("mediaId", mediaItem == null ? null : mediaItem.mediaId);
            event.put("auto", reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO);
            notifyListeners("advanced", event);
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            JSObject event = new JSObject();
            event.put("code", error.getErrorCodeName());
            event.put("message", error.getMessage());
            notifyListeners("error", event);
        }
    };

    @Override
    public void load() {
        AudioOutputState.listener = snapshot -> notifyListeners("output", snapshot);
    }

    /** What the audio goes through now: device, stream, mixer, the USB mode and what the plugged DAC offers. */
    @PluginMethod
    public void getOutput(PluginCall call) {
        withController(call, mediaController -> {
            AudioOutputState output = AudioOutputState.current;
            if (output == null) call.reject("Playback service not running"); else call.resolve(output.snapshot());
        });
    }

    /** { mode: 'shared' | 'match' | 'bitperfect' }: how a USB DAC is played to (Android 14+); takes effect at once. */
    @PluginMethod
    public void setUsbMode(PluginCall call) {
        withController(call, mediaController -> {
            AudioOutputState output = AudioOutputState.current;
            if (output == null) { call.reject("Playback service not running"); return; }
            try { output.setMode(call.getString("mode", AudioOutputState.SHARED)); } catch (IllegalArgumentException error) { call.reject(error.getMessage()); return; }
            call.resolve(output.snapshot());
        });
    }

    /** Asks for Nearby devices (BLUETOOTH_CONNECT, Android 12+) so the output line can name the Bluetooth codec. */
    @PluginMethod
    public void requestBluetoothAccess(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 31 || getPermissionState("bluetooth") == com.getcapacitor.PermissionState.GRANTED) {
            bluetoothAccessResult(call);
        } else {
            requestPermissionForAlias("bluetooth", call, "bluetoothAccessResult");
        }
    }

    @PermissionCallback
    private void bluetoothAccessResult(PluginCall call) {
        withController(call, mediaController -> {
            AudioOutputState output = AudioOutputState.current;
            if (output == null) { call.reject("Playback service not running"); return; }
            output.enableCodec();
            call.resolve(output.snapshot());
        });
    }

    @PluginMethod
    public void pickAndPlay(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickedAudio");
    }

    @ActivityCallback
    private void pickedAudio(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("File selection cancelled");
            return;
        }
        Intent data = result.getData();
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.isEmpty()) {
            call.reject("No audio URI returned");
            return;
        }

        List<MediaItem> items = new ArrayList<>();
        for (Uri uri : uris) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // Playback can still use the temporary picker grant; persistence is recorded separately.
            }
            String title = displayName(uri);
            items.add(new MediaItem.Builder()
                .setMediaId(uri.toString())
                .setUri(uri)
                .setMediaMetadata(new MediaMetadata.Builder().setTitle(title).build())
                .build());
        }
        withController(call, mediaController -> {
            mediaController.setMediaItems(items);
            mediaController.prepare();
            mediaController.play();
            call.resolve(stateOf(mediaController));
        });
    }

    /** Replaces the service queue with library tracks: items = [{ uri, title?, artist?, album? }]. */
    @PluginMethod
    public void playQueue(PluginCall call) {
        JSArray input = call.getArray("items");
        int startIndex = call.getInt("startIndex", 0);
        if (input == null || input.length() == 0) { call.reject("Items required"); return; }
        List<MediaItem> items = new ArrayList<>();
        try {
            for (int i = 0; i < input.length(); i++) {
                items.add(itemOf(input.getJSONObject(i)));
            }
        } catch (JSONException error) { call.reject("Invalid queue item", error); return; }
        if (startIndex < 0 || startIndex >= items.size()) { call.reject("Invalid startIndex"); return; }
        withController(call, mediaController -> {
            mediaController.setMediaItems(items, startIndex, 0);
            mediaController.prepare();
            mediaController.play();
            call.resolve(stateOf(mediaController));
        });
    }

    /** { uri, id?, title?, artist?, album? }; the media ID is the library track ID when given. */
    private MediaItem itemOf(JSONObject item) throws JSONException {
        Uri uri = Uri.parse(item.getString("uri"));
        String id = text(item, "id");
        return new MediaItem.Builder()
            .setMediaId(id != null ? id : uri.toString())
            .setUri(uri)
            .setMediaMetadata(new MediaMetadata.Builder()
                .setTitle(text(item, "title") != null ? text(item, "title") : displayName(uri))
                .setArtist(text(item, "artist"))
                .setAlbumTitle(text(item, "album"))
                .build())
            .build();
    }

    /** Engine entry: one track, paused, replacing the queue. */
    @PluginMethod
    public void load(PluginCall call) {
        MediaItem item;
        try { item = itemOf(call.getData()); } catch (JSONException error) { call.reject("Invalid track", error); return; }
        withController(call, mediaController -> {
            mediaController.setMediaItems(Collections.singletonList(item));
            mediaController.setPlayWhenReady(false);
            mediaController.prepare();
            call.resolve(stateOf(mediaController));
        });
    }

    /**
     * Engine entry: { afterId, items }, the run of tracks Media3 plays after the current one, gaplessly and on its
     * own, so the queue keeps going while the web sleeps (screen off). afterId is the track the web takes as
     * current; when Media3 has already moved on, the call is stale and changes nothing ({ applied: false }).
     */
    @PluginMethod
    public void prepareNext(PluginCall call) {
        JSArray input = call.getArray("items");
        if (input == null || input.length() == 0) { call.reject("Items required"); return; }
        List<MediaItem> items = new ArrayList<>();
        try {
            for (int i = 0; i < input.length(); i++) items.add(itemOf(input.getJSONObject(i)));
        } catch (JSONException error) { call.reject("Invalid track", error); return; }
        String afterId = call.getString("afterId");
        withController(call, mediaController -> {
            boolean applied = isCurrent(mediaController, afterId);
            if (applied) replaceUpcoming(mediaController, items);
            JSObject result = new JSObject();
            result.put("applied", applied);
            call.resolve(result);
        });
    }

    /** { afterId }: drops what follows the current track, unless Media3 has already moved past afterId. */
    @PluginMethod
    public void cancelPreparedNext(PluginCall call) {
        String afterId = call.getString("afterId");
        withController(call, mediaController -> {
            if (isCurrent(mediaController, afterId)) dropAfterCurrent(mediaController);
            call.resolve();
        });
    }

    /** { on }: Media3 loops the current track itself (Repeat one), so the loop holds while the web sleeps. */
    @PluginMethod
    public void setRepeatOne(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        withController(call, mediaController -> {
            mediaController.setRepeatMode(on ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            call.resolve();
        });
    }

    private static boolean isCurrent(Player player, String mediaId) {
        MediaItem current = player.getCurrentMediaItem();
        return current != null && current.mediaId.equals(mediaId);
    }

    /**
     * Makes the items after the current one these, keeping those already in place: a resend leaves Media3's buffer
     * alone, and a longer run only adds its tail. Media3 takes changes on this (the UI) thread, where hundreds of
     * items cost the WebView its frames.
     */
    private static void replaceUpcoming(Player player, List<MediaItem> items) {
        int from = player.getCurrentMediaItemIndex() + 1;
        int count = player.getMediaItemCount();
        int kept = 0;
        while (kept < items.size() && from + kept < count && player.getMediaItemAt(from + kept).mediaId.equals(items.get(kept).mediaId)) kept++;
        if (from + kept < count) player.removeMediaItems(from + kept, count);
        if (kept < items.size()) player.addMediaItems(items.subList(kept, items.size()));
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        if (volume == null || !Double.isFinite(volume)) { call.reject("Invalid volume"); return; }
        withController(call, mediaController -> {
            mediaController.setVolume((float) Math.max(0, Math.min(1, volume)));
            call.resolve();
        });
    }

    private static void dropAfterCurrent(Player player) {
        int from = player.getCurrentMediaItemIndex() + 1;
        if (from < player.getMediaItemCount()) player.removeMediaItems(from, player.getMediaItemCount());
    }

    // optString turns a JSON null into "null".
    private static String text(JSONObject item, String key) {
        return item.isNull(key) ? null : item.optString(key);
    }

    /** Sets what the EQ runs: `{ preampDb, filters: [{ type: peak|lowshelf|highshelf, freq, gainDb, q }], crossfeed }`. */
    @PluginMethod
    public void setEq(PluginCall call) {
        try {
            EqDsp.spec = EqSettingsStore.parse(call.getData());
            EqSettingsStore.save(getContext(), call.getData());
            call.resolve();
        } catch (IllegalArgumentException | JSONException error) {
            call.reject(error.getMessage());
        }
    }

    /** Whether the EQ is running, and what it has done: for the Audio path sheet and checks. */
    @PluginMethod
    public void getEqStats(PluginCall call) {
        EqAudioSink sink = EqAudioSink.current;
        JSObject result = new JSObject();
        result.put("running", sink != null && sink.running());
        result.put("hasWork", EqDsp.spec != null && !EqDsp.spec.isFlat());
        if (sink != null) {
            result.put("frames", sink.dsp.frames);
            result.put("nanos", sink.dsp.nanos);
            result.put("clippedSamples", sink.dsp.clippedSamples);
            result.put("peak", (double) sink.dsp.peak);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void getState(PluginCall call) {
        withController(call, mediaController -> call.resolve(stateOf(mediaController)));
    }

    @PluginMethod
    public void playTestQueue(PluginCall call) {
        try {
            List<MediaItem> items = new ArrayList<>();
            items.add(testItem(440));
            items.add(testItem(660));
            withController(call, mediaController -> {
                mediaController.setMediaItems(items);
                mediaController.prepare();
                mediaController.play();
                call.resolve(stateOf(mediaController));
            });
        } catch (IOException error) {
            call.reject("Could not create test audio", error);
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        withController(call, mediaController -> {
            mediaController.play();
            call.resolve(stateOf(mediaController));
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withController(call, mediaController -> {
            mediaController.pause();
            call.resolve(stateOf(mediaController));
        });
    }

    @PluginMethod
    public void next(PluginCall call) {
        withController(call, mediaController -> {
            mediaController.seekToNextMediaItem();
            call.resolve(stateOf(mediaController));
        });
    }

    @PluginMethod
    public void previous(PluginCall call) {
        withController(call, mediaController -> {
            mediaController.seekToPreviousMediaItem();
            call.resolve(stateOf(mediaController));
        });
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        Double positionMs = call.getDouble("positionMs");
        if (positionMs == null || positionMs < 0 || !Double.isFinite(positionMs)) {
            call.reject("Invalid positionMs");
            return;
        }
        withController(call, mediaController -> {
            mediaController.seekTo(positionMs.longValue());
            call.resolve(stateOf(mediaController));
        });
    }

    private void withController(PluginCall call, Consumer<MediaController> action) {
        getActivity().runOnUiThread(() -> {
            if (controller != null) {
                action.accept(controller);
                return;
            }
            if (controllerFuture == null) {
                SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
                controllerFuture = new MediaController.Builder(getContext(), token).buildAsync();
            }
            controllerFuture.addListener(() -> {
                try {
                    MediaController connected = controllerFuture.get();
                    if (controller == null) {
                        controller = connected;
                        controller.addListener(listener);
                    }
                    action.accept(connected);
                } catch (ExecutionException | InterruptedException error) {
                    call.reject("Media3 controller connection failed", error);
                } catch (RuntimeException error) {
                    call.reject("Media3 playback command failed", error);
                }
            }, ContextCompat.getMainExecutor(getContext()));
        });
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (RuntimeException ignored) {
            // A provider may omit metadata while still allowing the file to be opened.
        }
        return uri.getLastPathSegment() == null ? "Unknown audio" : uri.getLastPathSegment();
    }

    private MediaItem testItem(int frequencyHz) throws IOException {
        File file = new File(getContext().getCacheDir(), "tone-" + frequencyHz + "hz.wav");
        if (!file.exists()) {
            int sampleRate = 44100;
            int sampleCount = sampleRate * 30;
            ByteBuffer wave = ByteBuffer.allocate(44 + sampleCount * 2).order(ByteOrder.LITTLE_ENDIAN);
            wave.put("RIFF".getBytes(StandardCharsets.US_ASCII));
            wave.putInt(36 + sampleCount * 2);
            wave.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
            wave.putInt(16);
            wave.putShort((short) 1);
            wave.putShort((short) 1);
            wave.putInt(sampleRate);
            wave.putInt(sampleRate * 2);
            wave.putShort((short) 2);
            wave.putShort((short) 16);
            wave.put("data".getBytes(StandardCharsets.US_ASCII));
            wave.putInt(sampleCount * 2);
            for (int i = 0; i < sampleCount; i++) {
                wave.putShort((short) Math.round(Math.sin(2 * Math.PI * frequencyHz * i / sampleRate) * 12000));
            }
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(wave.array());
            }
        }
        String title = "Test " + frequencyHz + " Hz";
        return new MediaItem.Builder()
            .setMediaId(title)
            .setUri(Uri.fromFile(file))
            .setMediaMetadata(new MediaMetadata.Builder().setTitle(title).build())
            .build();
    }

    private JSObject stateOf(Player player) {
        JSObject state = new JSObject();
        state.put("playing", player.isPlaying());
        state.put("playWhenReady", player.getPlayWhenReady());
        state.put("playbackState", player.getPlaybackState());
        state.put("positionMs", player.getCurrentPosition());
        state.put("durationMs", player.getDuration());
        state.put("index", player.getCurrentMediaItemIndex());
        state.put("count", player.getMediaItemCount());
        MediaItem item = player.getCurrentMediaItem();
        state.put("mediaId", item == null ? null : item.mediaId);
        state.put("title", item == null || item.mediaMetadata.title == null ? "" : item.mediaMetadata.title.toString());
        return state;
    }

    @Override
    protected void handleOnDestroy() {
        AudioOutputState.listener = null;
        if (controller != null) controller.removeListener(listener);
        if (controllerFuture != null) MediaController.releaseFuture(controllerFuture);
        controller = null;
        controllerFuture = null;
        super.handleOnDestroy();
    }
}
