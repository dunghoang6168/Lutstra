package com.lutstra.android;

import android.content.Context;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

@OptIn(markerClass = UnstableApi.class)
public final class PlaybackService extends MediaSessionService {
    private MediaSession mediaSession;
    private AudioOutputState output;

    @Override
    public void onCreate() {
        super.onCreate();
        output = new AudioOutputState(this);
        // The EQ as last set, so playback started without the web (a headset button) still runs it.
        EqSettingsStore.load(this);
        // Float output keeps 24-bit files at full resolution into the mixer (MediaCodec then decodes every file to float).
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this) {
            @Override
            protected AudioSink buildAudioSink(Context context, boolean enableFloatOutput, boolean enableAudioTrackPlaybackParams) {
                // The EQ wraps the sink: Media3 skips app audio processors on the float path.
                return new EqAudioSink(new DefaultAudioSink.Builder(context).setEnableFloatOutput(true).setAudioOutputProvider(output).build(), output);
            }
        };
        ExoPlayer player = new ExoPlayer.Builder(this, renderers).build();
        player.setAudioAttributes(AudioAttributes.DEFAULT, true);
        player.addAnalyticsListener(new AnalyticsListener() {
            @Override
            public void onAudioTrackInitialized(EventTime eventTime, AudioSink.AudioTrackConfig config) { output.onTrackInitialized(config); }

            @Override
            public void onAudioTrackReleased(EventTime eventTime, AudioSink.AudioTrackConfig config) { output.onTrackReleased(config); }

            @Override
            public void onAudioDecoderInitialized(EventTime eventTime, String decoderName, long initializedTimestampMs, long initializationDurationMs) {
                output.onDecoderInitialized(decoderName);
            }
        });
        // A new AudioTrack picks up the USB mixer request; the queue, position and play state stay.
        output.reopen = () -> new android.os.Handler(player.getApplicationLooper()).post(() -> {
            if (player.getPlaybackState() == Player.STATE_IDLE || player.getMediaItemCount() == 0) return;
            player.stop();
            player.prepare();
        });
        mediaSession = new MediaSession.Builder(this, player).build();
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onDestroy() {
        if (output != null) output.close();
        if (mediaSession != null) {
            mediaSession.getPlayer().release();
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }
}
