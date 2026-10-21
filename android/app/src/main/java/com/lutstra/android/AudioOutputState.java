package com.lutstra.android;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothCodecConfig;
import android.bluetooth.BluetoothCodecStatus;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioRouting;
import android.media.AudioTrack;
import android.util.Log;
import androidx.core.content.ContextCompat;
import androidx.media3.exoplayer.audio.AudioTrackAudioOutput;
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
    /** The newest AudioTrack, for the device it is routed to. */
    private volatile AudioTrack audioTrack;
    /** The Bluetooth codec, from the system's codec broadcast (needs BLUETOOTH_CONNECT); null until one arrives. */
    private volatile BluetoothCodecConfig codec;
    private final BroadcastReceiver codecReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            BluetoothCodecStatus status = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(BluetoothCodecStatus.EXTRA_CODEC_STATUS, BluetoothCodecStatus.class)
                : intent.getParcelableExtra(BluetoothCodecStatus.EXTRA_CODEC_STATUS);
            codec = status == null ? null : status.getCodecConfig();
            publish();
        }
    };
    /** The mixer attributes Lutstra asked for, and on which device. */
    private volatile Object requested;
    private volatile AudioDeviceInfo requestedDevice;
    /** Recreates the AudioTrack so a new mode or a newly plugged DAC takes effect now (set by the service). */
    Runnable reopen = () -> {};

    private final AudioDeviceCallback devices = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            boolean usb = false;
            boolean bluetooth = false;
            for (AudioDeviceInfo device : added) {
                usb |= device.isSink() && "usb".equals(kindOf(device));
                bluetooth |= device.isSink() && "bluetooth".equals(kindOf(device));
            }
            if (bluetooth && codecWatched) readCodecNow();
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
        enableCodec();
        current = this;
    }

    private boolean codecWatched;

    /** Starts following the Bluetooth codec once BLUETOOTH_CONNECT is granted (at start, or when Settings asks for it). */
    void enableCodec() {
        if (codecWatched || !canReadCodec()) return;
        codecWatched = true;
        ContextCompat.registerReceiver(context, codecReceiver, new IntentFilter(CODEC_CHANGED), ContextCompat.RECEIVER_EXPORTED);
        readCodecNow();
    }

    /** The A2DP codec broadcast is not in the SDK, but it is sent to apps holding BLUETOOTH_CONNECT. */
    private static final String CODEC_CHANGED = "android.bluetooth.a2dp.profile.action.CODEC_CONFIG_CHANGED";

    private boolean canReadCodec() {
        return Build.VERSION.SDK_INT >= 31
            && ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    /** The codec broadcast only comes on a change; the current one is asked for once (a hidden call, which may be refused). */
    private void readCodecNow() {
        BluetoothManager manager = context.getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) return;
        adapter.getProfileProxy(context, new BluetoothProfile.ServiceListener() {
            @Override
            public void onServiceConnected(int profile, BluetoothProfile proxy) {
                try {
                    for (BluetoothDevice device : proxy.getConnectedDevices()) {
                        Object status = proxy.getClass().getMethod("getCodecStatus", BluetoothDevice.class).invoke(proxy, device);
                        if (status instanceof BluetoothCodecStatus) { codec = ((BluetoothCodecStatus) status).getCodecConfig(); publish(); }
                    }
                } catch (ReflectiveOperationException | RuntimeException error) {
                    // A later Android may close the hidden call; the codec broadcast still updates it on a change.
                    Log.w("LutstraOutput", "getCodecStatus refused: " + error);
                } finally {
                    adapter.closeProfileProxy(BluetoothProfile.A2DP, proxy);
                }
            }

            @Override
            public void onServiceDisconnected(int profile) {}
        }, BluetoothProfile.A2DP);
    }

    void close() {
        audio.unregisterAudioDeviceCallback(devices);
        if (codecWatched) context.unregisterReceiver(codecReceiver);
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

    /** Whether Lutstra asked the USB DAC for its bit-perfect mixer; the EQ leaves the samples alone then. */
    boolean bitPerfectRequested() {
        Object request = requested;
        return Build.VERSION.SDK_INT >= 34 && request instanceof AudioMixerAttributes
            && ((AudioMixerAttributes) request).getMixerBehavior() == AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT;
    }

    /** The MediaCodec decoder ExoPlayer opened (e.g. c2.android.flac.decoder), for the Audio path sheet. */
    private volatile String decoder;

    void onDecoderInitialized(String name) { decoder = name; publish(); }

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
        AudioOutput output = delegate.getAudioOutput(config);
        if (output instanceof AudioTrackAudioOutput) {
            // The track's own route is the truth; the policy's answer can be empty (a direct output) or a capture.
            AudioTrack track = ((AudioTrackAudioOutput) output).getAudioTrack();
            track.addOnRoutingChangedListener((AudioRouting.OnRoutingChangedListener) router -> publish(), main);
            audioTrack = track;
        }
        return output;
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
            // The PCM formats the device takes; one integer format alone is what it receives (the speaker's 16-bit).
            com.getcapacitor.JSArray encodings = new com.getcapacitor.JSArray();
            for (int encoding : device.getEncodings()) encodings.put(encodingName(encoding));
            json.put("encodings", encodings);
            out.put("device", json);
        }
        BluetoothCodecConfig link = codec;
        if ("bluetooth".equals(kind) && link != null) {
            JSObject json = new JSObject();
            json.put("codec", codecName(link));
            json.put("sampleRate", bitRate(link.getSampleRate(), new int[] { 44100, 48000, 88200, 96000, 176400, 192000 }));
            json.put("bits", bitRate(link.getBitsPerSample(), new int[] { 16, 24, 32 }));
            if (link.getCodecType() == BluetoothCodecConfig.SOURCE_CODEC_TYPE_LDAC) {
                // LDAC's codec-specific value 1: 1000 quality (990 kbps), 1001 normal (660), 1002 connection (330), 1003 adaptive.
                long quality = link.getCodecSpecific1();
                if (quality >= 1000 && quality <= 1003) json.put("ldac", new String[] { "990", "660", "330", "adaptive" }[(int) (quality - 1000)]);
            }
            out.put("bluetooth", json);
        }

        if (decoder != null) out.put("decoder", decoder);
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

        out.put("codecAccess", Build.VERSION.SDK_INT < 31 ? "unsupported" : canReadCodec() ? "granted" : "needed");
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
        AudioTrack track = audioTrack;
        if (track != null && stream != null) {
            try {
                AudioDeviceInfo device = track.getRoutedDevice();
                if (device != null) return device;
            } catch (RuntimeException ignored) {
                // A released track has no route; ask the policy instead.
            }
        }
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

    /** The codec's own name where the system has one (LHDC, aptX Adaptive), else the SDK constant's. */
    private static String codecName(BluetoothCodecConfig config) {
        if (Build.VERSION.SDK_INT >= 34 && config.getExtendedCodecType() != null) return config.getExtendedCodecType().getCodecName();
        switch (config.getCodecType()) {
            case BluetoothCodecConfig.SOURCE_CODEC_TYPE_SBC: return "SBC";
            case BluetoothCodecConfig.SOURCE_CODEC_TYPE_AAC: return "AAC";
            case BluetoothCodecConfig.SOURCE_CODEC_TYPE_APTX: return "aptX";
            case BluetoothCodecConfig.SOURCE_CODEC_TYPE_APTX_HD: return "aptX HD";
            case BluetoothCodecConfig.SOURCE_CODEC_TYPE_LDAC: return "LDAC";
            default: return "Codec " + config.getCodecType();
        }
    }

    /** A codec field is one bit of a mask (bit 0 = the first value); null when none or several are set. */
    private static Integer bitRate(int mask, int[] values) {
        for (int i = 0; i < values.length; i++) if (mask == 1 << i) return values[i];
        return null;
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
