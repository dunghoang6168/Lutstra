import { defineConfig } from 'tsup';
import { DEV_ELECTRON, DEV_PRELOAD, edition } from './scripts/edition.mjs';

// The full edition swaps the main process's and the preload's dev-hooks stubs for dev/electron.
const full = edition() === 'full';
const devHooks = {
  name: 'dev-hooks',
  setup(build: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string } | undefined) => void }) {
    if (!full) return;
    build.onResolve({ filter: /[\\/]dev-hooks-preload(\.js)?$/ }, () => ({ path: DEV_PRELOAD }));
    build.onResolve({ filter: /[\\/]dev-hooks(\.js)?$/ }, () => ({ path: DEV_ELECTRON }));
  },
};

export default defineConfig([
  {
    entry: { main: 'electron/main.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    outDir: 'dist-electron',
    external: ['electron', 'node:sqlite'],
    clean: true,
    esbuildPlugins: [devHooks],
  },
  {
    entry: { preload: 'electron/preload.cts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node24',
    outDir: 'dist-electron',
    external: ['electron'],
    outExtension: () => ({ js: '.cjs' }),
    clean: false,
    esbuildPlugins: [devHooks],
  },
]);
