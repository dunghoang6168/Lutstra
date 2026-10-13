import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { DEV_MODE_KEY, DevModeService } from '../src/app/core/settings/dev-mode.service';

const stored = () => {
  try { return localStorage.getItem(DEV_MODE_KEY); } catch { return undefined; }
};

describe('DevModeService', () => {
  it('unlocks only with the code, ignoring case and outer spaces', () => {
    const dev = new DevModeService();
    dev.disable();
    expect(dev.unlock('lutstra')).toBe(false);
    expect(dev.unlock('')).toBe(false);
    expect(dev.enabled()).toBe(false);

    expect(dev.unlock('  LUTSTRA-DEV ')).toBe(true);
    expect(dev.enabled()).toBe(true);
    if (stored() !== undefined) expect(stored()).toBe('true');
  });

  it('turns off with disable', () => {
    const dev = new DevModeService();
    dev.unlock('lutstra-dev');
    dev.disable();
    expect(dev.enabled()).toBe(false);
    if (stored() !== undefined) expect(stored()).toBe('false');
  });
});
