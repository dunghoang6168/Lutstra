import { Observable } from 'rxjs';
import { PopularityBatchSummary, PopularityGateway, PopularityProgress, TrackPopularity } from '../contracts';
import { getDesktopApi } from './desktop-api';

export class ElectronPopularityGateway implements PopularityGateway {
  readonly progress$ = new Observable<PopularityProgress>((subscriber) =>
    getDesktopApi()?.popularity.onProgress((progress) => subscriber.next(progress)));

  getPopularity(trackIds: string[]): Promise<TrackPopularity[]> {
    const api = getDesktopApi();
    if (!api) return Promise.reject(new Error('Electron desktop API is unavailable'));
    return api.popularity.get(trackIds);
  }

  fetchPopularity(trackIds: string[]): Promise<PopularityBatchSummary> {
    const api = getDesktopApi();
    if (!api) return Promise.reject(new Error('Electron desktop API is unavailable'));
    return api.popularity.fetchBatch(trackIds);
  }

  async cancelFetch(): Promise<void> {
    await getDesktopApi()?.popularity.cancel();
  }
}
