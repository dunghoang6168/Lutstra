import { ChangeDetectionStrategy, Component, ElementRef, inject, viewChild } from '@angular/core';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { RandomOptions, RandomSessionService } from './random-session.service';
import { GOLD_PER_ARTIST, HARD_PITY, MYTHIC_CHANCE, MYTHIC_GUARANTEE, MYTHIC_SHARE, RARITY_NAMES, RARITY_RATES, RED_PITY, SOFT_PITY_FROM, TIER_SHARES } from './random-folder.utils';

const percent = (share: number) => `${+(share * 100).toFixed(1)}%`;

/** Modal with the Random folder options, one switch per row. Changes apply from the next pick. */
@Component({
  selector: 'app-random-options-dialog',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './random-options-dialog.component.html',
  styleUrl: './random-options-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RandomOptionsDialogComponent {
  readonly session = inject(RandomSessionService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly rows: { key: keyof RandomOptions; label: string; description: string }[] = [
    { key: 'includeSubfolders', label: 'Include subfolders', description: 'Pick from every folder under the source, not only its own files.' },
    { key: 'rollEveryTrack', label: 'Roll every track', description: 'Spin the reel before each track. Off: roll once, then keep picking at random.' },
    { key: 'noRepeats', label: 'No repeats in a round', description: 'Play each track at most once until you start a new round.' },
    { key: 'infinite', label: 'Infinite roulette', description: 'When every track has played, start over instead of stopping. Needs No repeats; without it the roulette never ends.' },
  ];

  /** Infinite roulette only matters while No repeats is on. */
  isDisabled(key: keyof RandomOptions): boolean {
    return key === 'infinite' && !this.session.options().noRepeats;
  }

  /** Read-only gacha rates, best tier first; tiers rank YouTube views within each region folder. */
  readonly rates = [
    { tier: 5, name: RARITY_NAMES[5], format: `Top ${percent(MYTHIC_SHARE)} views`, rate: `${MYTHIC_CHANCE * 100}% of top` },
    { tier: 4, name: RARITY_NAMES[4], format: `To top ${percent(TIER_SHARES[4])}, ${GOLD_PER_ARTIST} per artist`, rate: `${percent(RARITY_RATES[4])} top` },
    ...([3, 2, 1] as const).map((tier) => ({
      tier,
      name: RARITY_NAMES[tier],
      format: tier === 1 ? 'The rest, or no views' : `Next ${percent(TIER_SHARES[tier])}`,
      rate: percent(RARITY_RATES[tier]),
    })),
  ];
  readonly pityRule = `Soft pity from roll ${SOFT_PITY_FROM} · gold or better guaranteed at ${HARD_PITY} · red at least every ${RED_PITY} · mythical guaranteed at top roll ${MYTHIC_GUARANTEE}`;

  open(): void {
    this.dialog().nativeElement.showModal();
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  toggle(key: keyof RandomOptions): void {
    this.session.setOption(key, !this.session.options()[key]);
  }

  /** A click on the backdrop lands on the dialog element itself. */
  onDialogClick(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.close();
  }
}
