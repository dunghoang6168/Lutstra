#pragma once
#include <array>
#include <cmath>
#include <cstddef>

// Bands follow the RBJ Audio EQ Cookbook. Type: 0 peak, 1 low shelf, 2 high shelf.
struct EqBand { int type{}; double freq{}, gainDb{}, q{}; };

struct EqSettings {
  static constexpr size_t kMaxBands = 15;
  bool enabled{};
  double preampDb{};
  std::array<EqBand, kMaxBands> bands{};
  size_t count{};
};

// Biquads in transposed direct form II with double coefficients and state:
// float loses the 25 Hz band at 192 kHz. Render owns it; nothing here allocates.
class Equalizer {
public:
  // ponytail: channels past 8 pass through unfiltered; no Windows mix format here goes beyond 7.1.
  static constexpr size_t kMaxChannels = 8;

  // A changed gain swaps coefficients but keeps the band's state, so a slider drag
  // does not restart the filter. A new rate or a band coming back on starts clean.
  void configure(const EqSettings &settings, int rate) noexcept {
    if (rate != rate_) {
      state_ = {};
      rate_ = rate;
    }
    const auto previous = on_;
    on_ = {};
    active_ = 0;
    preamp_ = settings.enabled ? std::pow(10.0, settings.preampDb / 20) : 1.0;
    if (!settings.enabled || rate <= 0)
      return;
    for (size_t i = 0; i < settings.count && i < EqSettings::kMaxBands; ++i) {
      const EqBand &band = settings.bands[i];
      // Near Nyquist the bilinear transform warps a band beyond use; skip it.
      if (band.gainDb == 0 || band.freq <= 0 || band.freq >= 0.45 * rate || band.q <= 0)
        continue;
      coefficients_[i] = design(band, rate);
      on_[i] = true;
      order_[active_++] = i;
      if (!previous[i])
        state_[i] = {};
    }
  }

  // Flat and at 0 dB preamp, the signal is untouched and stays bit-identical.
  bool active() const noexcept { return active_ > 0 || preamp_ != 1.0; }

  void process(float *samples, size_t frames, size_t channels) noexcept {
    if (!active())
      return;
    const size_t filtered = channels < kMaxChannels ? channels : kMaxChannels;
    for (size_t frame = 0; frame < frames; ++frame) {
      for (size_t channel = 0; channel < filtered; ++channel) {
        float &sample = samples[frame * channels + channel];
        double x = sample * preamp_;
        for (size_t k = 0; k < active_; ++k) {
          const size_t band = order_[k];
          const Coefficients &c = coefficients_[band];
          State &s = state_[band][channel];
          const double y = c.b0 * x + s.z1;
          s.z1 = c.b1 * x - c.a1 * y + s.z2;
          s.z2 = c.b2 * x - c.a2 * y;
          x = y;
        }
        sample = static_cast<float>(x);
      }
    }
  }

private:
  struct Coefficients { double b0{1}, b1{}, b2{}, a1{}, a2{}; };
  struct State { double z1{}, z2{}; };

  static Coefficients design(const EqBand &band, int rate) noexcept {
    constexpr double pi = 3.14159265358979323846;
    const double a = std::pow(10.0, band.gainDb / 40);
    const double w0 = 2 * pi * band.freq / rate;
    const double cosw = std::cos(w0), alpha = std::sin(w0) / (2 * band.q);
    double b0, b1, b2, a0, a1, a2;
    if (band.type == 1 || band.type == 2) {
      const double root = 2 * std::sqrt(a) * alpha, sign = band.type == 1 ? 1 : -1;
      b0 = a * ((a + 1) - sign * (a - 1) * cosw + root);
      b1 = sign * 2 * a * ((a - 1) - sign * (a + 1) * cosw);
      b2 = a * ((a + 1) - sign * (a - 1) * cosw - root);
      a0 = (a + 1) + sign * (a - 1) * cosw + root;
      a1 = -sign * 2 * ((a - 1) + sign * (a + 1) * cosw);
      a2 = (a + 1) + sign * (a - 1) * cosw - root;
    } else {
      b0 = 1 + alpha * a;
      b1 = -2 * cosw;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cosw;
      a2 = 1 - alpha / a;
    }
    return {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
  }

  std::array<Coefficients, EqSettings::kMaxBands> coefficients_{};
  std::array<std::array<State, kMaxChannels>, EqSettings::kMaxBands> state_{};
  std::array<bool, EqSettings::kMaxBands> on_{};
  std::array<size_t, EqSettings::kMaxBands> order_{};
  size_t active_{};
  double preamp_{1};
  int rate_{};
};
