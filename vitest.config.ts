import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Every test mocks the fetcher; the suite must never touch the network.
    env: { COASTWISE_DISABLE_NETWORK: '1' },
  },
});
