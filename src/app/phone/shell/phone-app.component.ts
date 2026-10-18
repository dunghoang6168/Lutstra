import { Component, ElementRef, HostListener, Injector, afterNextRender, computed, effect, inject, linkedSignal, signal, viewChild } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationEnd, NavigationStart, Router, RouterLink, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { PlayerService } from '../../core/player/player.service';
import { QueueActionsService } from '../../core/player/queue-actions.service';
import { folderPickerRequest } from '../../core/android/android-folder-selection';
import { IconComponent, IconName } from '../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../shared/components/cover-art/cover-art.component';
import { AndroidFolderPickerComponent } from '../../shared/components/android-folder-picker/android-folder-picker.component';
import { PhoneNowPlayingComponent } from '../components/now-playing/phone-now-playing.component';
import { PhoneQueueSheetComponent } from '../components/queue-sheet/phone-queue-sheet.component';
import { PhoneTrackActionsSheetComponent } from '../components/track-actions-sheet/phone-track-actions-sheet.component';
import { PhoneAudioPathSheetComponent } from '../components/audio-path-sheet/phone-audio-path-sheet.component';
import { AddToPlaylistDialogComponent } from '../../shared/components/add-to-playlist-dialog/add-to-playlist-dialog.component';
import { PhoneLibraryService } from '../phone-library.service';
import { CoverToneService } from '../cover-tone.service';
import { SwipeDirection, SwipeDirective } from '../swipe.directive';
import { RecentPlaysService } from '../../core/layout/recent-plays.service';
import { ThemeService } from '../../core/theme/theme.service';
import { appShell, audioPathOpen } from '../app-shell';
import { focusQuietly } from '../focus';

/** Modals other than the shell's own sheets: the folder picker and the dialogs pages open. */
/** Set once the mini player has shown, by a nudge, that it swipes. */
const SWIPE_HINT_KEY = 'lutstra.phone.swipeHintShown';

const PAGE_MODALS = 'dialog[open], [aria-modal="true"]:not(.phone-sheet), .modal-backdrop, .metadata-modal-backdrop';

/** The Android app's root: app bar, page, mini player and bottom navigation, with Now Playing and the queue as sheets. */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, IconComponent, CoverArtComponent, AndroidFolderPickerComponent,
    PhoneNowPlayingComponent, PhoneQueueSheetComponent, PhoneTrackActionsSheetComponent, PhoneAudioPathSheetComponent, AddToPlaylistDialogComponent, SwipeDirective],
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
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly injector = inject(Injector);
  private readonly miniOpen = viewChild<ElementRef<HTMLButtonElement>>('miniOpen');
  readonly folderPickerRequest = folderPickerRequest;
  readonly audioPathOpen = audioPathOpen;
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
  /** The tab a page belongs to; Settings, which belongs to none, keeps the one it was opened from lit. */
  readonly activeTab = linkedSignal<string, string>({
    source: this.path,
    computation: (path, previous) =>
      this.tabs.find((tab) => path === tab.path || path.startsWith(tab.path + '/'))?.path ?? previous?.value ?? '/home',
  });
  readonly onOwnTab = computed(() => this.path() === this.activeTab() || this.path().startsWith(this.activeTab() + '/'));
  readonly title = computed(() => {
    this.path();
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return (route.data['title'] as string | undefined) ?? '';
  });
  readonly tone = inject(CoverToneService).tone;

  constructor() {
    // Records what plays, for Home's continue listening and recently played.
    inject(RecentPlaysService);
    this.hintSwipeOnce();
    void this.loadPalette();
    let restoring = false;
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.scrollByUrl.set(this.router.url, this.content().nativeElement.scrollTop);
        restoring = event.navigationTrigger === 'popstate';
      } else if (event instanceof NavigationEnd) {
        // A page link inside a sheet (Go to album from Now Playing) lands on the page, so the sheets give way.
        if (this.nowPlayingOpen()) { this.queueOpen.set(false); this.nowPlayingOpen.set(false); }
        const top = restoring ? this.scrollByUrl.get(event.urlAfterRedirects) ?? 0 : 0;
        afterNextRender(() => { this.content().nativeElement.scrollTop = top; }, { injector: this.injector });
      }
    });
  }

  /** The wallpaper may have changed while Lutstra was in the background, so the palette is read again on return. */
  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (!document.hidden) void this.loadPalette();
  }

  private async loadPalette(): Promise<void> {
    try { this.theme.setDynamicPalette((await appShell.getDynamicColors()).palette); } catch { this.theme.setDynamicPalette(null); }
  }

  openNowPlaying(): void {
    this.nowPlayingOpen.set(true);
  }

  /**
   * The first time the mini player appears it nudges left and back, once, so its swipe can be found without
   * words. Reduced motion skips the nudge; the swipe stays described for screen readers.
   */
  private hintSwipeOnce(): void {
    let shown = true;
    try { shown = localStorage.getItem(SWIPE_HINT_KEY) === '1'; } catch { /* no storage: never nudge */ }
    if (shown) return;
    const watch = effect(() => {
      if (!this.player.currentTrack() || this.nowPlayingOpen()) return;
      watch.destroy();
      setTimeout(() => {
        try { localStorage.setItem(SWIPE_HINT_KEY, '1'); } catch { /* best effort */ }
        const mini = this.miniOpen()?.nativeElement;
        if (!mini || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        mini.animate(
          [{ translate: '0 0' }, { translate: '-28px 0', offset: 0.35 }, { translate: '0 0' }],
          { duration: 900, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        );
      }, 1200);
    }, { injector: this.injector });
  }

  /** The mini player swipes like PixelPlayer's: left brings the next track, right the previous one. */
  miniSwiped(direction: SwipeDirection): void {
    if (direction === 'left') this.player.next(); else this.player.previous();
  }

  closeNowPlaying(): void {
    this.queueOpen.set(false);
    this.nowPlayingOpen.set(false);
    afterNextRender(() => focusQuietly(this.miniOpen()?.nativeElement), { injector: this.injector });
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
