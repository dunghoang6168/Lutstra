package com.lutstra.android;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioMixerAttributes;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.OptIn;
import androidx.media3.common.util.Clock;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.audio.AudioOutput;
import androidx.media3.exoplayer.audio.AudioOutputProvider;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.AudioTrackAudioOutputProvider;
import com.getcapacitor.JSObject;
import java.util.List;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * What the phone's audio really goes through: the stream ExoPlayer writes, the device it is routed to and the
 * mixer rate there. For a USB DAC (Android 14+) the mixer can be asked to run at the stream's own rate ("match")
 * or not to mix at all ("bitperfect"). The request is made right before each AudioTrack is created, so it fits
 * the stream that track carries; a mode the DAC cannot honour for a stream falls back one step and says so.
 */
@OptIn(markerClass = UnstableApi.class)
final class AudioOutputState implements AudioOutputProvider {
    static final String SHARED = "shared";
    static final String MATCH = "match";
    static final String BIT_PERFECT = "bitperfect";
    private static final String PREFS = "lutstra-output";
    private static final String MODE_KEY = "usbMode";
    private static final AudioAttributes MEDIA =new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build();

    /** The service's instance while it runs; PlaybackPlugin reads and changes it. */
    static volatile AudioOutputState current;
    /** PlaybackPlugin's sink for every change of the snapshot. */
    static volatile Consumer<JSObject> listener;

    private final Context context;
    private final AudioManager audio;
    private final AudioOutputProvider delegate;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile String mode;
    /** The AudioTrack ExoPlayer is writing to, or null when none is open. */
    private volatile AudioSink.AudioTrackConfig stream;
    /** The mixer attributes Lutstra asked for, and on which device. */
    private volatile Object requested;
    private volatile AudioDeviceInfo requestedDevice;
    /** Recreates the AudioTrack so a new mode or a newly plugged DAC takes effect now (set by the service). */
    Runnable reopen = () -> {};

