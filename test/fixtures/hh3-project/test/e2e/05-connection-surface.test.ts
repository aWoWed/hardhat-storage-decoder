/**
 * Where `.storageDecoder` comes from, and on which connections it exists.
 *
 * The Hardhat 3 adapter attaches the decoder from a `network.newConnection` hook rather than
 * from the HRE, so "is the plugin registered?" and "does every connection carry the decoder?"
 * are two separate questions. `hardhat@3.13.0` has three ways to obtain a connection —
 * `create()`, `getOrCreate()`, and the `@deprecated` `connect()` — and the hook has to fire
 * for all of them, or a consumer following current Hardhat docs would get `undefined` while
 * the rest of this suite (which shares one connection) stayed green.
 *
 * Each connection created here is closed again, so it does not leak into the shared chain the
 * other files use.
 */

import { expect } from 'chai';
import { network } from 'hardhat';
import { StorageQueryBuilder } from 'hardhat-storage-decoder/hardhat3';
import { connect } from './helpers.js';

describe('connection surface', () => {
  it('attaches .storageDecoder to a connection from network.getOrCreate()', async () => {
    const connection = await connect();
    expect(connection.storageDecoder).to.be.instanceOf(StorageQueryBuilder);
  });

  it('attaches .storageDecoder to a connection from network.create()', async () => {
    const connection = await network.create();
    try {
      expect(connection.storageDecoder).to.be.instanceOf(StorageQueryBuilder);
    } finally {
      await connection.close();
    }
  });

  it('attaches .storageDecoder to a connection from the deprecated network.connect()', async () => {
    const connection = await network.connect();
    try {
      expect(connection.storageDecoder).to.be.instanceOf(StorageQueryBuilder);
    } finally {
      await connection.close();
    }
  });

  it('hands back the same builder instance on repeated access', async () => {
    const connection = await connect();
    expect(connection.storageDecoder).to.equal(connection.storageDecoder);
  });

  it('gives separate connections separate builders', async () => {
    const shared = await connect();
    const other = await network.create();
    try {
      expect(other.storageDecoder).to.not.equal(shared.storageDecoder);
    } finally {
      await other.close();
    }
  });
});
