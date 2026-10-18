/** A position the player reported, and when (performance.now() milliseconds). */
export interface PlayheadSample {
  seconds: number;
  at: number;
}

/**
 * Where the playhead is now: the player reports every 500 ms on Android, so between reports the timeline
 * runs on from the last one at 1:1 while playing, never past the end; paused, it stays put.
 */
export function playheadAt(sample: PlayheadSample, now: number, playing: boolean, duration: number): number {
  if (!playing) return sample.seconds;
  const seconds = sample.seconds + Math.max(0, now - sample.at) / 1000;
  return duration > 0 ? Math.min(seconds, duration) : seconds;
}
