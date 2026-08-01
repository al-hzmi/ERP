import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TREATMENTS,
  TREATMENT_LABELS_AR,
  TREATMENT_NOTES_AR,
  ZATCA_CATEGORY,
} from '@/lib/commercial/tax-labels';

/**
 * The tax-code vocabulary.
 *
 * These are constants, so the only thing worth asserting is that they agree with the database
 * that enforces them. Migration 017 carries a CHECK constraint pairing each treatment with its
 * ZATCA letter, and `ZATCA_CATEGORY` is the same mapping written a second time in TypeScript
 * so a client component can render it without a round trip.
 *
 * Two copies of one rule is exactly the shape that drifts, so the last test reads the migration
 * and asserts the pairs match. It is the same drift guard used for the Arabic normaliser and
 * for the ageing buckets, and it is here for the same reason: the copies are correct today.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), 'prisma/migrations/20260810000000_tax_codes/migration.sql'),
  'utf8',
);

describe('the treatment vocabulary', () => {
  it('labels and explains every treatment', () => {
    // A treatment added to the enum without a label renders as `undefined` in the dropdown,
    // which is worse than not offering it at all.
    for (const treatment of TREATMENTS) {
      expect(TREATMENT_LABELS_AR[treatment]).toBeTruthy();
      expect(TREATMENT_NOTES_AR[treatment]).toBeTruthy();
      expect(ZATCA_CATEGORY[treatment]).toMatch(/^[SZEO]$/);
    }
  });

  it('gives each treatment a distinct ZATCA letter', () => {
    const letters = TREATMENTS.map((treatment) => ZATCA_CATEGORY[treatment]);
    expect(new Set(letters).size).toBe(TREATMENTS.length);
  });

  it('distinguishes zero-rated from exempt, which is the whole point of the table', () => {
    // Both are 0%. If they shared a letter there would be no reason for the table to exist —
    // a plain rate column would carry the same information.
    expect(ZATCA_CATEGORY.ZERO_RATED).toBe('Z');
    expect(ZATCA_CATEGORY.EXEMPT).toBe('E');
    expect(ZATCA_CATEGORY.ZERO_RATED).not.toBe(ZATCA_CATEGORY.EXEMPT);
  });
});

describe('drift against the database', () => {
  it('maps every treatment to the letter the CHECK constraint requires', () => {
    for (const treatment of TREATMENTS) {
      const expected = ZATCA_CATEGORY[treatment];
      // The constraint is written as: ("treatment" = 'X' AND "zatcaCode" = 'Y')
      const pattern = new RegExp(
        `"treatment"\\s*=\\s*'${treatment}'\\s*AND\\s*"zatcaCode"\\s*=\\s*'${expected}'`,
      );
      expect(MIGRATION).toMatch(pattern);
    }
  });

  it('declares the same four treatments the enum does', () => {
    const enumBlock = /CREATE TYPE "TaxTreatment" AS ENUM \(([\s\S]*?)\);/.exec(MIGRATION);
    expect(enumBlock).not.toBeNull();

    const declared = [...(enumBlock?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(declared.sort()).toEqual([...TREATMENTS].sort());
  });

  it('forces a non-standard treatment to a zero rate', () => {
    // The rule that makes "zero-rated at 15%" unrepresentable rather than merely discouraged.
    expect(MIGRATION).toMatch(/"treatment"\s*=\s*'STANDARD'\s*AND\s*"rate"\s*>\s*0/);
    expect(MIGRATION).toMatch(/"treatment"\s*<>\s*'STANDARD'\s*AND\s*"rate"\s*=\s*0/);
  });

  it('permits only one default per tenant', () => {
    // A partial unique index, not a convention. Two defaults would make the invoice form's
    // pre-filled rate depend on which row the planner returned first.
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX[\s\S]{0,120}"tax_codes"\s*\("tenantId"\)\s*WHERE\s*"isDefault"/,
    );
  });
});
