import { Component, ElementRef, HostListener, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationEnd, NavigationStart, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { registerPlugin } from '@capacitor/core';
import { filter, map } from 'rxjs';
import { PlayerService } from '../../core/player/player.service';
import { QueueActionsService } from '../../core/player/queue-actions.service';
import { folderPickerRequest } from '../../core/android/android-folder-selection';
import { formatTrackFormat } from '../../features/home/library-quality';
import { IconComponent, IconName } from '../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../shared/components/cover-art/cover-art.component';
import { AndroidFolderPickerComponent } from '../../shared/components/android-folder-picker/android-folder-picker.component';
import { PhoneNowPlayingComponent } from '../components/now-playing/phone-now-playing.component';
import { PhoneQueueSheetComponent } from '../components/queue-sheet/phone-queue-sheet.component';
import { PhoneTrackActionsSheetComponent } from '../components/track-actions-sheet/phone-track-actions-sheet.component';
import { AddToPlaylistDialogComponent } from '../../shared/components/add-to-playlist-dialog/add-to-playlist-dialog.component';
import { PhoneLibraryService } from '../phone-library.service';

const appShell = registerPlugin<{ moveToBack(): Promise<void> }>('AppShell');

/** Modals other than the shell's own sheets: the folder picker and the dialogs pages open. */
const PAGE_MODALS = 'dialog[open], [aria-modal="true"]:not(.phone-sheet), .modal-backdrop, .metadata-modal-backdrop';

/** The Android app's root: app bar, page, mini player and bottom navigation, with Now Playing and the queue as sheets. */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, CoverArtComponent, AndroidFolderPickerComponent,
    PhoneNowPlayingComponent, PhoneQueueSheetComponent, PhoneTrackActionsSheetComponent, AddToPlaylistDialogComponent],
  templateUrl: './phone-app.component.html',
  styleUrl: './phone-app.component.scss',
})
export class PhoneAppComponent {
  readonly player = inject(PlayerService);
  readonly queueActions = inject(QueueActionsService);
  readonly library = inject(PhoneLibraryService);
  private readonly content = viewChild.required<ElementRef<HTMLElement>>('content');
  /** The page scrolls inside the shell, not the window, so the shell keeps each URL's offset for Back. */
  private readonly scrollByUrl = new Map<string, number>();
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly injector = inject(Injector);
  private readonly miniOpen = viewChild<ElementRef<HTMLButtonElement>>('miniOpen');
  readonly folderPickerRequest = folderPickerRequest;
  readonly nowPlayingOpen = signal(false);
  readonly queueOpen = signal(false);
  readonly tabs: { path: string; label: string; icon: IconName }[] = [
    { path: '/home', label: 'Home', icon: 'home' },
    { path: '/search', label: 'Search', icon: 'search' },
    { path: '/library', label: 'Library', icon: 'list-music' },
  ];

  private readonly path = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects.split(/[?#]/, 1)[0]),
    ),
    { initialValue: this.router.url.split(/[?#]/, 1)[0] },
  );
  readonly onTab = computed(() => this.tabs.some((tab) => tab.path === this.path()));
  readonly title = computed(() => {
    this.path();
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return (route.data['title'] as string | undefined) ?? '';
  });
  readonly format = computed(() => {
    const track = this.player.currentTrack();
    return track ? formatTrackFormat(track) : null;
  });

  constructor() {
    let restoring = false;
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.scrollByUrl.set(this.router.url, this.content().nativeElement.scrollTop);
        restoring = event.navigationTrigger === 'popstate';
      } else if (event instanceof NavigationEnd) {
        const top = restoring ? this.scrollByUrl.get(event.urlAfterRedirects) ?? 0 : 0;
        afterNextRender(() => { this.content().nativeElement.scrollTop = top; }, { injector: this.injector });
      }
    });
  }

  openNowPlaying(): void {
    this.nowPlayingOpen.set(true);
  }

  closeNowPlaying(): void {
    this.queueOpen.set(false);
    this.nowPlayingOpen.set(false);
    afterNextRender(() => this.miniOpen()?.nativeElement.focus(), { injector: this.injector });
  }

  goBack(): void {
    this.location.back();
  }

  /** Android Back: close the top modal or sheet, then go back a page; on Home the app moves to the background. */
  @HostListener('window:lutstraback')
  onBack(): void {
    const modal = [...document.querySelectorAll<HTMLElement>(PAGE_MODALS)].filter((el) => el.checkVisibility()).at(-1);
    if (modal) {
      // Every dialog already closes on Escape, so Back sends one to it.
      const active = document.activeElement;
      const target = active instanceof HTMLElement && modal.contains(active) ? active : modal;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return;
    }
    if (this.queueOpen()) { this.queueOpen.set(false); return; }
    if (this.nowPlayingOpen()) { this.closeNowPlaying(); return; }
    if (this.path() === '/home') void appShell.moveToBack();
    else if (this.onTab()) void this.router.navigateByUrl('/home');
    else this.location.back();
  }
}
