import { Component, ElementRef, HostListener, Injector, NgZone, afterNextRender, afterRenderEffect, computed, effect, inject, linkedSignal, signal, viewChild } from '@angular/core';
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
import { PhoneLyricsSheetComponent } from '../components/lyrics-sheet/phone-lyrics-sheet.component';
import { AddToPlaylistDialogComponent } from '../../shared/components/add-to-playlist-dialog/add-to-playlist-dialog.component';
import { PhoneLibraryService } from '../phone-library.service';
import { CoverToneService } from '../cover-tone.service';
import { SwipeDirection, SwipeDirective } from '../swipe.directive';
import { RecentPlaysService } from '../../core/layout/recent-plays.service';
import { ThemeService } from '../../core/theme/theme.service';
import { appShell, audioPathOpen, lyricsOpen, pageBack, settledTab } from '../app-shell';
import { focusQuietly } from '../focus';
import { PhoneEqService } from '../eq/phone-eq.service';
import { PhoneHomeComponent } from '../pages/home/phone-home.component';
import { PhoneEqComponent } from '../pages/eq/phone-eq.component';
import { PhoneLibraryComponent } from '../pages/library/phone-library.component';
import { PlayerSheetService, SheetParts } from '../player-sheet.service';

/** Modals other than the shell's own sheets: the folder picker and the dialogs pages open. */
/** Set once the mini player has shown, by a nudge, that it swipes. */
const SWIPE_HINT_KEY = 'lutstra.phone.swipeHintShown';

/** How long after a track first loads Now Playing is built ahead (PixelPlayer's collapsed warm delay). */
const NOW_PLAYING_BUILD_DELAY_MS = 650;

/** How far a finger moves on the mini player before a drag up takes the sheet. */
const MINI_SLOP_PX = 8;
/** How far a finger moves along the nav bar before it drags the pager rather than taps. */
const NAV_SLOP_PX = 10;

const PAGE_MODALS = 'dialog[open], [aria-modal="true"]:not(.phone-sheet), .modal-backdrop, .metadata-modal-backdrop';

