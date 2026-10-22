import { Routes } from '@angular/router';

/** `data.title` is the phone app bar's heading. */
export const phoneRoutes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  {
    path: 'home',
    data: { title: 'Home' },
    loadComponent: () => import('./pages/home/phone-home.component').then((m) => m.PhoneHomeComponent),
  },
  {
    path: 'search',
    data: { title: 'Search' },
    loadComponent: () => import('./pages/search/phone-search.component').then((m) => m.PhoneSearchComponent),
  },
  {
    path: 'eq',
    data: { title: 'EQ' },
    loadComponent: () => import('./pages/eq/phone-eq.component').then((m) => m.PhoneEqComponent),
  },
  {
    path: 'library',
    data: { title: 'Library', ownHeader: true },
    loadComponent: () => import('./pages/library/phone-library.component').then((m) => m.PhoneLibraryComponent),
  },
  {
    path: 'library/albums/:id',
    data: { title: 'Album' },
    loadComponent: () => import('./pages/album/phone-album.component').then((m) => m.PhoneAlbumComponent),
  },
  {
    path: 'library/artists/:id',
    data: { title: 'Artist' },
    loadComponent: () => import('./pages/artist/phone-artist.component').then((m) => m.PhoneArtistComponent),
  },
  {
    path: 'library/playlists/:id',
    data: { title: 'Playlist' },
    loadComponent: () => import('./pages/playlist/phone-playlist.component').then((m) => m.PhonePlaylistComponent),
  },
  {
    path: 'settings',
    data: { title: 'Settings' },
    loadComponent: () => import('./pages/settings/phone-settings.component').then((m) => m.PhoneSettingsComponent),
  },
  { path: '**', redirectTo: 'home' },
];
