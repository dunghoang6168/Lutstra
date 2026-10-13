import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

/** YouTube views of a track, looked up with yt-dlp (developer mode experiment). */
export interface TrackPopularity {
  trackId: string;
  status: 'matched' | 'unmatched';
  views: number | null;
  videoTitle: string | null;
  channel: string | null;
  url: string | null;
  fetchedAt: number;
}

/** One track of a running batch is done; `done` counts tracks, `total` is the batch size. */
export interface PopularityProgress {
  done: number;
  total: number;
  result: TrackPopularity;
}

export interface PopularityBatchSummary {
  fetched: number;
  /** Tracks whose search returned nothing (an error, not "no match"); they stay uncached. */
  failed: number;
  cancelled: boolean;
}

export interface PopularityGateway {
  /** Cached results only; never goes online. */
  getPopularity(trackIds: string[]): Promise<TrackPopularity[]>;
  /** Searches YouTube for these tracks in one batch, caching each result as it arrives on `progress$`. */
  fetchPopularity(trackIds: string[]): Promise<PopularityBatchSummary>;
  cancelFetch(): Promise<void>;
  readonly progress$: Observable<PopularityProgress>;
}

export const POPULARITY_GATEWAY = new InjectionToken<PopularityGateway>('POPULARITY_GATEWAY');
