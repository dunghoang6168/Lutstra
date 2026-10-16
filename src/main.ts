import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { getDesktopApi } from './app/core/desktop/desktop-api';
import { Capacitor } from '@capacitor/core';

document.documentElement.setAttribute('data-runtime', getDesktopApi() ? 'desktop' : 'web');

// Android gets its own phone shell over the same services; desktop and the browser keep the desktop shell.
const root = Capacitor.getPlatform() === 'android'
  ? import('./app/phone/shell/phone-app.component').then((m) => m.PhoneAppComponent)
  : Promise.resolve(AppComponent);

root.then((component) => bootstrapApplication(component, appConfig))
  .catch((err) => console.error(err));
