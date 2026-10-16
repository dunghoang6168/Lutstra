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
    path: 'library',
    data: { title: 'Library' },
    loadComponent: () => import('./pages/library/phone-library.component').then((m) => m.PhoneLibraryComponent),
  },
  {
    // ponytail: the desktop Settings page until the phone Settings page (P3).
    path: 'settings',
    data: { title: 'Settings' },
    loadComponent: () => import('../features/settings/settings.component').then((m) => m.SettingsComponent),
  },
  { path: '**', redirectTo: 'home' },
];
