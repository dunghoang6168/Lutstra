import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow } from 'electron';
import type { NativeMediaKeyAction } from '../src/app/core/desktop/desktop-api.js';

export interface MediaControlsInfo {
  title: string;
  artist: string;
  album: string;
  artworkPath: string | null;
  state: 'playing' | 'paused' | 'none';
}

interface MediaAddon {
  mediaInit(handle: Buffer, onButton: (button: string) => void): boolean;
  mediaUpdate(info: MediaControlsInfo): void;
  mediaDispose(): void;
}

let addon: MediaAddon | null = null;

// Windows SMTC (Quick Settings / lock screen media flyout). Chromium never shows it
// for us because playback runs in the native Audio Host, not in a media element.
export function installMediaControls(window: BrowserWindow, onAction: (action: NativeMediaKeyAction) => void): void {
  if (process.platform !== 'win32') return;
  try {
    const require = createRequire(import.meta.url);
    const native = require(path.join(path.dirname(fileURLToPath(import.meta.url)), 'native', 'window_snap.node')) as MediaAddon;
    if (!native.mediaInit(window.getNativeWindowHandle(), (button) => {
      onAction(button === 'play' || button === 'pause' ? 'play-pause' : button as NativeMediaKeyAction);
    })) return;
    addon = native;
    window.on('closed', () => { native.mediaDispose(); addon = null; });
  } catch (error) {
    console.warn('[media-controls] Windows media flyout integration unavailable.', error);
  }
}

export function updateMediaControls(info: MediaControlsInfo): void {
  addon?.mediaUpdate(info);
}
