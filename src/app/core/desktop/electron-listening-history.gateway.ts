import { ListeningHistoryGateway } from '../contracts';
import { HistoryEntry, HistoryPageRequest, PlayEvent } from '../models';
import { getDesktopApi } from './desktop-api';

export class ElectronListeningHistoryGateway implements ListeningHistoryGateway {
  record(event: PlayEvent): Promise<void> {
    return this.api().record(event);
  }

  list(request: HistoryPageRequest): Promise<HistoryEntry[]> {
    return this.api().list(request);
  }

  events(): Promise<PlayEvent[]> {
    return this.api().events();
  }

  clear(): Promise<void> {
    return this.api().clear();
  }

  private api() {
    const api = getDesktopApi();
    if (!api) throw new Error('Electron desktop API is unavailable');
    return api.history;
  }
}
