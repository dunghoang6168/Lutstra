import { ListeningHistoryGateway } from '../contracts';
import { HistoryEntry, HistoryPageRequest, PlayEvent, shownInHistory } from '../models';

/** Browser and Android: kept in memory, so the log starts empty on every launch. */
export class MockListeningHistoryGateway implements ListeningHistoryGateway {
  private events: Array<PlayEvent & { id: number }> = [];
  private nextId = 1;

  async record(event: PlayEvent): Promise<void> {
    this.events.push({ ...event, id: this.nextId++ });
  }

  async list(request: HistoryPageRequest): Promise<HistoryEntry[]> {
    const before = request.before;
    return this.events
      .filter((event) => shownInHistory(event))
      .filter((event) => !before || event.startedAt < before.startedAt || (event.startedAt === before.startedAt && event.id < before.id))
      .sort((a, b) => b.startedAt - a.startedAt || b.id - a.id)
      .slice(0, request.limit)
      .map(({ id, trackId, startedAt }) => ({ id, trackId, startedAt }));
  }

  async clear(): Promise<void> {
    this.events = [];
  }
}
