import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/adapters/**/*.test.ts'],
    environment: 'node',
    // The unit layer is deliberately Hardhat-free and network-free: it drives the whole
    // pipeline from real solc storage layouts plus an in-memory slot map.
    testTimeout: 10_000,
  },
});