    private final AudioDeviceCallback devices = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            boolean usb = false;
            for (AudioDeviceInfo device : added) usb |= device.isSink() && "usb".equals(kindOf(device));
            if (usb && !SHARED.equals(mode)) reopen.run(); else publish();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            for (AudioDeviceInfo device : removed) {
                if (requestedDevice != null && requestedDevice.getId() == device.getId()) { requested = null; requestedDevice = null; }
            }
            publish();
        }
    };

    AudioOutputState(Context context) {
        this.context = context;
        audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        delegate = new AudioTrackAudioOutputProvider.Builder(context).build();
        mode = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(MODE_KEY, SHARED);
        audio.registerAudioDeviceCallback(devices, main);
        current = this;
    }

    void close() {
        audio.unregisterAudioDeviceCallback(devices);
        clearRequest();
        if (current == this) current = null;
    }

    void setMode(String next) {
        if (!SHARED.equals(next) && !MATCH.equals(next) && !BIT_PERFECT.equals(next)) throw new IllegalArgumentException("Unknown USB mode " + next);
        mode = next;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(MODE_KEY, next).apply();
        if (SHARED.equals(next)) clearRequest();
        reopen.run();
        publish();
    }

    void onTrackInitialized(AudioSink.AudioTrackConfig config) { stream = config; publish(); }

    void onTrackReleased(AudioSink.AudioTrackConfig config) {
        // A format change opens the new track before the old one's release is reported.
        AudioSink.AudioTrackConfig open = stream;
        if (open != null && open.encoding == config.encoding && open.sampleRate == config.sampleRate && open.channelConfig == config.channelConfig) {
            stream = null;
            publish();
        }
    }

    void publish() {
        Consumer<JSObject> sink = listener;
        if (sink != null) sink.accept(snapshot());
    }

    // ---- AudioOutputProvider: ExoPlayer's own AudioTrack provider, with the mixer request made first ----

    @Override
    public FormatSupport getFormatSupport(FormatConfig formatConfig) { return delegate.getFormatSupport(formatConfig); }

    @Override
    public OutputConfig getOutputConfig(FormatConfig formatConfig) throws ConfigurationException { return delegate.getOutputConfig(formatConfig); }

    @Override
    public AudioOutput getAudioOutput(OutputConfig config) throws InitializationException {
        requestMixer(config);
        return delegate.getAudioOutput(config);
    }

    @Override
    public void addListener(Listener listener) { delegate.addListener(listener); }

    @Override
    public void removeListener(Listener listener) { delegate.removeListener(listener); }

    @Override
    public void setClock(Clock clock) { delegate.setClock(clock); }

    @Override
    public boolean hasPendingReleases() { return delegate.hasPendingReleases(); }

    @Override
    public void release() { delegate.release(); }

    // ---- USB mixer attributes (Android 14+) ----

    private void requestMixer(OutputConfig config) {
        if (Build.VERSION.SDK_INT < 34) return;
        AudioDeviceInfo usb = usbDevice();
        AudioMixerAttributes pick = usb == null || SHARED.equals(mode) || config.isOffload || config.isTunneling
            ? null : pick(audio.getSupportedMixerAttributes(usb), config);
        if (pick != null && usb.equals(requestedDevice) && pick.equals(requested)) return;
        clearRequest();
        if (pick != null && audio.setPreferredMixerAttributes(MEDIA, usb, pick)) {
            requested = pick;
            requestedDevice = usb;
        }
    }

    /** Bit-perfect needs a format equal to the stream; otherwise the mixer at the stream's rate, the stream's own encoding first. */
    private AudioMixerAttributes pick(List<AudioMixerAttributes> supported, OutputConfig config) {
        if (BIT_PERFECT.equals(mode)) {
            for (AudioMixerAttributes candidate : supported) {
                if (candidate.getMixerBehavior() == AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT && fits(candidate.getFormat(), config, true)) return candidate;
            }
        }
        AudioMixerAttributes best = null;
        for (AudioMixerAttributes candidate : supported) {
            if (candidate.getMixerBehavior() != AudioMixerAttributes.MIXER_BEHAVIOR_DEFAULT || !fits(candidate.getFormat(), config, false)) continue;
            if (best == null || rank(candidate.getFormat().getEncoding(), config.encoding) > rank(best.getFormat().getEncoding(), config.encoding)) best = candidate;
        }
        return best;
    }

    private static boolean fits(AudioFormat format, OutputConfig config, boolean sameEncoding) {
        return format.getSampleRate() == config.sampleRate && format.getChannelMask() == config.channelMask
            && (!sameEncoding || format.getEncoding() == config.encoding);
    }

    private static int rank(int encoding, int streamEncoding) {
        if (encoding == streamEncoding) return 10;
        switch (encoding) {
            case AudioFormat.ENCODING_PCM_FLOAT: return 5;
            case AudioFormat.ENCODING_PCM_32BIT: return 4;
            case AudioFormat.ENCODING_PCM_24BIT_PACKED: return 3;
            default: return 1;
        }
    }

    private void clearRequest() {
        AudioDeviceInfo device = requestedDevice;
        if (Build.VERSION.SDK_INT >= 34 && device != null) {
            try { audio.clearPreferredMixerAttributes(MEDIA, device); } catch (RuntimeException ignored) {
                // The DAC was unplugged; the system already dropped the request with it.
            }
        }
        requested = null;
        requestedDevice = null;
    }

    private AudioDeviceInfo usbDevice() {
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if ("usb".equals(kindOf(device))) return device;
        }
        return null;
    }

    // ---- The snapshot the web shows ----

    JSObject snapshot() {
        JSObject out = new JSObject();
        AudioDeviceInfo device = routedDevice();
        String kind = device == null ? null : kindOf(device);
        if (device != null) {
            JSObject json = new JSObject();
            json.put("kind", kind);
            if ("usb".equals(kind) || "bluetooth".equals(kind)) json.put("name", device.getProductName().toString());
            out.put("device", json);
        }

        AudioSink.AudioTrackConfig track = stream;
        if (track != null) {
            JSObject json = new JSObject();
            json.put("encoding", encodingName(track.encoding));
            json.put("sampleRate", track.sampleRate);
            json.put("channels", Integer.bitCount(track.channelConfig));
            json.put("offload", track.offload);
            out.put("stream", json);
        }

        JSObject mixer = new JSObject();
        mixer.put("matched", false);
        mixer.put("bitPerfect", false);
        if ("speaker".equals(kind) || "wired".equals(kind)) {
            String rate = audio.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);
            try { if (rate != null) mixer.put("sampleRate", Integer.parseInt(rate)); } catch (NumberFormatException ignored) {
                // An unreadable property leaves the rate unknown.
            }
        } else if (Build.VERSION.SDK_INT >= 34 && device != null && requested != null && device.equals(requestedDevice)) {
            // Only Lutstra's own request counts: another app's preferred attributes do not apply to this app's audio.
            AudioMixerAttributes active = audio.getPreferredMixerAttributes(MEDIA, device);
            if (active != null && active.equals(requested)) {
                AudioFormat format = active.getFormat();
                mixer.put("sampleRate", format.getSampleRate());
                mixer.put("encoding", encodingName(format.getEncoding()));
                mixer.put("matched", true);
                mixer.put("bitPerfect", active.getMixerBehavior() == AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT && track != null
                    && track.encoding == format.getEncoding() && track.sampleRate == format.getSampleRate() && track.channelConfig == format.getChannelMask());
            }
        }
        out.put("mixer", mixer);

        out.put("usbMode", mode);
        out.put("usbCapable", Build.VERSION.SDK_INT >= 34);
        AudioDeviceInfo usb = Build.VERSION.SDK_INT >= 34 ? usbDevice() : null;
        if (usb != null) {
            boolean match = false;
            boolean bitPerfect = false;
            for (AudioMixerAttributes candidate : audio.getSupportedMixerAttributes(usb)) {
                match |= candidate.getMixerBehavior() == AudioMixerAttributes.MIXER_BEHAVIOR_DEFAULT;
                bitPerfect |= candidate.getMixerBehavior() == AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT;
            }
            JSObject json = new JSObject();
            json.put("name", usb.getProductName().toString());
            json.put("match", match);
            json.put("bitPerfect", bitPerfect);
            out.put("usb", json);
        }
        return out;
    }

    private AudioDeviceInfo routedDevice() {
        if (Build.VERSION.SDK_INT < 33) return null;
        // Media can be routed to two devices at once; name the one you hear. While another app captures playback
        // (a screen mirror), media goes to its remote submix only, and that is what is reported.
        List<AudioDeviceInfo> routed = audio.getAudioDevicesForAttributes(MEDIA);
        for (AudioDeviceInfo device : routed) {
            if (!"other".equals(kindOf(device)) && !"capture".equals(kindOf(device))) return device;
        }
        return routed.isEmpty() ? null : routed.get(0);
    }

    static String kindOf(AudioDeviceInfo device) {
        switch (device.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "speaker";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_LINE_ANALOG:
                return "wired";
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_ACCESSORY:
                return "usb";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
            case AudioDeviceInfo.TYPE_BLE_BROADCAST:
                return "bluetooth";
            case AudioDeviceInfo.TYPE_REMOTE_SUBMIX:
                return "capture";
            default:
                return "other";
        }
    }

    private static String encodingName(int encoding) {
        switch (encoding) {
            case AudioFormat.ENCODING_PCM_16BIT: return "pcm16";
            case AudioFormat.ENCODING_PCM_24BIT_PACKED: return "pcm24";
            case AudioFormat.ENCODING_PCM_32BIT: return "pcm32";
            case AudioFormat.ENCODING_PCM_FLOAT: return "float";
            default: return Objects.toString(encoding);
        }
    }
}
