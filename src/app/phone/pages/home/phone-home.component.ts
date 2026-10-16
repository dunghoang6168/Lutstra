import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PlayerService } from '../../../core/player/player.service';

/** P0: a way back into the last track. The Home sections arrive in P2. */
@Component({
  selector: 'app-phone-home',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './phone-home.component.html',
  styleUrl: './phone-home.component.scss',
})
export class PhoneHomeComponent {
  readonly player = inject(PlayerService);
}
