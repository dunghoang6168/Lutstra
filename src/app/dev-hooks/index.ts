import { EnvironmentProviders, Provider, Type } from '@angular/core';
import { Routes } from '@angular/router';
import type { NativeMediaKeyAction } from '../core/desktop/desktop-api';
import type { DevMenu, FolderExtension } from './dev-hooks.types';

/*
 * The seam for the developer edition (AGENTS.md, "Editions"). The public build ships this stub, which adds
 * nothing; the full build swaps in dev/renderer/index.ts (angular.json `full` configuration), which exports
 * the same names.
 */

export const devRoutes: Routes = [];
export const devProviders: (Provider | EnvironmentProviders)[] = [];
export const devMenu: DevMenu | null = null;
/** Settings › About: the heading's content (null: the plain title) and an item after the others. */
export const devAboutHeading: Type<unknown> | null = null;
export const devAboutItem: Type<unknown> | null = null;
/** Inside the shell's content sheet beside the routed page, for a page that must outlive navigation. */
export const devShellContent: Type<unknown> | null = null;
export const devFolderExtension: FolderExtension | null = null;
/** Offered each media key first; true when the developer edition handled it (a webview was the last to play). */
export const devMediaKey: ((action: NativeMediaKeyAction) => boolean) | null = null;
