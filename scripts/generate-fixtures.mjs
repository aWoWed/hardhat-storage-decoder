#!/usr/bin/env node
/**
 * Compile `test/fixtures/contracts/*.sol` with the pinned solc and write the resulting
 * `storageLayout` blobs to `test/unit/fixtures/layouts.json`.
 *
 * The unit suite runs against REAL solc output rather than hand-authored JSON, so a wrong
 * assumption about the layout shape (e.g. that `uint8[10]` reports `numberOfBytes: 10`, which
 * it does not — it reports 32) fails the suite instead of being baked into both sides of it.
 *
 * Regenerate after changing a fixture contract or bumping solc:
 *     npm run fixtures:generate
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const solc = require('solc');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS_DIR = join(ROOT, 'test', 'fixtures', 'contracts');
const OUT_FILE = join(ROOT, 'test', 'unit', 'fixtures', 'layouts.json');

const files = (await readdir(CONTRACTS_DIR)).filter((name) => name.endsWith('.sol')).sort();
const sources = {};
for (const file of files) {
  sources[file] = { content: await readFile(join(CONTRACTS_DIR, file), 'utf8') };
}

const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources,
      settings: {
        optimizer: { enabled: false },
        outputSelection: { '*': { '': ['ast'], '*': ['storageLayout'] } },
      },
    })
  )
);

const fatal = (output.errors ?? []).filter((error) => error.severity === 'error');
if (fatal.length > 0) {
  for (const error of fatal) console.error(error.formattedMessage);
  process.exit(1);
}

// Walk the AST independently of src/ — these fixtures are supposed to be an independent
// source of truth, not a replay of the code under test.
function collectFromAst(ast) {
  const userDefinedValueTypes = {};
  const constantAndImmutableNames = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.nodeType === 'UserDefinedValueTypeDefinition') {
      const identifier = node.underlyingType?.typeDescriptions?.typeIdentifier;
      if (typeof identifier === 'string') {
        userDefinedValueTypes[String(node.id)] = identifier;
        userDefinedValueTypes[node.name] = identifier;
      }
    }
    if (
      node.nodeType === 'VariableDeclaration' &&
      node.stateVariable === true &&
      (node.mutability === 'constant' || node.mutability === 'immutable')
    ) {
      constantAndImmutableNames.push(node.name);
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(ast);
  return { userDefinedValueTypes, constantAndImmutableNames };
}

// State-variable AST id -> declaring contract, over every source: an inherited variable may be
// declared in another file. solc's own `contract` field names the compiled contract instead.
const declaringContracts = {};
for (const [sourceName, source] of Object.entries(output.sources ?? {})) {
  for (const node of source.ast?.nodes ?? []) {
    if (node.nodeType !== 'ContractDefinition') continue;
    for (const member of node.nodes ?? []) {
      if (member.nodeType === 'VariableDeclaration' && member.stateVariable === true) {
        declaringContracts[String(member.id)] = `${sourceName}:${node.name}`;
      }
    }
  }
}

const contracts = {};
for (const [sourceName, contractMap] of Object.entries(output.contracts ?? {})) {
  const astInfo = collectFromAst(output.sources?.[sourceName]?.ast);
  for (const [contractName, artifact] of Object.entries(contractMap)) {
    if (!artifact.storageLayout) continue;
    contracts[`${sourceName}:${contractName}`] = {
      contractName,
      sourceName,
      storageLayout: artifact.storageLayout,
      userDefinedValueTypes: astInfo.userDefinedValueTypes,
      constantAndImmutableNames: astInfo.constantAndImmutableNames,
      declaringContracts: Object.fromEntries(
        artifact.storageLayout.storage.map((entry) => [
          String(entry.astId),
          declaringContracts[String(entry.astId)],
        ])
      ),
    };
  }
}

await mkdir(join(ROOT, 'test', 'unit', 'fixtures'), { recursive: true });
await writeFile(
  OUT_FILE,
  `${JSON.stringify({ solcVersion: solc.version(), contracts }, null, 2)}\n`,
  'utf8'
);

console.log(
  `wrote ${Object.keys(contracts).length} storage layout(s) to test/unit/fixtures/layouts.json` +
    ` (solc ${solc.version()})`
);
