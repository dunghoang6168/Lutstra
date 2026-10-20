import type { BrowserWindow, IpcMainInvokeEvent, WebPreferences } from 'electron';
import type { DatabaseService } from './services/database.service.js';

/*
 * The main process's seam for the developer edition (AGENTS.md, "Editions"). The public build ships this
 * stub, which adds nothing; the full build swaps in dev/electron/index.ts (tsup.config.ts), which exports
 * the same names.
 */

export interface DevContext {
  database: DatabaseService;
  getWindow: () => BrowserWindow | null;
  /** Registers an IPC handler behind the same trusted-sender check as the app's own. */
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;
}

/** Extra preferences for the main window. */
export const devWebPreferences: WebPreferences = {};

/** Starts the edition's main-process services and IPC, once the database is open. */
export function installDev(_context: DevContext): void {}

/** Sets up a newly created main window. */
export function installDevWindow(_window: BrowserWindow): void {}
