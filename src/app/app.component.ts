import { AfterViewChecked, Component, DestroyRef, ElementRef, HostListener, ViewChild, afterNextRender, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AppHeaderComponent } from './shared/components/app-header/app-header.component';
import { SidebarComponent } from './shared/components/sidebar/sidebar.component';
import { PlayerBarComponent } from './shared/components/player-bar/player-bar.component';
import { QueueDrawerComponent } from './shared/components/queue-drawer/queue-drawer.component';
import { TrackDetailsPanelComponent } from './shared/components/track-details-panel/track-details-panel.component';
import { IconComponent } from './shared/components/icon/icon.component';
import { CoverArtComponent } from './shared/components/cover-art/cover-art.component';
import { AndroidFolderPickerComponent } from './shared/components/android-folder-picker/android-folder-picker.component';
import { folderPickerRequest } from './core/android/android-folder-selection';
import { RightPanelService } from './core/layout/right-panel.service';
import { PlayerService } from './core/player/player.service';
import { SmartShuffleService } from './core/smart-shuffle/smart-shuffle.service';
import { QueueActionsService } from './core/player/queue-actions.service';
import { LayoutPreferenceService } from './core/layout/layout-preference.service';
import { ArtworkGlowPositionService } from './core/layout/artwork-glow-position.service';
import { ArtworkEdgeGlowService, EDGE_GLOW_SPREAD } from './core/layout/artwork-edge-glow.service';
import { RecentPlaysService } from './core/layout/recent-plays.service';
import { AcrylicScrollbarService } from './core/layout/acrylic-scrollbar.service';
import { LIBRARY_GATEWAY } from './core/contracts';
import { getDesktopApi } from './core/desktop/desktop-api';
import { ContentSheetService } from './core/layout/content-sheet.service';
import { ThemeService } from './core/theme/theme.service';
import { CoverToneService } from './phone/cover-tone.service';
import { nowPlayingTones } from './phone/cover-tone';
import { devShellContent } from './dev-hooks';

