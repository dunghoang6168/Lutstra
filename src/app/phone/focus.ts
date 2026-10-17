/**
 * Moves focus for screen readers and keyboards without the ring a tap did not ask for, when a sheet opens or
 * closes. `focusVisible` is in the WebView (Chromium 135+) but not yet in TypeScript's DOM types.
 */
export function focusQuietly(element: HTMLElement | null | undefined): void {
  element?.focus({ focusVisible: false } as FocusOptions);
}
