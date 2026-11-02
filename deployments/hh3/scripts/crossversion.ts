/** Reads contracts built by Hardhat 2, through this project's plugin. See `run-cross-version.mjs`. */

import { readFileSync, writeFileSync } from 'node:fs';
import hre from 'hardhat';
import { readAcrossBuilds } from '../../shared/readback-core.js';

async function main(): Promise<void> {
  const targets = JSON.parse(readFileSync(process.env.CROSS_TARGETS as string, 'utf8'));
  const connection = await hre.network.create();
  const results = await readAcrossBuilds(connection.storageDecoder, targets);
  writeFileSync(process.env.CROSS_OUT as string, JSON.stringify(results));
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exitCode = 1;
});
