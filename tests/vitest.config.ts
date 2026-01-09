/**
 * Vitest configuration for integration tests
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: path.resolve(__dirname, '..'),
    include: ['tests/integration/**/*.integration.test.ts'],
    testTimeout: 120000, // 2 minutes for API calls
    hookTimeout: 60000,
    // Run tests sequentially to avoid overwhelming external services
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Output more details
    reporters: ['verbose'],
    // Don't fail on console output
    silent: false,
  },
  resolve: {
    alias: {
      '@flume/core': path.resolve(__dirname, '../packages/flume-core/src/index.js'),
      '@yi/adapter': path.resolve(__dirname, '../packages/yi-adapter/src/index.js'),
      '@yi/echo': path.resolve(__dirname, '../packages/yi-echo/src/index.js'),
      '@yi/claude': path.resolve(__dirname, '../packages/yi-claude/src/index.js'),
      '@yi/letta': path.resolve(__dirname, '../packages/yi-letta/src/index.js'),
    },
  },
});
