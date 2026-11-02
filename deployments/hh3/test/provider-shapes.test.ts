/**
 * Each failure of `fake-rpc-server.mjs`'s table, through this project's pinned Hardhat 3 provider,
 * the built plugin and its retry layer. The classes are checked by the requests that reach the
 * server, since the package does not export its classifier; `test/adapters/realProviderShapes.test.ts`
 * checks them directly, on the root's Hardhat 3.
 */

import { expect } from 'chai';
import hre from 'hardhat';
import { classifyReadFailure } from 'hardhat-storage-decoder/hardhat3';
import { SHAPE_CASES, requestsFor, startFakeRpc } from '../../shared/fake-rpc-server.mjs';

const FQN = 'contracts/MockValueTypes.sol:MockValueTypes';
const ADDRESS = '0x0000000000000000000000000000000000000001';

describe('provider failure shapes (Hardhat 3)', () => {
  for (const shape of SHAPE_CASES) {
    it(`${shape.name} is ${shape.hh3}`, async function () {
      this.timeout(60_000);
      const server = await startFakeRpc({ rule: () => shape.reply });
      try {
        const connection = await hre.network.create({
          network: 'readback',
          override: { url: server.url, timeout: 5000 },
        } as never);
        const error = await (connection as unknown as { storageDecoder: any }).storageDecoder
          .contract(FQN)
          .target(ADDRESS)
          .name('revision')
          .at(5)
          .read()
          .then(
            () => undefined,
            (failure: unknown) => failure
          );
        await connection.close();
        expect(error).to.be.instanceOf(Error);
        expect(classifyReadFailure(error)).to.equal(shape.hh3 === 'pruned' ? 'pruned' : 'rpc');
        expect(server.count('eth_getCode')).to.equal(requestsFor(shape, shape.hh3));
      } finally {
        await server.close();
      }
    });
  }
});
