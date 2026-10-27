import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect, inject, input, output, signal, viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';
import { LIBRARY_GATEWAY } from '../../../core/contracts';
import { getDesktopApi } from '../../../core/desktop/desktop-api';
import { NavigationHistoryService } from '../../../core/layout/navigation-history.service';
import { LayoutPreferenceService } from '../../../core/layout/layout-preference.service';
import { type ScanProgress } from '../../../core/models';
import { ThemeService } from '../../../core/theme/theme.service';
import { devMenu } from '../../../dev-hooks';
import { GlobalSearchComponent } from '../global-search/global-search.component';
import { IconComponent } from '../icon/icon.component';
import { TipDirective } from '../../directives/tip.directive';
import { WindowControlsComponent } from '../window-controls/window-controls.component';

import { LensGlassDirective } from '../../directives/lens-glass.directive';
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [NgTemplateOutlet, RouterLink, RouterLinkActive, GlobalSearchComponent, IconComponent, WindowControlsComponent, TipDirective, LensGlassDirective],
  templateUrl: './app-header.component.html',
  styleUrl: './app-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppHeaderComponent {
  readonly sidebarHidden = input(false);
  /** An embedded page: the library search folds into its icon (Ctrl K still opens it), so the page's own search stands alone. */
  readonly searchFolded = input(false);
  readonly toggleSidebarVisibility = output<void>();
  readonly layoutPreference = inject(LayoutPreferenceService);
  private readonly gateway = inject(LIBRARY_GATEWAY);
  private readonly theme = inject(ThemeService);
  private readonly search = viewChild.required(GlobalSearchComponent);
  private readonly desktopApi = getDesktopApi();
  private wasScanning = false;
  readonly compactSearchOpen = signal(false);

  readonly navHistory = inject(NavigationHistoryService);
  /** Gallery's section tabs, shared by the wide navigation and compact menu. */
  readonly tabs = computed(() => [
    { path: '/home', label: 'Home' },
    { path: '/songs', label: 'Songs' },
    { path: '/albums', label: 'Albums' },
    { path: '/artists', label: 'Artists' },
    { path: '/playlists', label: 'Playlists' },
    { path: '/folders', label: 'Folders' },
    { path: '/history', label: 'History' },
  ]);
  /** The Developer menu beside Settings; only the developer edition has one. */
  readonly devMenu = devMenu;
  private readonly devMenuElement = viewChild<ElementRef<HTMLDetailsElement>>('devMenuElement');
  private readonly url = toSignal(inject(Router).events.pipe(
    filter((event): event is NavigationEnd => event instanceof NavigationEnd),
    map((event) => event.urlAfterRedirects),
  ), { initialValue: '' });
  /** Pressed while one of its pages shows. */
  readonly devMenuActive = computed(() => (this.devMenu?.entries ?? []).some((entry) => this.url().startsWith(entry.path)));
  readonly scanProgress = toSignal(this.gateway.scanProgress$, {
    initialValue: {
      isScanning: false, scannedFiles: 0, audioFiles: 0, currentPath: null, error: null,
    } satisfies ScanProgress,
  });
  readonly statusLabel = computed(() => {
    const progress = this.scanProgress();
    if (progress.isScanning) return `Scanning · ${progress.scannedFiles}`;
    if (progress.error) return 'Scan warning';
    return '';
  });
  readonly statusTitle = computed(() => {
    const progress = this.scanProgress();
    if (progress.error) return progress.error;
    if (progress.isScanning) return progress.currentPath ?? `Scanning ${progress.scannedFiles} files`;
    return '';
  });

  constructor() {
    effect(() => {
      const mode = this.theme.effectiveTheme() === 'dark' ? 'dark' : 'light';
      void this.desktopApi?.windowControls.setTitleBarAppearance(mode).catch(() => undefined);
    });
    effect(() => {
      const scanning = this.scanProgress().isScanning;
      if (this.wasScanning && !scanning) queueMicrotask(() => this.search().refreshIfOpen());
      this.wasScanning = scanning;
    });
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.compactSearchOpen()) this.closeCompactSearch();
    if (event.key === 'Escape') this.closeDevMenu();
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      this.openCompactSearch();
    }
  }

  openCompactSearch(): void {
    this.compactSearchOpen.set(true);
    requestAnimationFrame(() => this.search().focus());
  }

  toggleCompactSearch(): void {
    if (this.compactSearchOpen()) this.closeCompactSearch();
    else this.openCompactSearch();
  }

  private closeCompactSearch(): void {
    this.compactSearchOpen.set(false);
    this.search().close();
  }

  closeDevMenu(): void {
    const menu = this.devMenuElement()?.nativeElement;
    if (menu) menu.open = false;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const target = event.target;
    if (!target.closest('.dev-menu')) this.closeDevMenu();
    if (!this.compactSearchOpen() || target.closest('app-global-search, .compact-search-button')) return;
    this.closeCompactSearch();
  }
}
