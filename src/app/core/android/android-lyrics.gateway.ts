import { LyricsGateway } from '../contracts';
import { androidFolders } from './android-folder-selection';
import { AndroidLibraryGateway } from './android-library.gateway';

/** Lyrics from the "<same name>.lrc" next to each file, as on the desktop; the scan finds them, the plugin reads them. */
export class AndroidLyricsGateway implements LyricsGateway {
  constructor(private readonly library: AndroidLibraryGateway) {}

  async getLyrics(trackId: string): Promise<string | null> {
    const uri = this.library.lyricsUriOf(trackId);
    return uri ? (await androidFolders.readLyrics({ uri })).text ?? null : null;
  }

  async findTracksWithLyrics(trackIds: string[]): Promise<string[]> {
    return trackIds.filter((id) => this.library.lyricsUriOf(id));
  }
}
