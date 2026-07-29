import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/lib/domain/**', 'src/lib/application/**', 'src/lib/utils/**'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@domain': resolve(__dirname, './src/lib/domain'),
      '@application': resolve(__dirname, './src/lib/application'),
      '@infrastructure': resolve(__dirname, './src/lib/infrastructure'),
    },
  },
});