const SIDEBAR_COLLAPSED_KEY = 'lutsra.sidebar.collapsed';
const SIDEBAR_HIDDEN_KEY = 'lutsra.sidebar.hidden';
const RAIL_WIDTH_KEY = 'lutsra.gallery.railWidth';
const RAIL_DEFAULT_WIDTH = 300;
const RAIL_MIN_WIDTH = 240;
const RAIL_MAX_WIDTH = 560;
/** Dragged below RAIL_SNAP_WIDTH (or squeezed by a small window), the rail snaps to its slim column. */
const RAIL_SLIM_WIDTH = 76;
const RAIL_SNAP_WIDTH = 160;
/** Window width kept for the sheet: 480px plus the shell gutters and the rail gap. */
const RAIL_RESERVED_WIDTH = 514;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    AppHeaderComponent,
    SidebarComponent,
    PlayerBarComponent,
    QueueDrawerComponent,
    TrackDetailsPanelComponent,
    IconComponent,
    CoverArtComponent,
    AndroidFolderPickerComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements AfterViewChecked {
  readonly isSidebarCollapsed = signal(readSavedFlag(SIDEBAR_COLLAPSED_KEY));
  readonly isSidebarHidden = signal(readSavedFlag(SIDEBAR_HIDDEN_KEY));
  readonly windowWidth = signal(typeof window !== 'undefined' ? window.innerWidth : 1280);
  readonly rightPanels = inject(RightPanelService);
  readonly player = inject(PlayerService);
  private readonly smartShuffle = inject(SmartShuffleService);
  readonly queueActions = inject(QueueActionsService);
  readonly layoutPreference = inject(LayoutPreferenceService);
  readonly artworkGlowPosition = inject(ArtworkGlowPositionService);
  private readonly artworkEdgeGlow = inject(ArtworkEdgeGlowService);
  private readonly acrylicScrollbars = inject(AcrylicScrollbarService);
  private readonly recentPlays = inject(RecentPlaysService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly libraryGateway = inject(LIBRARY_GATEWAY);
  @ViewChild('onboardingDialog') private onboardingDialog?: ElementRef<HTMLElement>;
  @ViewChild('shortcutsDialog') private shortcutsDialog?: ElementRef<HTMLElement>;
  @ViewChild(PlayerBarComponent) private playerBar?: PlayerBarComponent;
  readonly showShortcuts = signal(false);
  private needsShortcutsFocus = false;
  private needsShortcutsFocusRestore = false;
  private focusBeforeShortcuts: HTMLElement | null = null;
  readonly folderPickerRequest = folderPickerRequest;
  readonly showOnboarding = signal(false);
  readonly onboardingBusy = signal(false);
  readonly onboardingError = signal<string | null>(null);
  private onboardingChecked = false;
  private needsOnboardingFocus = false;
  private needsFocusRestore = false;
  private focusBeforeOnboarding: HTMLElement | null = null;
  readonly edgeGlowSpread = EDGE_GLOW_SPREAD;
  readonly panelGlow = signal<{ source: string; url: string | null } | null>(null);
  private readonly router = inject(Router);
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  readonly isQueueOpen = this.rightPanels.isQueueOpen;
  readonly layout = this.layoutPreference.mode;
  readonly hasTrackOrQueue = computed(() => this.player.currentTrack() !== null || this.player.queue().length > 0);
  private readonly onNowPlaying = computed(() => this.currentUrl().split(/[?#]/, 1)[0] === '/now-playing');
  /** A page that embeds a site sets this; see ContentSheetService. */
  readonly embeddedPage = inject(ContentSheetService).embedded;
  readonly devShellContent = devShellContent;
  /** Ambient lays the playing artwork under every page (unless turned off in Settings), Gallery only on Now Playing,
   *  Console never (no glow). */
  readonly backdropArtwork = computed(() => {
    const artwork = this.player.currentTrack()?.artwork ?? null;
    if (this.layout() === 'classic') return null;
    if (this.layout() === 'liquid-glass' && !this.layoutPreference.ambientArtwork()) return null;
    return this.layout() === 'liquid-glass' || this.onNowPlaying() ? artwork : null;
  });
  /** Ambient's theme-coloured ground for a clear window while there is no artwork to tint it. */
  readonly ambientGround = computed(() => this.layout() === 'liquid-glass' && this.layoutPreference.ambientArtwork());
  private readonly coverTone = inject(CoverToneService).tone;
  private readonly theme = inject(ThemeService);
  /** Now Playing in Gallery and Ambient takes the cover's colours (`.np-tint` in _base.scss), the dock included;
   *  without a readable cover it keeps the accent. */
  readonly nowPlayingTint = computed(() => {
    const tone = this.coverTone();
    if (!tone || !this.onNowPlaying() || this.layout() === 'classic') return null;
    return nowPlayingTones(tone, this.theme.effectiveTheme());
  });
  /** Console's strip is permanent; Gallery's rail and Ambient's dock appear once there is music.
   *  On an embedded page each shows only while Lutstra plays, leaving the room to the page's own player;
   *  it stays through track changes (loading), so the page does not jump. */
  readonly showPlayer = computed(() => {
    if (this.embeddedPage() && !this.player.isPlaying() && !this.player.playIntended()) return false;
    if (this.layout() === 'classic') return true;
    if (!this.hasTrackOrQueue()) return false;
    return this.layout() === 'liquid-glass' || !this.onNowPlaying();
  });
  /** Gallery's rail width as dragged, clamped so the sheet keeps at least 480px. */
  private readonly railWidthPreference = signal(readSavedRailWidth());
  readonly railWidth = computed(() => clampRailWidth(this.railWidthPreference(), this.windowWidth()));
  /** Console's inspector describes library files, so an embedded page goes without it. */
  readonly consoleInspector = computed(() => this.layout() === 'classic' && this.windowWidth() >= 1100 && !this.embeddedPage());
  /** Audio notices dismiss themselves; hover or focus holds the countdown (WCAG 2.2.1). */
  readonly noticeDurationMs = 8000;
  readonly noticePaused = signal(false);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeDeadline = 0;
  private noticeRemaining = 0;

  @HostListener('window:resize')
  onWindowResize(): void {
    this.windowWidth.set(window.innerWidth);
  }

  constructor() {
    afterNextRender(() => this.acrylicScrollbars.start());
    this.destroyRef.onDestroy(() => {
      this.acrylicScrollbars.stop();
      clearTimeout(this.noticeTimer);
    });
    void this.checkOnboarding();
    effect(() => {
      // A JS timer, not animationend: reduced motion collapses animations to 0.01ms.
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
      this.noticePaused.set(false);
      if (!this.player.playbackNotice()) return;
      this.noticeRemaining = this.noticeDurationMs;
      this.startNoticeTimer();
    });
    effect(() => {
      if (this.layoutPreference.mode() !== 'classic' && !this.hasTrackOrQueue()) this.rightPanels.closeQueue();
    });
    effect(() => {
      // Ambient with the artwork backdrop on: a clear window tinted by the blurred cover (or the theme ground
      // before anything plays). Otherwise Acrylic frosts the desktop behind.
      const clear = this.layout() === 'liquid-glass' && this.layoutPreference.ambientArtwork();
      void getDesktopApi()?.windowControls.setMaterial(clear ? 'auto' : 'acrylic').catch(() => undefined);
    });
    effect(() => {
      const artwork = this.backdropArtwork();
      if (!artwork || this.layoutPreference.mode() !== 'inset') {
        this.panelGlow.set(null);
        return;
      }
      // The previous glow stays lit until this one is ready, then crossfades to it.
      void this.artworkEdgeGlow.getGlow(artwork).then((url) => {
        if (this.backdropArtwork() === artwork && this.layoutPreference.mode() === 'inset') {
          this.panelGlow.set({ source: artwork, url });
        }
      });
    });
  }

  pauseNotice(): void {
    if (!this.noticeTimer) return;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    this.noticeRemaining = Math.max(0, this.noticeDeadline - Date.now());
    this.noticePaused.set(true);
  }

  resumeNotice(): void {
    if (!this.noticePaused()) return;
    this.noticePaused.set(false);
    this.startNoticeTimer();
  }

  private startNoticeTimer(): void {
    this.noticeDeadline = Date.now() + this.noticeRemaining;
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      this.player.playbackNotice.set(null);
    }, this.noticeRemaining);
  }

  private async checkOnboarding(): Promise<void> {
    if (!getDesktopApi() || this.onboardingChecked) return;
    this.onboardingChecked = true;
    try {
      if ((await this.libraryGateway.getLibrary()).folders.length === 0) {
        this.focusBeforeOnboarding = document.activeElement as HTMLElement | null;
        this.showOnboarding.set(true);
        this.needsOnboardingFocus = true;
      }
    } catch (error) {
      console.error('[library:onboarding] Failed to inspect folders', error);
    }
  }

  ngAfterViewChecked(): void {
    if (this.needsShortcutsFocusRestore && !this.showShortcuts()) {
      this.needsShortcutsFocusRestore = false;
      if (this.focusBeforeShortcuts?.isConnected) this.focusBeforeShortcuts.focus();
    }
    if (this.needsShortcutsFocus && this.shortcutsDialog) {
      this.needsShortcutsFocus = false;
      this.shortcutsDialog.nativeElement.querySelector<HTMLButtonElement>('button')?.focus();
    }
    if (this.needsFocusRestore && !this.showOnboarding()) {
      this.needsFocusRestore = false;
      if (this.focusBeforeOnboarding?.isConnected) this.focusBeforeOnboarding.focus();
    }
    if (!this.needsOnboardingFocus || !this.onboardingDialog) return;
    this.needsOnboardingFocus = false;
    this.onboardingDialog.nativeElement.querySelector<HTMLButtonElement>('button')?.focus();
  }

  closeOnboarding(): void {
    this.showOnboarding.set(false);
    this.onboardingError.set(null);
    this.needsFocusRestore = true;
  }

  async onAddMusicFolder(): Promise<void> {
    if (this.onboardingBusy()) return;
    this.onboardingBusy.set(true);
    this.onboardingError.set(null);
    try {
      const added = await this.libraryGateway.selectAndAddMusicFolders();
      if (added.length) this.closeOnboarding();
      else this.needsOnboardingFocus = true;
    } catch (error) {
      this.onboardingError.set(error instanceof Error ? error.message : 'Failed to add music folders');
      this.needsOnboardingFocus = true;
    } finally {
      this.onboardingBusy.set(false);
    }
  }

  onOnboardingKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeOnboarding();
    } else if (event.key === 'Tab') {
      const buttons = [...(this.onboardingDialog?.nativeElement.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
      if (!buttons.length) return;
      const first = buttons[0];
      const last = buttons.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  onToggleSidebar(): void {
    this.isSidebarCollapsed.update((val) => !val);
    saveFlag(SIDEBAR_COLLAPSED_KEY, this.isSidebarCollapsed());
  }

  onToggleSidebarVisibility(): void {
    this.isSidebarHidden.update((hidden) => !hidden);
    saveFlag(SIDEBAR_HIDDEN_KEY, this.isSidebarHidden());
  }

  /** The 6px handle is easy to leave mid-drag, so the gesture listens on the window until release. */
  onRailResizeStart(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const { clientX: startX } = event;
    const startWidth = this.railWidth();
    const drag = new AbortController();
    const end = () => {
      drag.abort();
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.setRailWidth(this.railWidth());
    };
    window.addEventListener('pointermove', (move) =>
      this.railWidthPreference.set(clampRailWidth(startWidth + startX - move.clientX, this.windowWidth())), { signal: drag.signal });
    window.addEventListener('pointerup', end, { signal: drag.signal });
    window.addEventListener('pointercancel', end, { signal: drag.signal });
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }

  onRailResizeKeyDown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    const width = this.railWidth();
    // Keys step across the slim/full jump instead of getting stuck on either side of it.
    if (width === RAIL_SLIM_WIDTH) this.setRailWidth(delta > 0 ? RAIL_MIN_WIDTH : RAIL_SLIM_WIDTH);
    else this.setRailWidth(width + delta < RAIL_MIN_WIDTH ? RAIL_SLIM_WIDTH : width + delta);
  }

  resetRailWidth(): void { this.setRailWidth(RAIL_DEFAULT_WIDTH); }

  private setRailWidth(width: number): void {
    const clamped = clampRailWidth(width, this.windowWidth());
    this.railWidthPreference.set(clamped);
    try { window.localStorage.setItem(RAIL_WIDTH_KEY, String(clamped)); } catch { /* The rail still resizes for this session. */ }
  }

  onToggleQueue(): void {
    if (this.layoutPreference.mode() !== 'classic' && !this.hasTrackOrQueue()) return;
    this.rightPanels.toggleQueue();
  }

  onCloseQueue(): void {
    this.rightPanels.closeQueue();
  }

  closeShortcuts(): void {
    this.showShortcuts.set(false);
    this.needsShortcutsFocusRestore = true;
  }

  onShortcutsKeyDown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeShortcuts();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.shortcutsDialog?.nativeElement.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (this.showOnboarding()) {
      if (event.key === 'Escape') { event.preventDefault(); this.closeOnboarding(); }
      return;
    }
    if (this.showShortcuts()) {
      if (event.key === 'Escape') { event.preventDefault(); this.closeShortcuts(); }
      return;
    }
    if (event.defaultPrevented || event.isComposing) return;
    // Some existing playlist/confirmation dialogs use a backdrop without aria-modal.
    if ([...document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open], .modal-backdrop, .metadata-modal-backdrop')]
      .some((dialog) => dialog.checkVisibility())) return;
    if (event.key === 'Escape') {
      this.rightPanels.closeActive();
      return;
    }
    const isVolumeKey = event.code === 'ArrowUp' || event.code === 'ArrowDown';
    if (event.ctrlKey || event.altKey || event.metaKey || (event.repeat && !isVolumeKey)) return;

    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl?.isContentEditable || activeEl?.closest(
      'input, textarea, select, [role="textbox"], [role="combobox"], [role="searchbox"]',
    )) return;
    // Player keys work only on Now Playing or once the player is clicked, so typing on any other page
    // (a webview chat included) never skips or pauses the music.
    if (event.code !== 'Slash' && !this.onNowPlaying() && !activeEl?.closest('app-player-bar')) return;

    switch (event.code) {
      case 'ArrowUp':
      case 'ArrowDown':
        if (activeEl?.closest('.rail-lyrics, [role="grid"], [role="listbox"], [role="menu"]')) return;
        this.player.setVolume(Math.round((this.player.volume() + (event.code === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100);
        this.playerBar?.flashVolume();
        break;
      case 'Slash':
        if (!event.shiftKey) return;
        this.focusBeforeShortcuts = activeEl;
        this.showShortcuts.set(true);
        this.needsShortcutsFocus = true;
        break;
      case 'Space':
        if (!this.hasTrackOrQueue() || activeEl?.closest('button, a, [role="button"]')) return;
        this.player.togglePlayPause();
        break;
      case 'KeyP':
        if (!this.player.currentTrack()) return;
        this.player.previous();
        break;
      case 'KeyN':
        if (!this.player.currentTrack()) return;
        this.player.next();
        break;
      case 'KeyS':
        if (this.player.modesLocked()) return;
        // Off → Shuffle → Smart Shuffle → Off, like the shuffle button.
        void this.smartShuffle.cycleShuffle();
        break;
      case 'KeyR':
        if (this.player.modesLocked()) return;
        this.player.cycleRepeatMode();
        break;
      case 'KeyM':
        this.player.toggleMute();
        break;
      case 'KeyQ':
        if (this.layoutPreference.mode() !== 'classic' && !this.hasTrackOrQueue()) return;
        this.onToggleQueue();
        break;
      default:
        return;
    }

    event.preventDefault();
  }
}

function readSavedFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function saveFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // The controls remain usable when local storage is unavailable.
  }
}

function readSavedRailWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    // Without a saved width, small windows keep starting with the slim column.
    return saved > 0 ? saved : window.innerWidth <= 1100 ? RAIL_SLIM_WIDTH : RAIL_DEFAULT_WIDTH;
  } catch {
    return RAIL_DEFAULT_WIDTH;
  }
}

function clampRailWidth(width: number, windowWidth: number): number {
  const max = Math.min(RAIL_MAX_WIDTH, windowWidth - RAIL_RESERVED_WIDTH);
  if (width < RAIL_SNAP_WIDTH || max < RAIL_MIN_WIDTH) return RAIL_SLIM_WIDTH;
  return Math.round(Math.min(max, Math.max(RAIL_MIN_WIDTH, width)));
}
