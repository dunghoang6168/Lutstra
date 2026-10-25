/**
 * Core Track Model
 * Units:
 * - duration: seconds (e.g. 245.5)
 * - sampleRate: Hz (e.g. 96000)
 * - bitrate: bps (e.g. 2814000)
 * - bitDepth: bits (e.g. 24, 16)
 * - fileSize: bytes
 * - lastModified: milliseconds timestamp
 * - unknown fields: null
 */
export interface Track {
  id: string;
  path: string;
  fileName: string;
  title: string;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  duration: number; // in seconds
  codec: string | null; // e.g. 'FLAC', 'MP3', 'WAV', 'M4A', 'Opus', 'OGG'
  bitrate: number | null; // in bps
  sampleRate: number | null; // in Hz
  bitDepth: number | null; // e.g. 16, 24
  channels: number | null; // e.g. 2 (stereo)
  artwork: string | null; // local URI or fixture identifier, no repeated giant base64
  artworkSmall?: string | null;
  artworkMedium?: string | null;
  fileSize: number | null; // in bytes
  lastModified: number | null; // in ms
  isAvailable: boolean; // false if missing / moved / corrupt
}
