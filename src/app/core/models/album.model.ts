export interface Album {
  id: string;
  title: string;
  artist: string | null;
  year: number | null;
  artwork: string | null;
  artworkSmall?: string | null;
  artworkMedium?: string | null;
  trackIds: string[];
}
