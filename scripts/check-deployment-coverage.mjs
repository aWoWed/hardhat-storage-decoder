#!/usr/bin/env node
/**
 * Runnable gate: compile the deployment mocks and fail unless every value family the
 * decoder supports appears in a deployable contract's storage layout.
 *
 *   node scripts/check-deployment-coverage.mjs                  deployments/contracts
 *   node scripts/check-deployment-coverage.mjs --self-test      removing a family must fail
 *
 * What counts:
 *   - Only deployable contracts, as abstract ones are never read on chain.
 *   - Nothing declared in `Sealable`. Its `owner` and `isSealed` share a slot and every mock
 *     inherits them, so counting them would satisfy "packed slots" and "inheritance" for good.
 *
 * A layout cannot show how long a stored string is. The short and long families are therefore
 * variables named for it, and the tests check those names against the header slot.
 * Immutables are not in a layout at all, so that family comes from `immutableReferences`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const solc = require('solc');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = join(ROOT, 'deployments', 'contracts');
const BASE_CONTRACT = 'Sealable';

/** The required families, with value types split out so that losing one is noticed. */
const FAMILIES = [
  'value: uint',
  'value: int',
  'value: bool',
  'value: address',
  'value: fixed bytes',
  'value: contract',
  'value: external function',
  'value: internal function',
  'packed slot',
  'mapping',
  'nested mapping',
  'dynamic array',
  'fixed array',
  'struct',
  'short string',
  'long string',
  'short bytes',
  'long bytes',
  'enum',
  'user-defined type',
  'inheritance',
  'shadowed name',
  'immutable',
];

/** Compile a folder with the settings the deployment configs pin. */
async function compile(contractsDir) {
  const files = (await readdir(contractsDir)).filter((name) => name.endsWith('.sol')).sort();
  const sources = {};
  for (const file of files) {
    sources[file] = { content: await readFile(join(contractsDir, file), 'utf8') };
  }
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources,
        settings: {
          optimizer: { enabled: false },
          evmVersion: 'cancun',
          outputSelection: {
            '*': {
              '': ['ast'],
              '*': ['storageLayout', 'evm.bytecode.object', 'evm.deployedBytecode.immutableReferences'],
            },
          },
        },
      })
    )
  );
  const fatal = (output.errors ?? []).filter((error) => error.severity === 'error');
  if (fatal.length > 0) {
    for (const error of fatal) console.error(error.formattedMessage);
    process.exit(2);
  }
  return output;
}

/**
 * The deployable contracts as `{ name, source, storage, types, immutables }`, where each storage
 * entry gains its declaring contract. That has to come from the AST: solc's own `contract` field
 * names the compiled contract, not the one holding the declaration.
 */
function collectContracts(output) {
  const declaredIn = new Map();
  for (const source of Object.values(output.sources ?? {})) {
    for (const node of source.ast?.nodes ?? []) {
      if (node.nodeType !== 'ContractDefinition') continue;
      for (const member of node.nodes ?? []) {
        if (member.nodeType === 'VariableDeclaration' && member.stateVariable === true) {
          declaredIn.set(member.id, node.name);
        }
      }
    }
  }

  const contracts = [];
  for (const [source, byName] of Object.entries(output.contracts ?? {})) {
    for (const [name, artifact] of Object.entries(byName)) {
      if (artifact.evm.bytecode.object === '') continue;
      contracts.push({
        name,
        source,
        storage: artifact.storageLayout.storage
          .map((entry) => ({ ...entry, declaredIn: declaredIn.get(entry.astId) }))
          .filter((entry) => entry.declaredIn !== BASE_CONTRACT),
        types: artifact.storageLayout.types ?? {},
        immutables: Object.keys(artifact.evm.deployedBytecode.immutableReferences ?? {}).length,
      });
    }
  }
  return contracts;
}

/** Every type a variable's type reaches: mapping values, array elements, struct members. */
function reachableTypes(typeId, types, seen = new Set()) {
  if (seen.has(typeId)) return seen;
  seen.add(typeId);
  const type = types[typeId];
  if (type === undefined) return seen;
  for (const next of [type.value, type.key, type.base]) {
    if (next !== undefined) reachableTypes(next, types, seen);
  }
  for (const member of type.members ?? []) reachableTypes(member.type, types, seen);
  return seen;
}

