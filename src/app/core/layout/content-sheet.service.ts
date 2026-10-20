import { Injectable, signal } from '@angular/core';

/**
 * Set by a page that fills the content sheet with its own interface (an embedded site): the header folds
 * the library search into its icon, Lutstra's player shows only while it plays, and Console drops its
 * inspector, so the page keeps the room.
 */
@Injectable({ providedIn: 'root' })
export class ContentSheetService {
  readonly embedded = signal(false);
}
