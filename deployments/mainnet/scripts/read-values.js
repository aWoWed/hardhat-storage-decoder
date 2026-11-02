/**
 * Reads every candidate's values through the plugin's normal path, strict address check included,
 * and writes the outcome to `MAINNET_CHECK_OUT` for `scripts/mainnet-check.mjs` to compare. A
 * failure is recorded per value and never stops the rest. Run by `hardhat run --no-compile`.
 */
const { writeFileSync } = require('node:fs');
const hre = require('hardhat');
const { classifyReadFailure } = require('hardhat-storage-decoder/hardhat2');
const { candidates } = require('../candidates.json');

const block = Number(process.env.MAINNET_CHECK_BLOCK);
const firstOnly = process.env.MAINNET_CHECK_FIRST_ONLY === '1';

function queryOf(candidate, value) {
  let query = hre.storageDecoder
    .contract(`contracts/${candidate.id}/${candidate.file}:${candidate.contract}`)
    .target(candidate.address)
    .name(value.name);
  for (const [kind, segment] of value.path ?? []) query = query[kind](segment);
  return query.at(block);
}

async function main() {
  const results = [];
  for (const candidate of candidates) {
    const values = [];
    for (const value of firstOnly ? candidate.values.slice(0, 1) : candidate.values) {
      try {
        const read = await queryOf(candidate, value).read();
        values.push({ id: value.id, value: read.value });
      } catch (error) {
        values.push({
          id: value.id,
          error: { name: error.name, message: error.message, class: classifyReadFailure(error) },
        });
      }
    }
    results.push({ candidate: candidate.id, values });
  }
  writeFileSync(
    process.env.MAINNET_CHECK_OUT,
    JSON.stringify(results, (_, item) => (typeof item === 'bigint' ? item.toString() : item))
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
