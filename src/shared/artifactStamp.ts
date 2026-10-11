/**
 * What both adapters validate a cached contract against: one write of its artifact file.
 *
 * Shared by the two adapters rather than placed in `src/core/**`, which does no I/O of its own
 * and takes everything it reads through an interface.
 */

import { stat } from 'node:fs/promises';

/**
 * Hardhat rewrites a contract's artifact whenever the compilation job that produces it runs,
 * and a layout change always forces that job to run, so a different stamp means a cached
 * layout may be out of date. `size` is compared as well as `mtimeMs` because a rewrite can
 * land inside one tick of a coarse filesystem clock.
 */
export interface ArtifactStamp {
  /** Last-modified time of the artifact file, in milliseconds (`fs.Stats.mtimeMs`). */
  readonly mtimeMs: number;
  /** Size of the artifact file in bytes. */
  readonly size: number;
}

/**
 * Take the stamp of a file as it is on disk right now.
 *
 * @param path - Filesystem path of the artifact file.
 * @returns The file's `mtimeMs` and `size`.
 * @throws Whatever `fs.promises.stat` rejects with (for example `ENOENT` when the file is
 * missing); callers decide whether that is an error.
 */
export async function stampOf(path: string): Promise<ArtifactStamp> {
  const { mtimeMs, size } = await stat(path);
  return { mtimeMs, size };
}

/**
 * Two absent stamps count as equal: with nothing to validate against, a cached entry is kept
 * for the life of the process. An absent stamp never equals a present one.
 *
 * @param a - First stamp, or `undefined` when none could be taken.
 * @param b - Second stamp, or `undefined` when none could be taken.
 * @returns `true` when both are absent, or both are present with equal `mtimeMs` and `size`.
 */
export function sameStamp(a: ArtifactStamp | undefined, b: ArtifactStamp | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
