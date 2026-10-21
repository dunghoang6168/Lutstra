package com.lutstra.android;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.ForwardingAudioSink;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Runs the EQ on PCM before DefaultAudioSink. Media3 1.11 drops app audio processors from the chain when float
 * output is on and the PCM is high resolution (every file here, since MediaCodec decodes to float), so the EQ
 * cannot be an AudioProcessor. With a flat spec, or a bit-perfect USB mixer, buffers pass through untouched.
 *
 * DefaultAudioSink wants the same buffer back until it has taken all of it, so a processed copy is kept until the
 * sink has consumed it, and the caller's buffer advances by what the sink took.
 */
@OptIn(markerClass = UnstableApi.class)
final class EqAudioSink extends ForwardingAudioSink {
    /** The one the playback service built; the plugin reads its stats (same process). */
    static volatile EqAudioSink current;

    final EqDsp dsp = new EqDsp();
    private final AudioOutputState output;
    private boolean pcm;
    private int encoding = C.ENCODING_INVALID;
    private ByteBuffer copy;
    private float[] work = new float[0];
    /** The caller's buffer while a processed copy of it is still being taken. */
    private ByteBuffer copySource;
    /** The caller's buffer while it is being handed through as is. */
    private ByteBuffer directSource;

    EqAudioSink(AudioSink sink, AudioOutputState output) {
        super(sink);
        this.output = output;
        current = this;
    }

    boolean running() {
        return pcm && (encoding == C.ENCODING_PCM_FLOAT || encoding == C.ENCODING_PCM_16BIT) && dsp.hasWork() && !output.bitPerfectRequested();
    }

    @Override
    public void configure(AudioSinkConfig audioSinkConfig) throws ConfigurationException {
        Format format = audioSinkConfig.format;
        pcm = MimeTypes.AUDIO_RAW.equals(format.sampleMimeType);
        encoding = format.pcmEncoding;
        dsp.configure(format.sampleRate, format.channelCount);
        copySource = directSource = null;
        super.configure(audioSinkConfig);
    }

    @Override
    public boolean handleBuffer(ByteBuffer buffer, long presentationTimeUs, int encodedAccessUnitCount) throws InitializationException, WriteException {
        boolean continuingCopy = copySource == buffer && copy != null && copy.hasRemaining();
        boolean continuingDirect = directSource == buffer && buffer.hasRemaining();
        if (!continuingCopy && (continuingDirect || !running() || !buffer.hasRemaining())) {
            copySource = null;
            boolean done = super.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount);
            directSource = done ? null : buffer;
            return done;
        }
        if (!continuingCopy) {
            fillCopy(buffer);
            copySource = buffer;
            directSource = null;
        }
        boolean done = super.handleBuffer(copy, presentationTimeUs, encodedAccessUnitCount);
        buffer.position(buffer.limit() - copy.remaining());
        if (done) copySource = null;
        return done;
    }

    /** Copies the caller's remaining PCM, processed, into `copy` (same encoding and size). */
    private void fillCopy(ByteBuffer buffer) {
        int bytes = buffer.remaining();
        if (copy == null || copy.capacity() < bytes) copy = ByteBuffer.allocateDirect(Math.max(bytes, 16 * 1024)).order(ByteOrder.nativeOrder());
        copy.clear();
        ByteBuffer in = buffer.duplicate().order(ByteOrder.nativeOrder());
        if (encoding == C.ENCODING_PCM_FLOAT) {
            int count = bytes / 4;
            if (work.length < count) work = new float[count];
            in.asFloatBuffer().get(work, 0, count);
            dsp.process(work, count);
            copy.asFloatBuffer().put(work, 0, count);
            copy.limit(count * 4);
        } else {
            int count = bytes / 2;
            if (work.length < count) work = new float[count];
            for (int i = 0; i < count; i++) work[i] = in.getShort() / 32768f;
            dsp.process(work, count);
            for (int i = 0; i < count; i++) copy.putShort((short) Math.max(-32768, Math.min(32767, Math.round(work[i] * 32768f))));
            copy.flip();
        }
        copy.position(0);
    }

    @Override
    public void flush() {
        copySource = directSource = null;
        dsp.reset();
        super.flush();
    }

    @Override
    public void reset() {
        copySource = directSource = null;
        dsp.reset();
        super.reset();
    }
}
