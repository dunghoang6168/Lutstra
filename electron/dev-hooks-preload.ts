/*
 * The preload's seam for the developer edition: extra APIs exposed to the renderer beside `lutstra`'s own.
 * The public build ships this empty stub; the full build swaps in dev/electron/preload.ts (tsup.config.ts).
 */
export const devPreloadApi: Record<string, unknown> = {};
