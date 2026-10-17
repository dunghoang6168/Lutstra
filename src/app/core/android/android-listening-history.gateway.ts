import { registerPlugin } from '@capacitor/core';
import { ListeningHistoryGateway } from '../contracts';
import { HistoryEntry, HistoryPageRequest, PlayEvent } from '../models';

interface NativeHistory {
  record(event: PlayEvent): Promise<void>;
  list(request: { limit: number; beforeStartedAt?: number; beforeId?: number }): Promise<{ entries: HistoryEntry[] }>;
  events(): Promise<{ events: PlayEvent[] }>;
  clear(): Promise<void>;
}

/** The listening history in the app's own SQLite database (AndroidHistoryPlugin), kept across launches like the desktop's. */
export class AndroidListeningHistoryGateway implements ListeningHistoryGateway {
  constructor(private readonly native: NativeHistory = registerPlugin<NativeHistory>('AndroidHistory')) {}

  record(event: PlayEvent): Promise<void> {
    return this.native.record(event);
  }

  async list(request: HistoryPageRequest): Promise<HistoryEntry[]> {
    const { before, limit } = request;
    return (await this.native.list(before ? { limit, beforeStartedAt: before.startedAt, beforeId: before.id } : { limit })).entries;
  }

  async events(): Promise<PlayEvent[]> {
    return (await this.native.events()).events;
  }

  clear(): Promise<void> {
    return this.native.clear();
  }
}
