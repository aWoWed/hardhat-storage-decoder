/**
 * Each failure of `fake-rpc-server.mjs`'s table, through this project's pinned Hardhat 2 provider,
 * the built plugin and its retry layer. The classes are checked by the requests that reach the
 * server, since the package does not export its classifier; `test/adapters/realProviderShapes.test.ts`
 * checks them directly.
 */

import { expect } from 'chai';
import hre from 'hardhat';
import { HttpProvider } from 'hardhat/internal/core/providers/http';
import { classifyReadFailure, createHardhatStorageDecoder } from 'hardhat-storage-decoder/hardhat2';

const FQN = 'contracts/MockValueTypes.sol:MockValueTypes';
const ADDRESS = '0x0000000000000000000000000000000000000001';

describe('provider failure shapes (Hardhat 2)', () => {
  before(async function () {
    this.timeout(300_000);
    await hre.run('compile', { quiet: true });
  });

  it('gives each failure its class, through a real read', async function () {
    this.timeout(120_000);
    const { SHAPE_CASES, requestsFor, startFakeRpc } = await import('../../shared/fake-rpc-server.mjs');
    for (const shape of SHAPE_CASES) {
      const server = await startFakeRpc({ rule: () => shape.reply });
      try {
        const provider = new HttpProvider(server.url, 'fake', {}, 5000);
        const send = (method: string, params: unknown[]) => provider.request({ method, params });
        const decoder = createHardhatStorageDecoder(
          Object.create(hre, { network: { value: { provider: { send } } } })
        );
        const error = await decoder
          .contract(FQN)
          .target(ADDRESS)
          .name('revision')
          .at(5)
          .read()
          .then(() => undefined, (failure: unknown) => failure);
        expect(error, shape.name).to.be.instanceOf(Error);
        expect(classifyReadFailure(error), shape.name).to.equal(shape.hh2 === 'pruned' ? 'pruned' : 'rpc');
        expect(server.count('eth_getCode'), shape.name).to.equal(requestsFor(shape, shape.hh2));
      } finally {
        await server.close();
      }
    }
  });
});
