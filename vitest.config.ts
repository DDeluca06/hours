import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps,connectors}/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