/** The Android app's root: app bar, page, mini player and bottom navigation, with Now Playing and the queue as sheets. */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, IconComponent, CoverArtComponent, AndroidFolderPickerComponent,
    PhoneNowPlayingComponent, PhoneQueueSheetComponent, PhoneTrackActionsSheetComponent, PhoneAudioPathSheetComponent, PhoneLyricsSheetComponent, AddToPlaylistDialogComponent, SwipeDirective,
    PhoneHomeComponent, PhoneEqComponent, PhoneLibraryComponent],
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
  private readonly zone = inject(NgZone);
  private readonly miniOpen = viewChild<ElementRef<HTMLButtonElement>>('miniOpen');
  readonly folderPickerRequest = folderPickerRequest;
  readonly audioPathOpen = audioPathOpen;
  readonly lyricsOpen = lyricsOpen;
  /** Mini player and Now Playing as one sheet that follows the finger (player-sheet.service.ts). */
  readonly sheet = inject(PlayerSheetService);
  readonly nowPlayingOpen = this.sheet.open;
  /**
   * Now Playing is built a moment after a track first loads and then kept, after PixelPlayer's full player
   * (FullPlayerCompositionPolicy): building it as a drag starts would cost that drag its first frames.
   */
  readonly nowPlayingBuilt = signal(false);
  private readonly mini = viewChild<ElementRef<HTMLElement>>('mini');
  private readonly scrim = viewChild<ElementRef<HTMLElement>>('scrim');
  private readonly nowPlayingHost = viewChild(PhoneNowPlayingComponent, { read: ElementRef });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly queueOpen = signal(false);
  readonly tabs: { path: string; label: string; icon: IconName }[] = [
    { path: '/home', label: 'Home', icon: 'home' },
    { path: '/eq', label: 'EQ', icon: 'sliders' },
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
  private readonly routeData = computed(() => {
    this.path();
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.data;
  });
  readonly title = computed(() => (this.routeData()['title'] as string | undefined) ?? '');
  /** Resting on the Library: the status bar strip takes its header's tint (and fades back as a swipe leaves it). */
  readonly ownHeader = computed(() => this.onTab() && settledTab() === '/library');
  readonly tone = inject(CoverToneService).tone;

  // The swipe pager of the three main tabs.
  private readonly pager = viewChild.required<ElementRef<HTMLElement>>('pager');
  private readonly nav = viewChild<ElementRef<HTMLElement>>('nav');
  /** The tab under the pager's middle, so it changes halfway through a swipe. */
  readonly tabAt = signal(0);
  /** The nav icon that is lit: the pager's tab, or on another page the tab it belongs to. */
  readonly litTab = computed(() => this.onTab() ? this.tabAt() : this.tabs.findIndex((tab) => tab.path === this.activeTab()));
  /** Tab pages are built once shown or next to the shown one, then kept, so each keeps its scroll and state. */
  readonly built = signal(new Set<number>());
  /** The last URL on each tab (the Library's ?tab and ?folder), so a nav tap or a swipe returns to it. */
  private readonly lastUrl = new Map<number, string>();
  /** A finger is dragging the pager along the nav bar, with snapping off. */
  private navDragging = false;
  /** Where a nav drag sent the pager; snapping comes back on there. */
  private navGlideTo: number | null = null;

  constructor() {
    // Records what plays, for Home's continue listening and recently played.
    inject(RecentPlaysService);
    // Runs the EQ of the current output from the start, not only once the EQ tab opens.
    inject(PhoneEqService);
    this.hintSwipeOnce();
    void this.loadPalette();
    let restoring = false;
    let wasOnTab = false;
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.scrollByUrl.set(this.router.url, this.content().nativeElement.scrollTop);
        restoring = event.navigationTrigger === 'popstate';
      } else if (event instanceof NavigationEnd) {
        // A page link inside a sheet (Go to album from Now Playing) lands on the page, so the sheets give way.
        if (this.sheet.shown()) { this.queueOpen.set(false); this.sheet.closeNow(); }
        const url = event.urlAfterRedirects;
        const tab = this.tabs.findIndex((t) => t.path === url.split(/[?#]/, 1)[0]);
        if (tab >= 0) {
          this.lastUrl.set(tab, url);
          // Tab to tab (a nav tap, Back) slides; arriving from another page jumps.
          const slide = wasOnTab;
          afterNextRender(() => this.showTab(tab, slide), { injector: this.injector });
        } else {
          const top = restoring ? this.scrollByUrl.get(url) ?? 0 : 0;
          afterNextRender(() => { this.content().nativeElement.scrollTop = top; }, { injector: this.injector });
        }
        wasOnTab = tab >= 0;
      }
    });
    // Off the tabs, the pill sits under the tab the page belongs to.
    effect(() => {
      const lit = this.litTab();
      if (!this.onTab()) this.nav()?.nativeElement.style.setProperty('--nav-at', String(lit));
    });
    const sheetParts = (): SheetParts => {
      const sheet: HTMLElement | undefined = this.nowPlayingHost()?.nativeElement;
      return {
        sheet,
        fades: sheet?.querySelectorAll<HTMLElement>('[data-sheet-fade]') ?? [],
        scrim: this.scrim()?.nativeElement,
        mini: this.mini()?.nativeElement,
      };
    };
    this.sheet.attach(sheetParts);
    // Now Playing and its scrim, once made, take the sheet's state before they paint.
    afterRenderEffect(() => { sheetParts(); this.sheet.paint(); });
    const build = effect(() => {
      if (!this.player.currentTrack()) return;
      build.destroy();
      setTimeout(() => this.nowPlayingBuilt.set(true), NOW_PLAYING_BUILD_DELAY_MS);
    });
    this.followMiniDrag();
    afterNextRender(() => this.zone.runOutsideAngular(() => {
      this.followPager(this.pager().nativeElement);
      this.dragNav(this.nav()!.nativeElement, this.pager().nativeElement);
    }));
  }

  /** Moves the pager to a tab the URL names. */
  private showTab(index: number, slide: boolean): void {
    this.build(index);
    const pager = this.pager().nativeElement;
    const left = index * pager.clientWidth;
    if (Math.abs(pager.scrollLeft - left) < 1) { this.rest(index); return; }
    if (slide && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pager.scrollTo({ left, behavior: 'smooth' });
      return;
    }
    pager.scrollLeft = left;
    this.rest(index);
  }

  private rest(index: number): void {
    this.tabAt.set(index);
    settledTab.set(this.tabs[index].path);
    this.nav()?.nativeElement.style.setProperty('--nav-at', String(index));
  }

  private build(index: number): void {
    const wanted = [index - 1, index, index + 1].filter((i) => i >= 0 && i < this.tabs.length);
    if (wanted.every((i) => this.built().has(i))) return;
    this.built.update((built) => new Set([...built, ...wanted]));
  }

  /** Runs outside Angular: a scroll frame only moves the pill, and enters Angular when the lit tab changes. */
  private followPager(pager: HTMLElement): void {
    const nav = this.nav()!.nativeElement;
    pager.addEventListener('scroll', () => {
      const at = pager.scrollLeft / Math.max(1, pager.clientWidth);
      nav.style.setProperty('--nav-at', at.toFixed(4));
      const index = Math.round(at);
      const moving = Math.abs(at - index) * pager.clientWidth >= 1;
      if (index !== this.tabAt() || (moving && settledTab() !== null)) {
        this.zone.run(() => {
          this.tabAt.set(index);
          this.build(index);
          if (moving) settledTab.set(null);
        });
      }
    }, { passive: true });
    // Once the pager settles, the URL names the tab (its last URL), replacing the one it left.
    pager.addEventListener('scrollend', () => {
      if (!this.onTab() || this.navDragging) return;
      if (this.navGlideTo !== null) {
        // Still on the way to where a nav drag sent it (a stray scrollend from the drag itself).
        if (Math.abs(pager.scrollLeft - this.navGlideTo) >= 1) return;
        this.navGlideTo = null;
        pager.style.scrollSnapType = '';
      }
      const index = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
      this.zone.run(() => {
        this.rest(index);
        if (this.path() !== this.tabs[index].path) {
          void this.router.navigateByUrl(this.lastUrl.get(index) ?? this.tabs[index].path, { replaceUrl: true });
        }
      });
    });
  }

  /**
   * A drag along the nav bar moves the pager as a drag on the page would. Snapping is off while the finger drives
   * the scroll position, then the pager glides to the next tab past a fifth of the width, or back.
   */
  private dragNav(nav: HTMLElement, pager: HTMLElement): void {
    let start: { id: number; x: number; left: number } | null = null;
    let swallowClick = false;
    nav.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' || !this.onTab()) return;
      start = { id: event.pointerId, x: event.clientX, left: pager.scrollLeft };
      this.navDragging = swallowClick = false;
    });
    nav.addEventListener('pointermove', (event) => {
      if (event.pointerId !== start?.id) return;
      const dx = event.clientX - start.x;
      if (!this.navDragging) {
        if (Math.abs(dx) < NAV_SLOP_PX) return;
        this.navDragging = true;
        nav.setPointerCapture(event.pointerId);
        pager.style.scrollSnapType = 'none';
      }
      pager.scrollLeft = start.left - dx;
    });
    const end = (event: PointerEvent): void => {
      if (event.pointerId !== start?.id) return;
      if (this.navDragging) {
        this.navDragging = false;
        swallowClick = true;
        const width = pager.clientWidth;
        const from = Math.round(start.left / width);
        const dx = event.clientX - start.x;
        const to = Math.min(this.tabs.length - 1, Math.max(0, Math.abs(dx) > width * 0.2 ? from - Math.sign(dx) : from));
        if (Math.abs(pager.scrollLeft - to * width) < 1) {
          pager.style.scrollSnapType = '';
        } else {
          // The pager's scrollend turns snapping back on once it gets there.
          this.navGlideTo = to * width;
          pager.scrollTo({ left: this.navGlideTo, behavior: 'smooth' });
        }
      }
      start = null;
    };
    // A finger on the page mid-glide takes over, with snapping back on.
    pager.addEventListener('pointerdown', () => {
      if (this.navGlideTo === null) return;
      this.navGlideTo = null;
      pager.style.scrollSnapType = '';
    });
    nav.addEventListener('pointerup', end);
    nav.addEventListener('pointercancel', end);
    // Capture runs before the item's own click, so a drag never also counts as a tap.
    nav.addEventListener('click', (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }

  /** A nav tap goes back to where that tab was left. */
  goTab(index: number, event: MouseEvent): void {
    event.preventDefault();
    void this.router.navigateByUrl(this.lastUrl.get(index) ?? this.tabs[index].path);
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
    this.sheet.expand();
  }

  /**
   * A drag up on the mini player pulls Now Playing up with it, after PixelPlayer's; sideways stays the swipe to
   * change track (the first clear direction decides). Pointer events, outside Angular: the card does not pan.
   */
  private followMiniDrag(): void {
    let start: { id: number; x: number; y: number; from: number } | null = null;
    let dragging = false;
    let swallowClick = false;
    let samples: { y: number; t: number }[] = [];
    const release = (event: PointerEvent): void => {
      if (event.pointerId !== start?.id) return;
      const dy = event.clientY - start.y;
      start = null;
      if (!dragging) return;
      dragging = false;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 400);
      const first = samples[0];
      const vy = event.timeStamp > first.t ? (event.clientY - first.y) / (event.timeStamp - first.t) * 1000 : 0;
      this.sheet.endDrag(dy, vy);
    };
    this.zone.runOutsideAngular(() => {
      this.host.addEventListener('pointerdown', (event) => {
        const onMini = (event.target as Element).closest('.mini-player');
        start = onMini && event.pointerType !== 'mouse' && !this.sheet.shown()
          ? { id: event.pointerId, x: event.clientX, y: event.clientY, from: 0 } : null;
        dragging = false;
        samples = [{ y: event.clientY, t: event.timeStamp }];
      });
      this.host.addEventListener('pointermove', (event) => {
        if (event.pointerId !== start?.id) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!dragging) {
          if (Math.abs(dx) < MINI_SLOP_PX && Math.abs(dy) < MINI_SLOP_PX) return;
          // Sideways is the track swipe's, and a pull down has nothing to open.
          if (Math.abs(dx) >= Math.abs(dy) || dy > 0) { start = null; return; }
          dragging = true;
          this.mini()?.nativeElement.setPointerCapture(event.pointerId);
          start.from = this.sheet.beginDrag();
        }
        samples = [...samples.filter((sample) => event.timeStamp - sample.t < 100), { y: event.clientY, t: event.timeStamp }];
        this.sheet.dragTo(start.from, dy);
      });
      this.host.addEventListener('pointerup', release);
      this.host.addEventListener('pointercancel', release);
    });
    // Capture runs before the card's own click, so a drag never also opens it or presses a button on it.
    this.host.addEventListener('click', (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
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

  /** The close button, Back, or a drag down let go (which has already sent the sheet on its way). */
  closeNowPlaying(): void {
    this.queueOpen.set(false);
    if (this.sheet.open()) this.sheet.collapse();
    // The card sits in the page, which stays inert until the sheet is down.
    const watch = effect(() => {
      if (this.sheet.covering()) return;
      watch.destroy();
      afterNextRender(() => focusQuietly(this.miniOpen()?.nativeElement), { injector: this.injector });
    }, { injector: this.injector });
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
    if (pageBack()?.()) return;
    if (this.path() === '/home') void appShell.moveToBack();
    else if (this.onTab()) void this.router.navigateByUrl('/home');
    else this.location.back();
  }
}
