import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { PopularityBatchSummary, PopularityProgress, TrackPopularity } from '../../src/app/core/contracts/popularity.gateway.js';
import type { Track } from '../../src/app/core/models/index.js';
import { DatabaseService } from './database.service.js';
import { chunkByLength, fallbackQuery, groupByQuery, pickVideo, searchQuery, type YoutubeEntry } from '../utils/youtube-match.js';

// One results page holds about 20, so 10 costs no more than 5 and reaches uploads ranked lower.
const SEARCH_RESULTS = 10;
// Queries go on the command line (yt-dlp reads stdin in the wrong code page on Windows), so each
// process takes a chunk that stays well under Windows' 32767-character command line.
const CHUNK_CHARS = 8000;
// Signs that YouTube is throttling; the batch stops and the cache keeps what is done.
const THROTTLED = /HTTP Error 429|Too Many Requests|Sign in to confirm/i;

/**
 * Developer-mode experiment: YouTube views of tracks through the user-installed yt-dlp binary, cached in
 * the database. One yt-dlp process searches a chunk of about a hundred tracks (one JSON line per query
 * out), so its ~1 s start-up is paid once per chunk instead of once per track.
 */
export class PopularityService {
  private running = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private cancelled = false;

  constructor(private readonly database: DatabaseService, private readonly onProgress: (progress: PopularityProgress) => void) {}

  get(trackIds: string[]): TrackPopularity[] {
    return this.database.getTrackPopularity(trackIds);
  }

  async fetchBatch(trackIds: string[]): Promise<PopularityBatchSummary> {
    if (this.running) throw new Error('A views fetch is already running');
    this.running = true;
    this.cancelled = false;
    try {
      const tracks = trackIds.flatMap((id) => this.database.getTrackById(id) ?? []);
      let fetched = 0;
      const missed: Track[] = [];
      const lastError = await this.search(groupByQuery(tracks, searchQuery), (track, result) => {
        if (result.status === 'unmatched') missed.push(track);
        this.database.saveTrackPopularity(result);
        this.onProgress({ done: ++fetched, total: tracks.length, result });
      }, () => fetched);
      // Second chance with a shorter query; only a match replaces the first result.
      const retry = missed.filter((track) => fallbackQuery(track.artist, track.title));
      if (retry.length && !this.cancelled) {
        await this.search(groupByQuery(retry, (artist, title) => fallbackQuery(artist, title)!), (_track, result) => {
          if (result.status !== 'matched') return;
          this.database.saveTrackPopularity(result);
          this.onProgress({ done: fetched, total: tracks.length, result });
        }, () => fetched);
      }
      if (!fetched && !this.cancelled && lastError) throw new Error(`yt-dlp failed: ${lastError.replace(/^ERROR:\s*/, '')}`);
      return { fetched, failed: this.cancelled ? 0 : tracks.length - fetched, cancelled: this.cancelled };
    } finally {
      this.running = false;
    }
  }

  cancel(): void {
    this.cancelled = true;
    if (this.child) killTree(this.child);
  }

  /** Searches every query in chunks, handing each track's result to `onResult`; returns yt-dlp's last error line. */
  private async search(groups: Map<string, Track[]>, onResult: (track: Track, result: TrackPopularity) => void, saved: () => number): Promise<string> {
    let lastError = '';
    for (const queries of chunkByLength([...groups.keys()], CHUNK_CHARS)) {
      if (this.cancelled) break;
      const outcome = await this.searchChunk(queries, (query, entries) => {
        for (const track of groups.get(query) ?? []) onResult(track, toPopularity(track, entries));
      });
      if (outcome.throttled) throw new Error(`YouTube is throttling searches; ${saved()} tracks were saved. Try again later.`);
      lastError = outcome.lastError || lastError;
    }
    return lastError;
  }

  /** Runs one yt-dlp process over these queries, handing each search result to `onResult` as it arrives. */
  private async searchChunk(queries: string[], onResult: (query: string, entries: YoutubeEntry[]) => void): Promise<{ throttled: boolean; lastError: string }> {
    const wanted = new Set(queries);
    const child = await spawnYtDlp(['--flat-playlist', '-J', '--no-warnings', '--ignore-errors', ...queries.map((query) => `ytsearch${SEARCH_RESULTS}:${query}`)]);
    this.child = child;
    let throttled = false;
    let lastError = '';
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.startsWith('ERROR:')) lastError = line;
      if (THROTTLED.test(line) && !throttled) {
        throttled = true;
        killTree(child);
      }
    });
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (this.cancelled) break;
        if (!line.startsWith('{')) continue;
        let search: { id?: string; entries?: YoutubeEntry[] };
        try { search = JSON.parse(line); } catch { continue; }
        // A search result's id is its query text.
        if (!search.id || !wanted.delete(search.id)) continue;
        onResult(search.id, search.entries ?? []);
      }
    } finally {
      if (this.cancelled) killTree(child);
      this.child = null;
    }
    return { throttled, lastError };
  }
}

function toPopularity(track: Track, entries: readonly YoutubeEntry[]): TrackPopularity {
  const video = pickVideo(entries, track.title, track.duration, track.artist);
  return {
    trackId: track.id,
    status: video ? 'matched' : 'unmatched',
    views: video?.view_count ?? null,
    videoTitle: video?.title ?? null,
    channel: video?.channel ?? video?.uploader ?? null,
    url: video ? video.url ?? (video.id ? `https://www.youtube.com/watch?v=${video.id}` : null) : null,
    fetchedAt: Date.now(),
  };
}

// The winget yt-dlp.exe unpacks itself and runs a second process, so killing the first leaves the
// search running; take the whole tree down.
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill();
}

// An Electron started from an older shell may miss the WinGet links folder on PATH.
const YT_DLP_CANDIDATES = ['yt-dlp', ...(process.env['LOCALAPPDATA'] ? [path.join(process.env['LOCALAPPDATA'], 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe')] : [])];

async function spawnYtDlp(args: string[]): Promise<ChildProcessWithoutNullStreams> {
  for (const command of YT_DLP_CANDIDATES) {
    // No shell: each query is one argv entry that starts with "ytsearch", so track titles cannot inject options or commands.
    const child = spawn(command, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    const started = await new Promise<boolean>((resolve, reject) => {
      child.once('spawn', () => resolve(true));
      child.once('error', (error) => (error as NodeJS.ErrnoException).code === 'ENOENT' ? resolve(false) : reject(error));
    });
    if (started) return child;
  }
  throw new Error('yt-dlp was not found. Install it with: winget install yt-dlp.yt-dlp');
}
