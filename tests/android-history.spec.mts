import { describe, expect, it, vi } from 'vitest';
import { AndroidListeningHistoryGateway } from '../src/app/core/android/android-listening-history.gateway';
import type { PlayEvent } from '../src/app/core/models';

describe('Android listening history gateway', () => {
  it('passes listens to the native store and flattens the page cursor', async () => {
    const native = {
      record: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ entries: [{ id: 3, trackId: 'a', startedAt: 10 }] })),
      events: vi.fn(async () => ({ events: [] as PlayEvent[] })),
      clear: vi.fn(async () => undefined),
    };
    const gateway = new AndroidListeningHistoryGateway(native);
    const event = { trackId: 'a', startedAt: 10, playedSeconds: 1, endPosition: 1, duration: 2, seekForwardSeconds: 0,
      startedBy: 'user', endReason: 'ended', source: 'queue' } as PlayEvent;
    await gateway.record(event);
    expect(native.record).toHaveBeenCalledWith(event);
    expect(await gateway.list({ limit: 50 })).toEqual([{ id: 3, trackId: 'a', startedAt: 10 }]);
    expect(native.list).toHaveBeenLastCalledWith({ limit: 50 });
    await gateway.list({ limit: 50, before: { startedAt: 10, id: 3 } });
    expect(native.list).toHaveBeenLastCalledWith({ limit: 50, beforeStartedAt: 10, beforeId: 3 });
  });
});
