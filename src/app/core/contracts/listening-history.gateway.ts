import { InjectionToken } from '@angular/core';
import { HistoryEntry, HistoryPageRequest, PlayEvent } from '../models';

export interface ListeningHistoryGateway {
  record(event: PlayEvent): Promise<void>;
  /** Only listens that `shownInHistory` keeps, newest first. */
  list(request: HistoryPageRequest): Promise<HistoryEntry[]>;
  clear(): Promise<void>;
}

export const LISTENING_HISTORY_GATEWAY = new InjectionToken<ListeningHistoryGateway>('LISTENING_HISTORY_GATEWAY');
