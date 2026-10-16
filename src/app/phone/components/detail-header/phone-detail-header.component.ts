import { Component, input, output } from '@angular/core';
import { IconComponent, IconName } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';

/** Detail page hero: cover, title, a prose line and a mono measurement line, then Play and Shuffle. */
@Component({
  selector: 'app-phone-detail-header',
  standalone: true,
  imports: [IconComponent, CoverArtComponent],
  templateUrl: './phone-detail-header.component.html',
  styleUrl: './phone-detail-header.component.scss',
})
export class PhoneDetailHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly measure = input<string | null>(null);
  readonly hires = input(false);
  readonly artwork = input<string | null>(null);
  readonly icon = input<IconName>('disc');
  readonly round = input(false);
  readonly canPlay = input(true);
  readonly play = output<void>();
  readonly shuffle = output<void>();
}
