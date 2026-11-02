#!/usr/bin/env node
/**
 * Rules the GitHub Actions workflows must hold. They have never run on GitHub, and this checks only
 * what they say.
 *
 *   node scripts/check-workflows.mjs              .github/
 *   node scripts/check-workflows.mjs --dir PATH   a directory shaped like .github/
 *   node scripts/check-workflows.mjs --self-test  a bad copy for each rule must fail
 *
 * Exits 1 on a violation, 2 on usage or when the YAML parser is missing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);

let load;
try {
  ({ load } = await import('js-yaml'));
} catch {
  console.error('js-yaml is not installed: run npm ci');
  process.exit(2);
}

const READBACK = 'readback.yml';
const SECRET_SCAN = 'secret-scan.yml';
const INDEPENDENT = 'independent-checks.yml';
const GITIGNORE = '.gitignore';
const RESULT_FOLDERS = ['independent-results', 'readback-results'];
const NODE_VERSION = '22.14.0';
const FOUNDRY_VERSION = 'v1.5.1';
const MAINNET_CANDIDATES = 'deployments/mainnet/candidates.json';
const PINNED_ACTION = /^[\w.-]+\/[\w.-]+(?:\/[^@]+)?@[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA512 = /^[0-9a-f]{128}$/;
const SECRET_USE = /(?<![-\w])secrets\s*[.[]|\bgithub\.token\b|\bGITHUB_TOKEN\b/;
const NEEDS_NODE = /scripts\/readback\.mjs|npm run clients|prepareDeploymentProjects/;

function triggersOf(workflow) {
  const on = workflow.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return on !== null && typeof on === 'object' ? Object.keys(on) : [];
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function stepsOf(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job?.steps ?? []);
}

function actionSteps(workflow, name) {
  return stepsOf(workflow).filter(({ uses }) => uses?.startsWith(`${name}@`));
}

function runTextOf(workflow) {
  return stepsOf(workflow).map(({ run }) => run ?? '').join('\n');
}

function checkGeneric(name, text, workflow, report) {
  const triggers = triggersOf(workflow);
  if (triggers.length === 0) report('no-trigger', `${name} has no trigger`);
  if (triggers.includes('pull_request_target')) report('pull-request-target', `${name} uses pull_request_target`);
  if (triggers.includes('workflow_run')) report('pull-request-target', `${name} uses workflow_run, which runs with secrets after PR code`);
  if (/github\.(?:event\.pull_request\.head|head_ref)/.test(text)) {
    report('pull-request-target', `${name} refers to the PR head`);
  }

  const usesSecrets = SECRET_USE.test(text) || /^\s*secrets\s*:/m.test(text);
  if (usesSecrets) report('no-secrets', `${name} uses a secret or the token`);
  if (usesSecrets && triggers.includes('pull_request')) {
    report('pull-request-secrets', `${name} uses a secret and runs on pull requests`);
  }

  const permissions = workflow.permissions;
  if (
    permissions === null ||
    typeof permissions !== 'object' ||
    !sameSet(Object.keys(permissions), ['contents']) ||
    permissions.contents !== 'read'
  ) {
    report('permissions', `${name} must declare exactly permissions: contents: read`);
  }

  if (/continue-on-error/.test(text)) report('continue-on-error', `${name} hides a failure with continue-on-error`);

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    if (job.permissions !== undefined) report('permissions', `${name} job ${jobName} sets its own permissions`);
    if (typeof job['runs-on'] !== 'string' || /latest/.test(job['runs-on'])) {
      report('runner-pin', `${name} job ${jobName} must name a runner version`);
    }
    if (job.uses !== undefined && !job.uses.startsWith('./') && !PINNED_ACTION.test(job.uses)) {
      report('unpinned-action', `${name} job ${jobName}: ${job.uses}`);
    }
    const steps = job.steps ?? [];
    const runs = steps.map(({ run }) => run ?? '').join('\n');
    if (NEEDS_NODE.test(runs) && !steps.some(({ uses }) => uses?.startsWith('actions/setup-node@'))) {
      report('node-pin', `${name} job ${jobName} runs Hardhat without setup-node`);
    }
  }

  for (const step of stepsOf(workflow)) {
    if (step.uses !== undefined && !step.uses.startsWith('./') && !PINNED_ACTION.test(step.uses)) {
      report('unpinned-action', `${name}: ${step.uses}`);
    }
    if (step.uses?.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) {
      report('persist-credentials', `${name}: checkout must set persist-credentials: false`);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const uses = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
    if (uses !== null && !uses[1].startsWith('./') && !/#\s*v\d+\.\d+\.\d+\s*$/.test(uses[2])) {
      report('version-comment', `${name}: ${uses[1]} has no version comment`);
    }
  }

  for (const step of actionSteps(workflow, 'actions/setup-node')) {
    if (String(step.with?.['node-version']) !== NODE_VERSION) {
      report('node-pin', `${name}: node-version must be ${NODE_VERSION}`);
    }
  }
  for (const step of actionSteps(workflow, 'foundry-rs/foundry-toolchain')) {
    if (step.with?.version !== FOUNDRY_VERSION) report('foundry-pin', `${name}: Foundry must be ${FOUNDRY_VERSION}`);
  }

  const runText = runTextOf(workflow);
  if (/\bnpm\s+(?:install|i|add|update)\b|\bnpx\b|\byarn\b|\bpnpm\b/.test(runText)) {
    report('npm-ci', `${name} installs by something other than npm ci`);
  }
  if (/deployments\/hh[23]/.test(runText)) {
    report('npm-ci', `${name} touches deployments/hh* itself rather than through prepare-deployment-projects`);
  }
  if (/scripts\/readback\.mjs/.test(runText) && !/\bprepareDeploymentProjects\(\)/.test(runText)) {
    report('npm-ci', `${name} needs prepareDeploymentProjects() before the deployment projects run`);
  }
  if (NEEDS_NODE.test(runText) && !/\bnpm ci\b/.test(runText)) {
    report('npm-ci', `${name} needs npm ci at the root`);
  }
}

function checkReadback(text, workflow, report) {
  if (!sameSet(triggersOf(workflow), ['schedule', 'workflow_dispatch'])) {
    report('readback-trigger', `${READBACK} must run on schedule and workflow_dispatch only`);
  }
  const crons = workflow.on?.schedule ?? [];
  // Five fields, with a fixed day of the week: at most weekly.
  if (crons.length !== 1 || !/^\d+ \d+ \* \* [0-6]$/.test(crons[0]?.cron ?? '')) {
    report('readback-trigger', `${READBACK} must run once a week`);
  }
  if (/READBACK_(?:SECOND_)?RPC_URL/.test(text)) {
    report('keyless', `${READBACK} must use the keyless defaults in scripts/readback.mjs`);
  }
  const run = runTextOf(workflow);
  if (!/^\s*3\)\s*\n\s*echo "::warning[^\n]*[Cc]ould not check/m.test(run)) {
    report('readback-exit-3', `${READBACK}: exit 3 must be a "could not check" warning`);
  }
  if (/^\s*3\)\s*\n(?:(?!;;)[\s\S])*?^\s*exit 1\s*$/m.test(run)) {
    report('readback-exit-3', `${READBACK}: exit 3 must not fail the run`);
  }
  if (!/^\s*1\)\s*\n(?:(?!;;)[\s\S])*?^\s*exit 1\s*$/m.test(run)) {
    report('readback-exit-1', `${READBACK}: exit 1 must fail the run`);
  }
  if (!/^\s*\*\)\s*\n(?:(?!;;)[\s\S])*?^\s*exit 1\s*$/m.test(run)) {
    report('readback-exit-1', `${READBACK}: any other exit must fail the run`);
  }
  if (!/scripts\/readback\.mjs --json readback-results\//.test(run)) {
    report('readback-artifact', `${READBACK} must write its redacted JSON to readback-results/`);
  }
  // The one way a run may stay green having read nothing, and it has to say so.
  const steps = stepsOf(workflow);
  const guard = steps.findIndex(({ run: text }) => /^\s*result="\$\(node scripts\/readback-guard\.mjs\)"$/m.test(text ?? ''));
  const read = steps.findIndex(({ run: text }) => /scripts\/readback\.mjs/.test(text ?? ''));
  if (guard === -1 || steps[guard].id !== 'manifest') {
    report('readback-guard', `${READBACK} must decide on skipping with scripts/readback-guard.mjs, in a step with id manifest`);
  } else if (read < guard || steps[read].if !== "steps.manifest.outputs.no_chains != 'true'") {
    report('readback-guard', `${READBACK} must read back unless the guard found exactly no chains`);
  } else if (!/::notice[^\n]*not a pass/.test(steps[guard].run) || !/\*\*SKIPPED\*\*[^\n]*not a pass[^\n]*GITHUB_STEP_SUMMARY/.test(steps[guard].run)) {
    report('readback-guard', `${READBACK} must report a skip as a skip, and not as a pass`);
  }
  const uploads = actionSteps(workflow, 'actions/upload-artifact');
  if (!uploads.some((step) => step.if === 'always()' && step.with?.path === 'readback-results/')) {
    report('readback-artifact', `${READBACK} must upload readback-results/ on every outcome`);
  }
}

function checkSecretScan(workflow, report) {
  const job = workflow.jobs?.gitleaks;
  if (!VERSION.test(String(job?.env?.GITLEAKS_VERSION))) report('gitleaks-pin', `${SECRET_SCAN}: GITLEAKS_VERSION must be exact`);
  if (!SHA512.test(String(job?.env?.GITLEAKS_SHA512))) report('gitleaks-pin', `${SECRET_SCAN}: GITLEAKS_SHA512 must be a full SHA-512`);
  const run = (job?.steps ?? []).map((step) => step.run ?? '').join('\n');
  if (!/\$GITLEAKS_SHA512[^\n]*\|\s*sha512sum -c -/.test(run)) {
    report('gitleaks-pin', `${SECRET_SCAN}: the download must be checked against GITLEAKS_SHA512`);
  }
  if (!/gitleaks"? git \. --config \.github\/gitleaks\.toml --redact/.test(run)) {
    report('gitleaks-pin', `${SECRET_SCAN}: gitleaks must scan the history with the config and --redact`);
  }
  const checkout = (job?.steps ?? []).find(({ uses }) => uses?.startsWith('actions/checkout@'));
  if (checkout?.with?.['fetch-depth'] !== 0) report('gitleaks-pin', `${SECRET_SCAN}: the scan needs fetch-depth: 0`);
  if (!/^node scripts\/check-manifest-public\.mjs$/m.test(run)) {
    report('manifest-gate', `${SECRET_SCAN} must run scripts/check-manifest-public.mjs`);
  }
}

function checkGitleaksConfig(config, report) {
  if (config === undefined) {
    report('gitleaks-config', 'gitleaks.toml is missing');
    return;
  }
  if (!/^useDefault = true$/m.test(config)) report('gitleaks-config', 'gitleaks.toml must extend the default rules');
  const blocks = config.split('[[allowlists]]').slice(1);
  if (blocks.length === 0) report('gitleaks-config', 'gitleaks.toml has no allowlist');
  // With no target rule, or a path and no line shape, an entry would exempt keys as well.
  const isNarrow = (block) =>
    /^targetRules = \["generic-api-key"\]$/m.test(block) &&
    /^condition = "AND"$/m.test(block) &&
    /^regexes = /m.test(block);
  if (!blocks.every(isNarrow)) {
    report('gitleaks-config', 'every gitleaks allowlist must target generic-api-key and require path and line');
  }
  const secrets = readFileSync(join(ROOT, 'scripts', 'check-secrets.mjs'), 'utf8');
  const local = /BARE_HEX_PATHS = new Set\(\[([\s\S]*?)\]\)/.exec(secrets)?.[1] ?? '';
  const expected = [...local.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const listed = [...config.matchAll(/'''\^([\w/.\\-]+)\$'''/g)].map((match) => match[1].replaceAll('\\.', '.'));
  const manifest = /MANIFEST_PATH = '([^']+)'/.exec(secrets)?.[1];
  if (expected.length === 0 || !sameSet(listed, [...expected, manifest, MAINNET_CANDIDATES])) {
    report('gitleaks-config', 'gitleaks.toml paths differ from the allowlist in check-secrets.mjs');
  }
}

function checkIndependent(text, workflow, report) {
  if (!sameSet(triggersOf(workflow), ['push', 'pull_request', 'schedule', 'workflow_dispatch'])) {
    report('independent-trigger', `${INDEPENDENT} must run on push, pull_request, schedule and workflow_dispatch only`);
  }
  // A path filter would leave a commit with no run, and so with no evidence.
  for (const event of ['push', 'pull_request']) {
    const trigger = workflow.on?.[event];
    if (!sameSet(trigger?.branches ?? [], ['main']) || !sameSet(Object.keys(trigger ?? {}), ['branches'])) {
      report('independent-trigger', `${INDEPENDENT} must run ${event} on main only, with no filter`);
    }
  }
  const job = workflow.jobs?.clients;
  for (const client of ['GETH', 'RETH']) {
    if (!VERSION.test(String(job?.env?.[`${client}_VERSION`]))) report('client-pin', `${INDEPENDENT}: ${client}_VERSION must be exact`);
    if (!SHA512.test(String(job?.env?.[`${client}_SHA512`]))) report('client-pin', `${INDEPENDENT}: ${client}_SHA512 must be a full SHA-512`);
    if (!new RegExp(`\\$${client}_SHA512[^\\n]*\\|\\s*sha512sum -c -`).test(text)) {
      report('client-pin', `${INDEPENDENT}: ${client} must be checked against ${client}_SHA512`);
    }
    if (!new RegExp(`exact "\\$${client}_VERSION"`).test(text)) {
      report('client-pin', `${INDEPENDENT}: the running ${client} version must be asserted`);
    }
    if (!text.includes(`${client}_BIN=`)) report('client-pin', `${INDEPENDENT}: ${client}_BIN must be set`);
  }
  // A bare `grep -q` would take 1.5.10 for a pinned 1.5.1.
  if (!text.includes('exact() { grep -qE "(^|[^0-9.])')) {
    report('client-pin', `${INDEPENDENT}: versions must be matched exactly`);
  }
  if (actionSteps(workflow, 'foundry-rs/foundry-toolchain').length === 0) {
    report('foundry-pin', `${INDEPENDENT} must install Foundry`);
  }
  const run = runTextOf(workflow);
  if (!/npm run clients -- all/.test(run)) report('independent-evidence', `${INDEPENDENT} must run every client`);
  if (!/test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/.test(run)) {
    report('independent-evidence', `${INDEPENDENT} must confirm HEAD is the run's commit`);
  }
  if (!/dirty="\$\(git status --porcelain\)"/.test(run) || !/if \[ -n "\$dirty" \]; then/.test(run)) {
    report('independent-evidence', `${INDEPENDENT} must fail a run that changed tracked files`);
  }
  if (!/^\s*3\)\s*\n(?:(?!;;)[\s\S])*?^\s*exit 1\s*$/m.test(run)) {
    report('independent-evidence', `${INDEPENDENT}: exit 3 must fail the run, since it never counts as a pass`);
  }
  const uploads = actionSteps(workflow, 'actions/upload-artifact');
  if (!uploads.some((step) => step.if === 'always()' && step.with?.path === 'independent-results/')) {
    report('independent-evidence', `${INDEPENDENT} must upload its evidence on every outcome`);
  }
}

/**
 * The result folders the workflows write into their checkout must be ignored, or the dirty-tree
 * check in `independent-checks.yml` fails every run. A copy of `.github` brings its own `.gitignore`, which
 * can only be read; for the real one, git itself is asked.
 */
