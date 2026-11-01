#!/usr/bin/env node
/**
 * Build the package, install it into both deployment projects and run their suites.
 *
 * Hardhat 3 needs Node >= 22.13, so its project runs under `npx -y node@22.14` when the local
 * Node is older. Hardhat 2 runs on the local Node.
 */
import {
  HARDHAT3_CLI,
  HH2,
  HH3,
  prepareDeploymentProjects,
  run,
} from './prepare-deployment-projects.mjs';

function hardhat3(...args) {
  const [command, ...prefix] = HARDHAT3_CLI;
  run(command, [...prefix, ...args], HH3);
}

prepareDeploymentProjects();

run('npm', ['run', 'typecheck'], HH2);
run('npx', ['hardhat', 'test'], HH2);

run('npm', ['run', 'typecheck'], HH3);
hardhat3('test', 'mocha');
