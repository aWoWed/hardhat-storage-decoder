/**
 * Root entrypoint. It exists only to turn the most likely first-run mistake — importing the
 * package without a subpath — into an actionable message instead of a raw
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * There is deliberately no auto-detection of the installed Hardhat major here: Hardhat 2 and
 * Hardhat 3 register plugins differently and expose the decoder on different objects, so
 * version-sniffing would only move the failure somewhere less obvious.
 */

/** Text of the error thrown on import: names both subpaths and how to use each. */
const MESSAGE =
  'hardhat-storage-decoder has no root entrypoint. Import the subpath matching your Hardhat' +
  ' major instead:\n' +
  '  Hardhat 2.x:  require("hardhat-storage-decoder/hardhat2")' +
  '  /  import "hardhat-storage-decoder/hardhat2"\n' +
  '  Hardhat 3.x:  import { storageDecoderPlugin } from "hardhat-storage-decoder/hardhat3"' +
  ' and add it to your config\'s `plugins` array.';

/**
 * Thrown when the package root is imported. Carries guidance naming both subpaths, so the
 * failure says which one to import instead of surfacing as a bare resolution error.
 */
export class HardhatStorageDecoderEntrypointError extends Error {
  constructor() {
    super(MESSAGE);
    this.name = 'HardhatStorageDecoderEntrypointError';
  }
}

// Throws at module evaluation on purpose: the root exports nothing usable, so a successful
// import would only defer the mistake to a confusing "undefined is not a function" later.
throw new HardhatStorageDecoderEntrypointError();
