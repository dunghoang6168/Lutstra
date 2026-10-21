package com.lutstra.android;

/**
 * Lutstra's EQ maths: preamp, a cascade of RBJ biquads (Audio EQ Cookbook, transposed direct form II, in double so
 * a 31 Hz band stays accurate at high rates) and an optional crossfeed for headphones. The web works out what to
 * run (matched gains, auto preamp, the effects as filters); this only runs it.
 */
final class EqDsp {
    static final int PEAK = 0;
    static final int LOW_SHELF = 1;
    static final int HIGH_SHELF = 2;

    static final class Filter {
        final int type;
        final double freq;
        final double gainDb;
        final double q;

        Filter(int type, double freq, double gainDb, double q) {
            this.type = type;
            this.freq = freq;
            this.gainDb = gainDb;
            this.q = q;
        }
    }

    /** What to run; immutable, swapped whole by the plugin so the audio thread never sees half an update. */
    static final class Spec {
        static final Spec FLAT = new Spec(0, new Filter[0], 0);
        final double preampDb;
        final Filter[] filters;
        /** 0..1: how much of each channel, low-passed, feeds the other. */
        final double crossfeed;

        Spec(double preampDb, Filter[] filters, double crossfeed) {
            this.preampDb = preampDb;
            this.filters = filters;
            this.crossfeed = crossfeed;
        }

        boolean isFlat() {
            if (preampDb != 0 || crossfeed > 0) return false;
            for (Filter filter : filters) if (filter.gainDb != 0) return false;
            return true;
        }
    }

    /** The spec every sink runs; set by the plugin. */
    static volatile Spec spec = Spec.FLAT;

    private static final double CROSSFEED_HZ = 700;
    /** At 100 % the other channel arrives about 6 dB down, as bs2b's strongest preset. */
    private static final double CROSSFEED_MAX_GAIN = 0.5;

    private Spec applied;
    private int rate;
    private int channels;
    private double preamp = 1;
    /** Per active filter: b0, b1, b2, a1, a2 (a0 normalised). */
    private double[][] coefficients = new double[0][];
    /** Per active filter and channel: z1, z2. */
    private double[][] state = new double[0][];
    private double crossfeedGain;
    private double crossfeedPole;
    private double lowLeft;
    private double lowRight;

    volatile long frames;
    volatile long nanos;
    volatile long clippedSamples;
    volatile float peak;

    void configure(int sampleRate, int channelCount) {
        rate = sampleRate;
        channels = channelCount;
        applied = null;
    }

    boolean hasWork() {
        return !spec.isFlat();
    }

    void reset() {
        for (double[] z : state) { z[0] = 0; z[1] = 0; }
        lowLeft = lowRight = 0;
    }

    /** Processes `count` interleaved float samples in place. */
    void process(float[] samples, int count) {
        long start = System.nanoTime();
        Spec current = spec;
        if (current != applied) rebuild(current);
        int n = channels;
        int filterCount = coefficients.length;
        boolean crossfeed = crossfeedGain > 0 && n == 2;
        double norm = 1 / (1 + crossfeedGain);
        float max = 0;
        long clipped = 0;
        for (int i = 0; i + n <= count; i += n) {
            if (crossfeed) {
                double left = samples[i];
                double right = samples[i + 1];
                lowLeft = (1 - crossfeedPole) * left + crossfeedPole * lowLeft;
                lowRight = (1 - crossfeedPole) * right + crossfeedPole * lowRight;
                samples[i] = (float) ((left + crossfeedGain * lowRight) * norm);
                samples[i + 1] = (float) ((right + crossfeedGain * lowLeft) * norm);
            }
            for (int c = 0; c < n; c++) {
                double x = samples[i + c] * preamp;
                for (int f = 0; f < filterCount; f++) {
                    double[] k = coefficients[f];
                    double[] z = state[f * n + c];
                    double y = k[0] * x + z[0];
                    z[0] = k[1] * x - k[3] * y + z[1];
                    z[1] = k[2] * x - k[4] * y;
                    x = y;
                }
                float out = (float) x;
                samples[i + c] = out;
                float abs = Math.abs(out);
                if (abs > max) max = abs;
                if (abs > 1f) clipped++;
            }
        }
        frames += count / Math.max(1, n);
        clippedSamples += clipped;
        if (max > peak) peak = max;
        nanos += System.nanoTime() - start;
    }

    /** New coefficients for a new spec or rate. Filter state carries over when the band count stays, so a slider drag does not click. */
    private void rebuild(Spec next) {
        int active = 0;
        for (Filter filter : next.filters) if (runs(filter)) active++;
        double[][] nextCoefficients = new double[active][];
        int index = 0;
        for (Filter filter : next.filters) if (runs(filter)) nextCoefficients[index++] = coefficients(filter, rate);
        if (nextCoefficients.length != coefficients.length || state.length != active * channels) {
            state = new double[active * channels][2];
        }
        coefficients = nextCoefficients;
        preamp = Math.pow(10, next.preampDb / 20);
        crossfeedGain = Math.max(0, Math.min(1, next.crossfeed)) * CROSSFEED_MAX_GAIN;
        crossfeedPole = Math.exp(-2 * Math.PI * CROSSFEED_HZ / Math.max(1, rate));
        applied = next;
    }

    /** A 0 dB band does nothing, and one at or above 0.45 × the rate cannot be built stably. */
    private boolean runs(Filter filter) {
        return filter.gainDb != 0 && filter.freq > 0 && filter.freq < 0.45 * rate;
    }

    static double[] coefficients(Filter filter, int sampleRate) {
        double a = Math.pow(10, filter.gainDb / 40);
        double w0 = 2 * Math.PI * filter.freq / sampleRate;
        double cos = Math.cos(w0);
        double alpha = Math.sin(w0) / (2 * filter.q);
        double b0, b1, b2, a0, a1, a2;
        if (filter.type == LOW_SHELF) {
            double s = 2 * Math.sqrt(a) * alpha;
            b0 = a * ((a + 1) - (a - 1) * cos + s);
            b1 = 2 * a * ((a - 1) - (a + 1) * cos);
            b2 = a * ((a + 1) - (a - 1) * cos - s);
            a0 = (a + 1) + (a - 1) * cos + s;
            a1 = -2 * ((a - 1) + (a + 1) * cos);
            a2 = (a + 1) + (a - 1) * cos - s;
        } else if (filter.type == HIGH_SHELF) {
            double s = 2 * Math.sqrt(a) * alpha;
            b0 = a * ((a + 1) + (a - 1) * cos + s);
            b1 = -2 * a * ((a - 1) + (a + 1) * cos);
            b2 = a * ((a + 1) + (a - 1) * cos - s);
            a0 = (a + 1) - (a - 1) * cos + s;
            a1 = 2 * ((a - 1) - (a + 1) * cos);
            a2 = (a + 1) - (a - 1) * cos - s;
        } else {
            b0 = 1 + alpha * a;
            b1 = -2 * cos;
            b2 = 1 - alpha * a;
            a0 = 1 + alpha / a;
            a1 = -2 * cos;
            a2 = 1 - alpha / a;
        }
        return new double[] { b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0 };
    }
}
