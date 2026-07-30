import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    /**
     * One test file at a time.
     *
     * Not a preference. The integration suites all post journals, every posting allocates a
     * document number, and `erp_next_document_number` does an `INSERT … ON CONFLICT` on
     * `number_sequences` inside the caller's `SERIALIZABLE` transaction. Under Postgres's
     * serialisable snapshot isolation that takes predicate locks on the unique index, so
     * concurrent allocations conflict *across tenants* — different rows, same index pages.
     *
     * `withTransaction` retries a serialisation failure five times and almost always wins, but
     * with six suites posting at once the budget was being exhausted roughly one run in three.
     * The failures were real and the retries were working; there were simply more contenders
     * than the budget was sized for.
     *
     * Running files serially removes a contention level the harness invented and the product
     * does not have — a real deployment does not run six month-end closes against one database
     * in the same second. It costs about five seconds on a twenty-second suite.
     *
     * It does NOT fix the underlying contention, which is a genuine limitation of the numbering
     * function under serialisable isolation and is recorded in README.md under known gaps. A
     * flaky suite would only have hidden it.
     */
    fileParallelism: false,
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
