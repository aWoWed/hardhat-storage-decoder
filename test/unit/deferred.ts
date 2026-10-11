/**
 * A context whose RPC calls stay pending until the test releases them.
 *
 * That makes "which calls go out together" observable: everything pending when the pipeline
 * goes quiet is one round. `round()` waits for quiescence, reports that set, and releases it.
 */
import type { ParsedStorageLayout } from '../../src/core/layout/parseStorageLayout.js';
import { ContractNotFoundError } from '../../src/core/query/errors.js';
import type { StorageDecoderContext } from '../../src/core/query/StorageQueryBuilder.js';
import type { BlockTag } from '../../src/core/rpc/getStorageAt.js';
import { MockStorage, loadLayout } from './helpers.js';

interface PendingCall {
  readonly label: string;
  readonly settle: () => void;
}

export class DeferredChain {
  readonly storage = new MockStorage();
  /** Artifact bytecode; `undefined` disables the contract/address check. */
  deployed: string | undefined = '0x6080';
  onChain = '0x6080';
  /** Slots whose read rejects instead of resolving. */
  readonly failingSlots = new Map<bigint, Error>();
  codeError: Error | undefined;
  bytecodeError: Error | undefined;
  readonly codeTags: BlockTag[] = [];
  readonly storageTags: BlockTag[] = [];
  #pending: PendingCall[] = [];

  context(layoutFor: (fqn: string) => ParsedStorageLayout = loadLayout): StorageDecoderContext {
    const context: StorageDecoderContext = {
      async getLayout(fqn) {
        try {
          return layoutFor(fqn);
        } catch {
          throw new ContractNotFoundError(fqn);
        }
      },
      getStorageAt: ({ slot, blockTag }) => {
        this.storageTags.push(blockTag);
        return new Promise((resolve, reject) => {
          this.#pending.push({
            label: `slot:${slot}`,
            settle: () => {
              const failure = this.failingSlots.get(slot);
              if (failure !== undefined) reject(failure);
              else resolve(this.storage.get(slot));
            },
          });
        });
      },
    };
    if (this.deployed !== undefined) {
      context.getDeployedBytecode = async () => {
        if (this.bytecodeError !== undefined) throw this.bytecodeError;
        return this.deployed;
      };
      context.getCode = (_address, blockTag) => {
        this.codeTags.push(blockTag);
        return new Promise((resolve, reject) => {
          this.#pending.push({
            label: 'code',
            settle: () => {
              if (this.codeError !== undefined) reject(this.codeError);
              else resolve(this.onChain);
            },
          });
        });
      };
    }
    return context;
  }

  /** Wait until nothing more can happen without a release, then release what is pending. */
  async round(): Promise<string[]> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const batch = this.#pending;
    this.#pending = [];
    for (const call of batch) call.settle();
    return batch.map((call) => call.label).sort();
  }

  /** Release rounds until the pipeline is idle, returning each round's calls. */
  async drain(): Promise<string[][]> {
    const rounds: string[][] = [];
    for (;;) {
      const batch = await this.round();
      if (batch.length === 0) return rounds;
      rounds.push(batch);
    }
  }
}

export function slotLabel(slot: bigint): string {
  return `slot:${slot}`;
}
