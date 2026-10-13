import { Subject } from 'rxjs';
import { PopularityBatchSummary, PopularityGateway, PopularityProgress, TrackPopularity } from '../contracts';

export class MockPopularityGateway implements PopularityGateway {
  private readonly progress = new Subject<PopularityProgress>();
  readonly progress$ = this.progress.asObservable();
  private cancelled = false;

  async getPopularity(_trackIds: string[]): Promise<TrackPopularity[]> {
    return [];
  }

  async fetchPopularity(trackIds: string[]): Promise<PopularityBatchSummary> {
    this.cancelled = false;
    let fetched = 0;
    for (const trackId of trackIds) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.cancelled) break;
      this.progress.next({ done: ++fetched, total: trackIds.length, result: mockResult(trackId) });
    }
    return { fetched, failed: 0, cancelled: this.cancelled };
  }

  async cancelFetch(): Promise<void> {
    this.cancelled = true;
  }
}

function mockResult(trackId: string): TrackPopularity {
  const seed = [...trackId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
  const matched = seed % 5 !== 0;
  return {
    trackId,
    status: matched ? 'matched' : 'unmatched',
    views: matched ? seed % 50_000_000 : null,
    videoTitle: matched ? 'Mock upload' : null,
    channel: matched ? 'Mock - Topic' : null,
    url: null,
    fetchedAt: Date.now(),
  };
}
