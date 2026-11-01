/**
 * Deploys, seeds and seals the mocks on a local node only, for `run.mjs --local`, using the same
 * plan as the real seed. It sends from a node-managed development account, so no key is involved.
 * The manifest it writes has the schema of the public one and stays in the ignored `.local/`.
 *
 * This is not how Sepolia is deployed. That is `deployments/hh3/scripts/seed.ts`.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ContractFactory, Interface } from 'ethers';
import hre from 'hardhat';
import { makeRedactor } from '../../../scripts/redact.mjs';
import { atomicWriteJson, LOCAL_CHAIN_ID, sourceHash } from '../../shared/manifest.js';
import type { ContractRecord, Manifest, StepRecord } from '../../shared/manifest.js';
import { sealSteps, seedSteps } from '../../shared/seed-plan.js';

const redact = makeRedactor([process.env.EXAMPLE_RPC_URL]);

const SOLC = { version: '0.8.26', optimizer: { enabled: false }, evmVersion: 'cancun' };

interface Receipt {
  transactionHash: string;
  blockNumber: string;
  contractAddress: string | null;
  status: string;
}

async function main(): Promise<void> {
  const chainId = Number(process.env.EXAMPLE_CHAIN);
  if (chainId !== LOCAL_CHAIN_ID) throw new Error('seed-local.ts runs on the local chain only');
  const { provider } = await hre.network.create();
  const [from] = (await provider.request({ method: 'eth_accounts' })) as string[];

  const send = async (to: string | undefined, data: string): Promise<Receipt> => {
    const hash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, data, ...(to === undefined ? {} : { to }) }],
    });
    let receipt: Receipt | null = null;
    while (receipt === null) {
      receipt = (await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      })) as Receipt | null;
      if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (receipt.status !== '0x1') throw new Error(`transaction ${String(hash)} reverted`);
    return receipt;
  };

  const steps: StepRecord[] = [];
  const contracts: Record<string, ContractRecord> = {};
  const seen = new Set<string>();

  for (const step of [...seedSteps(), ...sealSteps()]) {
    const artifact = await hre.artifacts.readArtifact(`contracts/${step.contract}.sol:${step.contract}` as never);
    const face = new Interface(artifact.abi as never);
    const record = contracts[step.contract];
    let receipt: Receipt;
    if (step.fn === undefined) {
      const { data } = await new ContractFactory(face, artifact.bytecode).getDeployTransaction(...step.args);
      receipt = await send(undefined, data);
    } else {
      receipt = await send(record?.address, face.encodeFunctionData(step.fn, step.args));
    }
    const block = Number(receipt.blockNumber);
    steps.push({ id: step.id, nonce: steps.length, txHash: receipt.transactionHash, block });

    if (step.fn === undefined) {
      contracts[step.contract] = {
        address: receipt.contractAddress as string,
        deployBlock: block,
        txHash: receipt.transactionHash,
        sealBlock: null,
        sealTxHash: null,
        expected: {},
      };
      continue;
    }
    const current = contracts[step.contract] as ContractRecord;
    if (step.fn === 'seal') {
      current.sealBlock = block;
      current.sealTxHash = receipt.transactionHash;
    }
    for (const [entry, value] of Object.entries(step.sets)) {
      current.expected[entry] = { value, blockTag: 'latest', requiresArchive: false };
      if (step.recordsRevision === true && !seen.has(`${step.contract}:${block}`)) {
        seen.add(`${step.contract}:${block}`);
        current.expected[`${entry}@${block}`] = { value, blockTag: block, requiresArchive: true };
      }
    }
  }

  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const manifest: Manifest = {
    schemaVersion: 1,
    chains: {
      [String(chainId)]: {
        generations: [
          {
            deployer: from as string,
            repoCommit: commit,
            sourceHash: sourceHash(join(hre.config.paths.root, 'contracts'), SOLC),
            solcSettings: SOLC,
            steps,
            contracts,
          },
        ],
      },
    },
  };
  atomicWriteJson(process.env.EXAMPLE_MANIFEST as string, manifest);
  console.log(`seed: ${steps.length} transactions, ${Object.keys(contracts).length} sealed mocks`);
}

main().catch((error: unknown) => {
  console.error(`seed failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
