import { Component, ElementRef, OnDestroy, ViewChild, afterNextRender, inject, output, signal } from '@angular/core';
import { DevModeService } from '../../../core/settings/dev-mode.service';

/** Asks for the developer mode code; emits `unlocked` once the code matched and the mode is on. */
@Component({
  selector: 'app-dev-mode-dialog',
  standalone: true,
  templateUrl: './dev-mode-dialog.component.html',
  styleUrl: './dev-mode-dialog.component.scss',
})
export class DevModeDialogComponent implements OnDestroy {
  private readonly devMode = inject(DevModeService);
  readonly cancelled = output<void>();
  readonly unlocked = output<void>();
  readonly wrongCode = signal(false);
  @ViewChild('dialog') private dialog?: ElementRef<HTMLDialogElement>;
  @ViewChild('codeInput') private codeInput?: ElementRef<HTMLInputElement>;
  private focusBeforeDialog: HTMLElement | null = null;

  constructor() {
    afterNextRender(() => {
      this.focusBeforeDialog = document.activeElement as HTMLElement | null;
      this.dialog?.nativeElement.showModal();
      this.codeInput?.nativeElement.focus();
    });
  }

  ngOnDestroy(): void {
    this.dialog?.nativeElement.close();
    if (this.focusBeforeDialog?.isConnected) this.focusBeforeDialog.focus();
  }

  onSubmit(event: Event, code: string): void {
    event.preventDefault();
    if (this.devMode.unlock(code)) {
      this.unlocked.emit();
      return;
    }
    this.wrongCode.set(true);
    this.codeInput?.nativeElement.select();
  }

  onCancel(event: Event): void {
    event.preventDefault();
    this.cancelled.emit();
  }

  onKeyDown(event: KeyboardEvent): void {
    // Keep global player/search shortcuts outside the modal's focus scope.
    event.stopPropagation();
    if (event.key === 'Escape') this.onCancel(event);
  }

  onBackdropClick(event: MouseEvent): void {
    const dialog = this.dialog?.nativeElement;
    if (!dialog || event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) this.cancelled.emit();
  }
}
