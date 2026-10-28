import { Signal, Type, WritableSignal } from '@angular/core';
import type { FolderNode } from '../core/models';

/** An entry of the header's Developer menu. */
export interface DevMenuEntry {
  label: string;
  path: string;
  /** An image URL drawn as a mask, so it takes the text colour. */
  icon: string;
  /** A page that runs in the background (a webview): its switch, locked while the page shows. */
  running?: { on: Signal<boolean>; set(on: boolean): void };
  /** Unread messages on the page: a count badge on the entry and a dot on the menu's button. */
  unread?: Signal<number>;
}

/** The header's Developer menu, beside Settings in every layout. */
export interface DevMenu {
  visible: Signal<boolean>;
  entries: readonly DevMenuEntry[];
}

/** What the open folder in Folders offers to an extension. */
export interface FolderView {
  readonly hasSubfolders: Signal<boolean>;
  /** Every file under the open folder, subfolders included. */
  readonly subtreeFiles: Signal<FolderNode[]>;
  readonly subtreeTrackIds: Signal<string[]>;
  /** Track ids of the files listed. */
  readonly listedTrackIds: Signal<string[]>;
  /** Replaces the file list with other files under a title, each shown with its folder; null restores it. */
  readonly override: WritableSignal<{ title: string; files: Signal<FolderNode[]> } | null>;
}

/** Controls an edition adds to Folders. Each component takes a `folder: FolderView` input. */
export interface FolderExtension {
  /** False hides every part below. */
  visible: Signal<boolean>;
  /** At the start of the toolbar while a folder is open. */
  toolbar: Type<unknown>;
  /** Above the folder content, for progress banners. */
  banner: Type<unknown>;
  /** First among the file list's actions. */
  filesAction: Type<unknown>;
  /** A column after Title; the cell component takes a `trackId: string | null` input. */
  column: { header: string; cell: Type<unknown> };
}
