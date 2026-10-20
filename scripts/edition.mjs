// Which edition a build makes: "full" (with the private dev/ folder) or "public" (without it).
// LUTSTRA_EDITION=full|public decides; otherwise full when dev/ is present, so a public clone builds as is.
//
// As a command: node scripts/edition.mjs [--public] <command…>
// runs the command for that edition: `ng build` / `ng serve` get the `full` configuration (angular.json),
// tsup reads the edition itself (tsup.config.ts), and a public `electron-builder` writes to release/public.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_RENDERER = path.join(root, 'dev', 'renderer', 'index.ts');
export const DEV_ELECTRON = path.join(root, 'dev', 'electron', 'index.ts');
export const DEV_PRELOAD = path.join(root, 'dev', 'electron', 'preload.ts');

export function edition() {
  const forced = process.env.LUTSTRA_EDITION;
  if (forced === 'public') return 'public';
  if (forced === 'full') {
    if (!existsSync(DEV_RENDERER)) throw new Error('LUTSTRA_EDITION=full needs the private dev/ folder.');
    return 'full';
  }
  return existsSync(DEV_RENDERER) ? 'full' : 'public';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args = process.argv.slice(2);
  if (args[0] === '--public') {
    process.env.LUTSTRA_EDITION = 'public';
    args = args.slice(1);
  }
  const full = edition() === 'full';
  const configured = args.some((arg) => arg === '-c' || arg.startsWith('--configuration'));
  if (full && args[0] === 'ng' && !configured) {
    if (args[1] === 'build') args.push('--configuration', 'production,full');
    if (args[1] === 'serve') args.push('--configuration', 'full');
  }
  if (!full && args[0] === 'electron-builder') args.push('-c.directories.output=release/public');
  console.log(`[edition: ${full ? 'full' : 'public'}] ${args.join(' ')}`);
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit', shell: true, env: { ...process.env, LUTSTRA_EDITION: full ? 'full' : 'public' } });
  process.exit(result.status ?? 1);
}
