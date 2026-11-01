#!/usr/bin/env node
/**
 * AC 18: values read by the decoder against `cast storage` at slots derived by `cast index` and
 * `cast keccak`, on a local Anvil.
 *
 *   node scripts/oracle-values.mjs [--seed <n>] [--per-family <n>]
 *   node scripts/oracle-values.mjs --wrong-slot   every oracle slot one too high: must exit 1
 */
import {
  buildIndependent,
  compileWithSolcJs,
  forgeLayout,
  loadDecoderCore,
  newSeed,
  oracleLocate,
  oracleValue,
  differences,
  runValueSuite,
  startAnvil,
} from './oracle-common.mjs';
import { option } from './cli-option.mjs';

const wrongSlot = process.argv.includes('--wrong-slot');
const seed = option('--seed') === undefined ? newSeed() : Number(option('--seed'));
const perFamily = Number(option('--per-family') ?? (wrongSlot ? 2 : 200));

const { core, plan, manifest } = await loadDecoderCore();
buildIndependent();
const compiled = compileWithSolcJs(core);

const anvil = await startAnvil();
let result;
const failures = [];
try {
  result = await runValueSuite({
    url: anvil.url,
    tools: { core, plan, manifest, compiled },
    perFamily,
    seed,
    shift: wrongSlot ? 1n : 0n,
  });

  // Each run shows that the comparison can fail, on values it has just seen agree.
  const address = result.addresses.MockValueTypes;
  const layout = forgeLayout('mocks/MockValueTypes.sol', 'MockValueTypes');
  const path = { name: 'revision', segments: [] };
  const decoded = await result.decoder
    .contract('mocks/MockValueTypes.sol:MockValueTypes')
    .target(address)
    .name('revision')
    .read();
  const wrong = await oracleLocate(layout, path, 1n);
  wrong.value = await oracleValue(anvil.url, address, wrong);
  if (differences(undefined, wrong, decoded).length < 2) failures.push('a wrong slot went unnoticed');
  const right = await oracleLocate(layout, path);
  right.value = await oracleValue(anvil.url, address, right);
  if (differences('1', right, decoded).length === 0) failures.push('a wrong written value went unnoticed');
} finally {
  await anvil.stop();
}

for (const name of result.unchecked) failures.push(`no value was checked for ${name}`);
if (result.beforeDeployment !== 'ContractMismatchError') failures.push(`before the deployment: ${result.beforeDeployment}`);
const below = Object.entries(result.families).filter(([, count]) => count < perFamily);
for (const [family, count] of below) failures.push(`${family}: only ${count} writes`);

if (result.mismatches.length > 0) {
  const bySide = {
    slot: result.mismatches.filter(({ found }) => found.some((text) => text.startsWith('slot'))).length,
    value: result.mismatches.filter(({ found }) => found.some((text) => text.startsWith('value'))).length,
  };
  console.error(`\n${result.mismatches.length} read(s) differ: ${bySide.slot} on the slot, ${bySide.value} on the value`);
  for (const { name, path, found } of result.mismatches.slice(0, 20)) {
    console.error(`  ${name} ${path ?? ''}\n    ${found.join('\n    ')}`);
  }
  failures.push('decoder and oracle differ');
}
if (failures.length > 0) {
  console.error(`\nfailed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('every read agrees: written, cast storage at the derived slot, and the decoder');
console.log('the comparison noticed a deliberately wrong slot and a wrong written value');
