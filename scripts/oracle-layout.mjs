#!/usr/bin/env node
/**
 * AC 17: slot, offset and type of every variable, as the decoder parses them, against
 * `forge inspect`, for all mocks and all fixture files.
 *
 * This checks the decoder against solc's layout through a different tool. It does not check solc
 * itself: both sides rest on solc 0.8.26's own report.
 *
 *   node scripts/oracle-layout.mjs
 */
import {
  buildIndependent,
  compileWithSolcJs,
  forgeContracts,
  forgeLayout,
  loadDecoderCore,
} from './oracle-common.mjs';

/** AST ids appear in type ids and shift with any source edit, so they are not part of a type. */
const normalId = (id) => id.replace(/\)\d+/g, ')');

function compareLayouts(forge, parsed) {
  const found = [];
  const seen = new Set();
  const compareType = (forgeId, parsedId, where) => {
    if (normalId(forgeId) !== normalId(parsedId)) found.push(`${where}: type id ${forgeId} / ${parsedId}`);
    if (seen.has(forgeId)) return;
    seen.add(forgeId);
    const left = forge.types[forgeId];
    const right = parsed.types[parsedId];
    if (right === undefined) {
      found.push(`${where}: the decoder has no type ${parsedId}`);
      return;
    }
    if (left.label !== right.label) found.push(`${where}: label ${left.label} / ${right.label}`);
    if (left.encoding !== right.encoding) found.push(`${where}: encoding ${left.encoding} / ${right.encoding}`);
    if (Number(left.numberOfBytes) !== right.numberOfBytes) {
      found.push(`${where}: numberOfBytes ${left.numberOfBytes} / ${right.numberOfBytes}`);
    }
    if (left.key !== undefined) compareType(left.key, right.keyTypeId ?? '(none)', `${where} key`);
    if (left.value !== undefined) compareType(left.value, right.valueTypeId ?? '(none)', `${where} value`);
    if (left.base !== undefined) compareType(left.base, right.baseTypeId ?? '(none)', `${where} base`);
    const members = left.members ?? [];
    if (members.length !== (right.members ?? []).length) {
      found.push(`${where}: ${members.length} / ${(right.members ?? []).length} members`);
      return;
    }
    members.forEach((member, at) => {
      const other = right.members[at];
      const name = `${where}.${member.label}`;
      if (member.label !== other.label) found.push(`${name}: label ${other.label}`);
      if (BigInt(member.slot) !== other.slot) found.push(`${name}: slot ${member.slot} / ${other.slot}`);
      if (member.offset !== other.offset) found.push(`${name}: offset ${member.offset} / ${other.offset}`);
      compareType(member.type, other.typeId, name);
    });
  };

  if (forge.storage.length !== parsed.variables.length) {
    found.push(`${forge.storage.length} / ${parsed.variables.length} variables`);
    return found;
  }
  forge.storage.forEach((entry, at) => {
    const variable = parsed.variables[at];
    if (entry.label !== variable.label) found.push(`variable ${at}: label ${entry.label} / ${variable.label}`);
    if (BigInt(entry.slot) !== variable.slot) found.push(`${entry.label}: slot ${entry.slot} / ${variable.slot}`);
    if (entry.offset !== variable.offset) found.push(`${entry.label}: offset ${entry.offset} / ${variable.offset}`);
    compareType(entry.type, variable.typeId, entry.label);
  });
  const typeCount = Object.keys(forge.types).length;
  if (typeCount !== Object.keys(parsed.types).length) {
    found.push(`${typeCount} / ${Object.keys(parsed.types).length} types`);
  }
  return found;
}

const { core } = await loadDecoderCore();
buildIndependent();
const compiled = compileWithSolcJs(core);

const failures = [];
const built = new Set(forgeContracts());
const compiledNames = new Set(compiled.contracts.map(({ name }) => name));
const onlyOne = [...built].filter((name) => !compiledNames.has(name)).concat([...compiledNames].filter((name) => !built.has(name)));
if (onlyOne.length > 0) failures.push(`built by one compiler only: ${onlyOne.join(', ')}`);

let variables = 0;
let target;
for (const { source, name } of compiled.contracts) {
  const forge = forgeLayout(source, name);
  const parsed = compiled.parsedLayout(`${source}:${name}`);
  variables += forge.storage.length;

  // Each run shows that the comparison can fail, on a contract with packed slots and a struct.
  if (name === 'MockStructs') target = { forge, parsed };
  const found = compareLayouts(forge, parsed);
  for (const difference of found) failures.push(`${source}:${name}: ${difference}`);
}

function shifted(layout, label, fieldName) {
  const copy = structuredClone(layout);
  const entry = copy.storage.find((candidate) => candidate.label === label);
  entry[fieldName] = fieldName === 'slot' ? String(BigInt(entry.slot) + 1n) : entry[fieldName] + 1;
  return copy;
}

const positionId = target.forge.storage.find(({ label }) => label === 'position').type;
const corruptions = {
  'a wrong variable slot': shifted(target.forge, 'position', 'slot'),
  'a wrong variable offset': shifted(target.forge, 'position', 'offset'),
  'a wrong member slot': (() => {
    const copy = structuredClone(target.forge);
    copy.types[positionId].members[1].slot = '9';
    return copy;
  })(),
  'a wrong type label': (() => {
    const copy = structuredClone(target.forge);
    copy.types[positionId].label = 'struct Other';
    return copy;
  })(),
};
for (const [name, corrupted] of Object.entries(corruptions)) {
  if (compareLayouts(corrupted, target.parsed).length === 0) failures.push(`the comparison did not notice ${name}`);
}

const files = new Set(compiled.contracts.map(({ source }) => source));
const fixtureFiles = [...files].filter((source) => source.startsWith('fixtures/')).length;
console.log(`compared ${compiled.contracts.length} contracts in ${files.size} files (${fixtureFiles} fixture files), ${variables} variables`);
console.log(`the comparison noticed all ${Object.keys(corruptions).length} deliberate corruptions`);

if (failures.length > 0) {
  console.error(`\n${failures.length} difference(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('every slot, offset and type agrees with forge inspect');
