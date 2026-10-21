package com.lutstra.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Test;

public class EqDspTest {
    @After
    public void restore() {
        EqDsp.spec = EqDsp.Spec.FLAT;
    }

    /** |H(e^jw)| in dB from normalised biquad coefficients. */
    private static double responseDb(double[] k, double freq, int rate) {
        double w = 2 * Math.PI * freq / rate;
        double nr = k[0] + k[1] * Math.cos(w) + k[2] * Math.cos(2 * w);
        double ni = -k[1] * Math.sin(w) - k[2] * Math.sin(2 * w);
        double dr = 1 + k[3] * Math.cos(w) + k[4] * Math.cos(2 * w);
        double di = -k[3] * Math.sin(w) - k[4] * Math.sin(2 * w);
        return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
    }

    @Test
    public void peakHitsItsGainAtTheCentre() {
        for (int rate : new int[] { 44100, 48000, 96000, 192000 }) {
            double[] k = EqDsp.coefficients(new EqDsp.Filter(EqDsp.PEAK, 31, 6, 1.41), rate);
            assertEquals("31 Hz at " + rate, 6, responseDb(k, 31, rate), 1e-6);
        }
        double[] cut = EqDsp.coefficients(new EqDsp.Filter(EqDsp.PEAK, 4000, -9, 1.41), 48000);
        assertEquals(-9, responseDb(cut, 4000, 48000), 1e-6);
        assertEquals(0, responseDb(cut, 40, 48000), 0.05);
    }

    @Test
    public void shelvesReachTheirGainFarFromTheCorner() {
        double[] low = EqDsp.coefficients(new EqDsp.Filter(EqDsp.LOW_SHELF, 90, 9, 0.707), 48000);
        assertEquals(9, responseDb(low, 10, 48000), 0.1);
        assertEquals(0, responseDb(low, 5000, 48000), 0.05);
        double[] high = EqDsp.coefficients(new EqDsp.Filter(EqDsp.HIGH_SHELF, 10000, 4, 0.707), 48000);
        assertEquals(4, responseDb(high, 22000, 48000), 0.2);
        assertEquals(0, responseDb(high, 100, 48000), 0.05);
    }

    @Test
    public void flatIsFlat() {
        assertTrue(EqDsp.Spec.FLAT.isFlat());
        assertTrue(new EqDsp.Spec(0, new EqDsp.Filter[] { new EqDsp.Filter(EqDsp.PEAK, 1000, 0, 1.41) }, 0).isFlat());
        assertFalse(new EqDsp.Spec(-1, new EqDsp.Filter[0], 0).isFlat());
        assertFalse(new EqDsp.Spec(0, new EqDsp.Filter[0], 0.3).isFlat());
    }

    @Test
    public void preampScalesEverySample() {
        EqDsp.spec = new EqDsp.Spec(-6, new EqDsp.Filter[0], 0);
        EqDsp dsp = new EqDsp();
        dsp.configure(48000, 2);
        float[] samples = { 0.5f, -0.5f, 1f, -1f };
        dsp.process(samples, samples.length);
        double gain = Math.pow(10, -6 / 20.0);
        assertEquals(0.5 * gain, samples[0], 1e-6);
        assertEquals(-1 * gain, samples[3], 1e-6);
    }

    @Test
    public void aSineAtABandsCentreComesOutAtItsGain() {
        int rate = 48000;
        EqDsp.spec = new EqDsp.Spec(0, new EqDsp.Filter[] { new EqDsp.Filter(EqDsp.PEAK, 1000, 6.0206, 1.41) }, 0);
        EqDsp dsp = new EqDsp();
        dsp.configure(rate, 1);
        float[] samples = new float[rate];
        for (int i = 0; i < samples.length; i++) samples[i] = (float) (0.25 * Math.sin(2 * Math.PI * 1000 * i / rate));
        dsp.process(samples, samples.length);
        float peak = 0;
        for (int i = rate / 2; i < rate; i++) peak = Math.max(peak, Math.abs(samples[i]));
        assertEquals(0.5, peak, 0.002);
        assertEquals(0, dsp.clippedSamples);
    }

    @Test
    public void crossfeedLeavesMonoAlone() {
        EqDsp.spec = new EqDsp.Spec(0, new EqDsp.Filter[0], 1);
        EqDsp dsp = new EqDsp();
        dsp.configure(48000, 2);
        float[] samples = new float[4800];
        for (int i = 0; i < samples.length; i += 2) samples[i] = samples[i + 1] = 0.3f;
        dsp.process(samples, samples.length);
        // A centred (mono) signal keeps its level once the low-pass has settled.
        assertEquals(0.3, samples[samples.length - 2], 1e-3);
        assertEquals(samples[samples.length - 2], samples[samples.length - 1], 1e-9);
    }
}