/** Families a single contract provides. */
function familiesOf(contract) {
  const found = new Set();
  const { storage, types } = contract;
  if (contract.immutables > 0) found.add('immutable');

  const sharesSlot = (entries) => new Set(entries.map((entry) => entry.slot)).size < entries.length;
  if (sharesSlot(storage)) found.add('packed slot');

  const labels = new Map();
  for (const entry of storage) {
    if (entry.declaredIn !== contract.name) found.add('inheritance');
    const owners = labels.get(entry.label) ?? new Set();
    if (owners.size > 0 && !owners.has(entry.declaredIn)) found.add('shadowed name');
    labels.set(entry.label, owners.add(entry.declaredIn));

    if (entry.type === 't_string_storage' || entry.type === 't_bytes_storage') {
      const kind = entry.type === 't_string_storage' ? 'string' : 'bytes';
      if (/^short/.test(entry.label)) found.add(`short ${kind}`);
      if (/^long/.test(entry.label)) found.add(`long ${kind}`);
    }

    for (const id of reachableTypes(entry.type, types)) {
      const type = types[id];
      if (/^t_uint\d+$/.test(id)) found.add('value: uint');
      else if (/^t_int\d+$/.test(id)) found.add('value: int');
      else if (id === 't_bool') found.add('value: bool');
      else if (/^t_address(_payable)?$/.test(id)) found.add('value: address');
      else if (/^t_bytes\d+$/.test(id)) found.add('value: fixed bytes');
      else if (id.startsWith('t_contract(')) found.add('value: contract');
      else if (id.startsWith('t_function_external_')) found.add('value: external function');
      else if (id.startsWith('t_function_internal_')) found.add('value: internal function');
      else if (id.startsWith('t_enum(')) found.add('enum');
      else if (id.startsWith('t_userDefinedValueType(')) found.add('user-defined type');
      else if (id.startsWith('t_struct(')) {
        found.add('struct');
        if (sharesSlot(type?.members ?? [])) found.add('packed slot');
      } else if (id.startsWith('t_mapping(')) {
        found.add('mapping');
        if (type?.value?.startsWith('t_mapping(')) found.add('nested mapping');
      } else if (id.startsWith('t_array(')) {
        found.add(type?.encoding === 'dynamic_array' ? 'dynamic array' : 'fixed array');
      }
    }
  }
  return found;
}

/** Map each family to the contracts providing it. */
function coverage(contracts) {
  const providers = new Map(FAMILIES.map((family) => [family, []]));
  for (const contract of contracts) {
    for (const family of familiesOf(contract)) providers.get(family).push(contract.name);
  }
  return providers;
}

const missingFrom = (providers) =>
  [...providers].filter(([, names]) => names.length === 0).map(([family]) => family);

/** Remove what provides each family, and require the check to notice. */
function selfTest(contracts) {
  const failures = [];
  if (missingFrom(coverage(contracts)).length > 0) failures.push('the real mocks are incomplete');

  for (const family of FAMILIES) {
    const left = contracts.filter((contract) => !familiesOf(contract).has(family));
    if (!missingFrom(coverage(left)).includes(family)) {
      failures.push(`not noticed: no contract providing "${family}"`);
    }
  }

  // Layout-level cases that removing a whole contract would not separate.
  const plant =(storage, types = {}) => [
    { name: 'Plant', source: 'Plant.sol', storage, types, immutables: 0 },
  ];
  const variable = (label, slot, declaredIn = 'Plant') => ({
    label,
    slot,
    offset: 0,
    type: 't_uint256',
    declaredIn,
  });
  const has = (list, family) => missingFrom(coverage(list)).includes(family) === false;
  if (has(plant([variable('a', '0'), variable('b', '1')]), 'packed slot')) {
    failures.push('separate slots counted as packed');
  }
  if (!has(plant([variable('a', '0'), variable('b', '0')]), 'packed slot')) {
    failures.push('a shared slot was not counted as packed');
  }
  if (has(plant([variable('a', '0'), variable('b', '1')]), 'shadowed name')) {
    failures.push('distinct names counted as shadowed');
  }
  if (has(plant([variable('a', '0', 'Base'), variable('a', '0', 'Base')]), 'shadowed name')) {
    failures.push('one declaring contract counted as shadowing');
  }
  if (!has(plant([variable('a', '0', 'Base'), variable('a', '1')]), 'shadowed name')) {
    failures.push('a real shadow was not counted');
  }
  if (has(plant([{ ...variable('text', '0'), type: 't_string_storage' }]), 'short string')) {
    failures.push('a string with no short name counted as short');
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`deployment coverage self-test OK — ${FAMILIES.length} families`);
}

const contracts = collectContracts(await compile(CONTRACTS));

if (process.argv.includes('--self-test')) {
  selfTest(contracts);
} else {
  const providers = coverage(contracts);
  for (const [family, names] of providers) {
    console.log(`  ${family.padEnd(26)}${names.length > 0 ? names.join(', ') : 'MISSING'}`);
  }
  const missing = missingFrom(providers);
  if (missing.length > 0) {
    console.error(`\nno deployable mock provides: ${missing.join('; ')}`);
    process.exit(1);
  }
  console.log(
    `\ndeployment coverage OK — ${FAMILIES.length} families, ${contracts.length} contract(s)`
  );
}