function checkResultsIgnored(dir, report) {
  const own = join(dir, GITIGNORE);
  const isCopy = existsSync(own);
  let lines = [];
  try {
    lines = readFileSync(isCopy ? own : join(dir, '..', GITIGNORE), 'utf8').split(/\r?\n/).map((line) => line.trim());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const folder of RESULT_FOLDERS) {
    if (!lines.includes(`${folder}/`) || lines.some((line) => line.startsWith(`!${folder}`))) {
      report('results-ignored', `.gitignore must ignore ${folder}/`);
    } else if (!isCopy) {
      const { status } = spawnSync('git', ['check-ignore', '-q', `${folder}/run.txt`], { cwd: join(dir, '..') });
      if (status !== 0) report('results-ignored', `git does not ignore ${folder}/`);
    }
  }
}

/** @returns {{ rule: string, message: string }[]} */
function checkDirectory(dir) {
  const violations = [];
  const report = (rule, message) => violations.push({ rule, message });
  const workflowsDir = join(dir, 'workflows');
  let names = [];
  try {
    names = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const required of [READBACK, SECRET_SCAN, INDEPENDENT]) {
    if (!names.includes(required)) report('missing-workflow', `${required} is missing`);
  }
  for (const name of names) {
    const text = readFileSync(join(workflowsDir, name), 'utf8');
    let workflow;
    try {
      workflow = load(text);
    } catch (error) {
      report('invalid-yaml', `${name}: ${error.reason ?? error.message}`);
      continue;
    }
    if (workflow === null || typeof workflow !== 'object') {
      report('invalid-yaml', `${name} is not a mapping`);
      continue;
    }
    checkGeneric(name, text, workflow, report);
    if (name === READBACK) checkReadback(text, workflow, report);
    if (name === SECRET_SCAN) checkSecretScan(workflow, report);
    if (name === INDEPENDENT) checkIndependent(text, workflow, report);
  }
  let config;
  try {
    config = readFileSync(join(dir, 'gitleaks.toml'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  checkGitleaksConfig(config, report);
  checkResultsIgnored(dir, report);
  return violations;
}

const ACTION_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const TOML = 'gitleaks.toml';

/** Each edit breaks one rule in a copy of the real files. An edit that no longer applies fails too. */
const BAD_COPIES = [
  ['readback triggered by pull requests', READBACK, 'readback-trigger', '  workflow_dispatch:', '  workflow_dispatch:\n  pull_request:'],
  ['readback with no schedule', READBACK, 'readback-trigger', "  schedule:\n    - cron: '17 6 * * 1'\n", ''],
  ['readback run daily', READBACK, 'readback-trigger', '17 6 * * 1', '17 6 * * *'],
  ['readback with no manual start', READBACK, 'readback-trigger', '  workflow_dispatch:\n', ''],
  ['readback given a secret', READBACK, 'no-secrets', 'run: npm ci', 'run: echo ${{ secrets.RPC }} && npm ci'],
  ['readback given a custom endpoint', READBACK, 'keyless', '      - name: Read back\n', '      - name: Read back\n        env:\n          READBACK_RPC_URL: https://rpc.example.org\n'],
  ['readback exit 3 as a failure', READBACK, 'readback-exit-3', 'This is not a pass." >> "$GITHUB_STEP_SUMMARY"\n', 'This is not a pass." >> "$GITHUB_STEP_SUMMARY"\n              exit 1\n'],
  ['readback exit 3 not reported', READBACK, 'readback-exit-3', '::warning title=Could not check::Read-back could not check', '::notice title=Done::Read-back done'],
  ['readback exit 1 passing', READBACK, 'readback-exit-1', 'at $GITHUB_SHA." >> "$GITHUB_STEP_SUMMARY"\n              exit 1\n              ;;\n            *)', 'at $GITHUB_SHA." >> "$GITHUB_STEP_SUMMARY"\n              ;;\n            *)'],
  ['readback with no upload on failure', READBACK, 'readback-artifact', "        if: always()\n", ''],
  ['readback without redacted JSON', READBACK, 'readback-artifact', '--json readback-results/readback.json ', ''],
  ['readback with no guard', READBACK, 'readback-guard', 'result="$(node scripts/readback-guard.mjs)"', 'result="no_chains=true"'],
  ['readback guard that cannot fail', READBACK, 'readback-guard', 'result="$(node scripts/readback-guard.mjs)"', 'result="$(node scripts/readback-guard.mjs || true)"'],
  ['readback that never runs', READBACK, 'readback-guard', "- name: Read back\n        if: steps.manifest.outputs.no_chains != 'true'", '- name: Read back\n        if: false'],
  ['readback skipped on any guard answer', READBACK, 'readback-guard', "- name: Read back\n        if: steps.manifest.outputs.no_chains != 'true'", "- name: Read back\n        if: steps.manifest.outputs.no_chains == 'false'"],
  ['readback run ahead of the guard', READBACK, 'readback-guard', '        id: manifest\n', ''],
  ['a skip reported as a pass', READBACK, 'readback-guard', 'so nothing was read, which is not a pass." >> "$GITHUB_STEP_SUMMARY"', 'so nothing was read." >> "$GITHUB_STEP_SUMMARY"'],
  ['pull_request_target', SECRET_SCAN, 'pull-request-target', '  pull_request:', '  pull_request_target:'],
  ['workflow_run', SECRET_SCAN, 'pull-request-target', '  workflow_dispatch:', '  workflow_dispatch:\n  workflow_run:\n    workflows: [x]'],
  ['checkout of the PR head', SECRET_SCAN, 'pull-request-target', 'fetch-depth: 0', 'fetch-depth: 0\n          ref: ${{ github.event.pull_request.head.sha }}'],
  ['secret on pull-request code', SECRET_SCAN, 'pull-request-secrets', 'run: node scripts/check-secrets.mjs', 'run: echo ${{ secrets.X }}'],
  ['token on pull-request code', SECRET_SCAN, 'pull-request-secrets', 'run: node scripts/check-secrets.mjs', 'run: echo ${{ github.token }}'],
  ['missing permissions', SECRET_SCAN, 'permissions', 'permissions:\n  contents: read\n', ''],
  ['write permission', SECRET_SCAN, 'permissions', 'contents: read', 'contents: write'],
  ['extra permission', SECRET_SCAN, 'permissions', 'contents: read', 'contents: read\n  id-token: write'],
  ['job-level permissions', SECRET_SCAN, 'permissions', '  gitleaks:\n', '  gitleaks:\n    permissions: write-all\n'],
  ['action on a tag', SECRET_SCAN, 'unpinned-action', `actions/checkout@${ACTION_SHA}`, 'actions/checkout@v7'],
  ['action on a short SHA', READBACK, 'unpinned-action', `actions/checkout@${ACTION_SHA}`, `actions/checkout@${ACTION_SHA.slice(0, 12)}`],
  ['SHA with no version recorded', READBACK, 'version-comment', ' # v7.0.1', ''],
  ['credentials left in checkout', READBACK, 'persist-credentials', 'persist-credentials: false', 'persist-credentials: true'],
  ['hidden failure', READBACK, 'continue-on-error', '      - name: Read back\n', '      - name: Read back\n        continue-on-error: true\n'],
  ['floating runner', READBACK, 'runner-pin', 'ubuntu-24.04', 'ubuntu-latest'],
  ['wrong Node', READBACK, 'node-pin', 'node-version: 22.14.0', 'node-version: 22'],
  ['Hardhat with no setup-node', READBACK, 'node-pin', /      - uses: actions\/setup-node@[^\n]*\n        with:\n          node-version: 22\.14\.0\n          package-manager-cache: false\n/, ''],
  ['floating Foundry', INDEPENDENT, 'foundry-pin', `version: ${FOUNDRY_VERSION}`, 'version: stable'],
  ['no Foundry', INDEPENDENT, 'foundry-pin', /      - uses: foundry-rs\/foundry-toolchain@[^\n]*\n        with:\n          version: v1\.5\.1\n          cache: false\n/, ''],
  ['npm install at the root', READBACK, 'npm-ci', 'run: npm ci --no-audit --no-fund', 'run: npm install'],
  ['npm install in deployments/hh3', INDEPENDENT, 'npm-ci', 'run: npm ci --no-audit --no-fund', 'run: npm ci --no-audit --no-fund && cd deployments/hh3'],
  ['projects not prepared', READBACK, 'npm-ci', 'prepareDeploymentProjects();', 'void 0;'],
  ['the manifest gate dropped', SECRET_SCAN, 'manifest-gate', 'run: node scripts/check-manifest-public.mjs', 'run: echo skipped'],
  ['floating gitleaks', SECRET_SCAN, 'gitleaks-pin', 'GITLEAKS_VERSION: 8.30.1', 'GITLEAKS_VERSION: latest'],
  ['gitleaks with no checksum', SECRET_SCAN, 'gitleaks-pin', /      GITLEAKS_SHA512: [0-9a-f]{128}\n/, ''],
  ['gitleaks checksum not checked', SECRET_SCAN, 'gitleaks-pin', '| sha512sum -c -', '| cat'],
  ['shallow scan', SECRET_SCAN, 'gitleaks-pin', 'fetch-depth: 0', 'fetch-depth: 1'],
  ['gitleaks output not redacted', SECRET_SCAN, 'gitleaks-pin', ' --redact', ''],
  ['allowlist exempting every rule', TOML, 'gitleaks-config', 'targetRules = ["generic-api-key"]\ncondition', 'condition'],
  ['allowlist exempting keys by path', TOML, 'gitleaks-config', 'condition = "AND"\nregexTarget', 'regexTarget'],
  ['allowlist wider than Step 1', TOML, 'gitleaks-config', "'''^test/unit/bytes\\.test\\.ts$''',", "'''^test/unit/bytes\\.test\\.ts$''',\n  '''^src/x\\.ts$''',"],
  ['default rules dropped', TOML, 'gitleaks-config', 'useDefault = true', 'useDefault = false'],
  ['floating Geth', INDEPENDENT, 'client-pin', 'GETH_VERSION: 1.17.10', 'GETH_VERSION: latest'],
  ['Reth with no checksum', INDEPENDENT, 'client-pin', /      RETH_SHA512: [0-9a-f]{128}\n/, ''],
  ['Geth checksum not checked', INDEPENDENT, 'client-pin', 'echo "$GETH_SHA512  $RUNNER_TEMP/$geth" | sha512sum -c -\n', ''],
  ['Reth version not asserted', INDEPENDENT, 'client-pin', 'exact "$RETH_VERSION"\n', ''],
  ['versions matched loosely', INDEPENDENT, 'client-pin', 'exact() { grep -qE "(^|[^0-9.])${1//./\\\\.}(\\$|[^0-9.])"', 'exact() { grep -q "$1"'],
  ['independent checks on another pushed branch', INDEPENDENT, 'independent-trigger', '  push:\n    branches:\n      - main\n', '  push:\n    branches:\n      - main\n      - dev\n'],
  ['independent checks on pull requests into another branch', INDEPENDENT, 'independent-trigger', '  pull_request:\n    branches:\n      - main\n', '  pull_request:\n    branches:\n      - main\n      - dev\n'],
  ['independent checks with no pull_request trigger', INDEPENDENT, 'independent-trigger', '  pull_request:\n    branches:\n      - main\n', ''],
  ['independent checks on pull_request_target', INDEPENDENT, 'pull-request-target', '  pull_request:\n', '  pull_request_target:\n'],
  ['independent checks with a path filter', INDEPENDENT, 'independent-trigger', '      - main\n', "      - main\n    paths:\n      - 'src/**'\n"],
  ['independent checks given a secret', INDEPENDENT, 'no-secrets', 'run: npm ci', 'run: echo ${{ secrets.X }} && npm ci'],
  ['client exit 3 as a pass', INDEPENDENT, 'independent-evidence', '(exit 3) at $GITHUB_SHA." >> "$GITHUB_STEP_SUMMARY"\n              exit 1\n', '(exit 3) at $GITHUB_SHA." >> "$GITHUB_STEP_SUMMARY"\n'],
  ['only one client', INDEPENDENT, 'independent-evidence', 'npm run clients -- all', 'npm run clients -- anvil'],
  ['evidence not bound to the commit', INDEPENDENT, 'independent-evidence', 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"\n', ''],
  ['a changed tree not noticed', INDEPENDENT, 'independent-evidence', 'dirty="$(git status --porcelain)"', 'dirty=""'],
  ['evidence not uploaded', INDEPENDENT, 'independent-evidence', 'path: independent-results/', 'path: other/'],
  ['results folder not ignored', GITIGNORE, 'results-ignored', 'independent-results/\n', ''],
  ['part of a results folder not ignored', GITIGNORE, 'results-ignored', 'readback-results/\n', 'readback-results/\n!readback-results/run.txt\n'],
  ['invalid YAML', READBACK, 'invalid-yaml', 'name: Read-back', 'name: [Read-back'],
];

function selfTest() {
  const source = join(ROOT, '.github');
  const originals = new Map([
    [TOML, readFileSync(join(source, TOML), 'utf8')],
    [GITIGNORE, readFileSync(join(ROOT, GITIGNORE), 'utf8').replace(/\r\n/g, '\n')],
  ]);
  for (const name of [READBACK, SECRET_SCAN, INDEPENDENT]) {
    originals.set(name, readFileSync(join(source, 'workflows', name), 'utf8').replace(/\r\n/g, '\n'));
  }
  const scratch = mkdtempSync(join(tmpdir(), 'check-workflows-'));
  const runOn = (edited, skip) => {
    const dir = mkdtempSync(join(scratch, 'copy-'));
    mkdirSync(join(dir, 'workflows'));
    for (const [name, text] of originals) {
      if (name === skip) continue;
      const path = name === TOML || name === GITIGNORE ? join(dir, name) : join(dir, 'workflows', name);
      writeFileSync(path, edited.get(name) ?? text);
    }
    return spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
  };

  const failures = [];
  try {
    const clean = runOn(new Map());
    if (clean.status !== 0) failures.push(`unedited copy failed:\n${clean.stderr}`);

    const cases = [
      ...BAD_COPIES.map(([label, file, rule, from, to]) => ({ label, file, rule, from, to })),
      ...[READBACK, SECRET_SCAN, INDEPENDENT].map((file) => ({ label: `${file} missing`, skip: file, rule: 'missing-workflow' })),
      { label: 'gitleaks.toml missing', skip: TOML, rule: 'gitleaks-config' },
    ];
    for (const { label, file, rule, from, to, skip } of cases) {
      const edited = new Map();
      if (file !== undefined) {
        const original = originals.get(file);
        const changed = original.replace(from, () => to);
        if (changed === original) {
          failures.push(`${label}: the edit no longer applies to ${file}`);
          continue;
        }
        edited.set(file, changed);
      }
      const result = runOn(edited, skip);
      if (result.status === 1 && result.stderr.includes(`[${rule}]`)) {
        console.log(`  caught [${rule}]: ${label}`);
      } else {
        failures.push(`${label}: expected [${rule}] and exit 1, got exit ${result.status}: ${result.stderr.trim()}`);
      }
    }
    if (failures.length > 0) {
      for (const failure of failures) console.error(`  ${failure}`);
      process.exit(1);
    }
    console.log(`workflow rules self-test OK — ${cases.length} bad copies failed, the unedited copy passed`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--self-test' && args.length === 1) {
    selfTest();
    return;
  }
  if (args.length !== 0 && !(args[0] === '--dir' && args.length === 2)) {
    console.error('usage: node scripts/check-workflows.mjs [--dir PATH | --self-test]');
    process.exit(2);
  }
  const violations = checkDirectory(args[1] ?? join(ROOT, '.github'));
  if (violations.length > 0) {
    console.error('workflow rules broken:');
    for (const { rule, message } of violations) console.error(`  [${rule}] ${message}`);
    process.exit(1);
  }
  console.log('workflow rules OK. These files have only been checked here, not run on GitHub.');
}

main();
