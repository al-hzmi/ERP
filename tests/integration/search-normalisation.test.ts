import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compactCode, normalizeSearchTerm } from '@/lib/search/normalize';
import { search } from '@/lib/application/services/search-service';

/**
 * Search normalisation, against a real PostgreSQL.
 *
 * ## The drift guard
 *
 * The same rule set exists twice — `src/lib/search/normalize.ts` folds the *term* in Node,
 * `erp_normalize_search()` folds the *column* in PostgreSQL — because the comparison has to
 * happen in the database for the trigram indexes to be usable. Two implementations of one
 * rule set drift, and the failure is silent: a query stops matching and nothing errors.
 *
 * So the first block runs a table of inputs through both and asserts they agree character for
 * character. Adding a rule to one without the other fails here, which is the only reason it
 * is safe to have two.
 *
 * ## The queries this exists for
 *
 * The second block is the four searches that returned zero rows before migration 012, run
 * end to end through the real service against real seeded-shape data.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

/**
 * Every case both implementations must agree on.
 *
 * Deliberately includes the things that must *not* change — a bare hamza, Latin text, an
 * empty string — because a normaliser that folds too much is as broken as one that folds too
 * little, and only the negative cases catch that.
 */
const CASES = [
  'BTC-1038',
  'btc 1038',
  '١٠٣٨',
  '۱۰۳۸',
  'BTC-١٠٣٨',
  'الصفوة',
  'الصفوه',
  'الأفق',
  'الافق',
  'إدارة',
  'آخر',
  'مستشفى',
  'مستشفي',
  'مُحَمَّد',
  'محـــمد',
  'مسؤول',
  'رئيس',
  'کتاب',
  'ماء',
  'ABC',
  'abc',
  '',
  'شركة الصفوة للخدمات',
  'CUS-0001',
  '٥٠٠.٧٥',
] as const;

let tenantId = '';

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('search normalisation', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the TypeScript and SQL implementations agree', () => {
    it('normalises every case identically', async () => {
      const rows = await prisma.$queryRaw<{ input: string; normalised: string }[]>`
        SELECT t.input, erp_normalize_search(t.input) AS normalised
          FROM unnest(${CASES as unknown as string[]}::text[]) AS t(input)
      `;

      expect(rows).toHaveLength(CASES.length);

      const disagreements: string[] = [];
      for (const row of rows) {
        const inNode = normalizeSearchTerm(row.input);
        // `normalizeSearchTerm` also collapses whitespace and trims, which the SQL function
        // does not need to do — the column values are already stored trimmed. Comparison is
        // against the SQL output with the same collapse applied, so the test measures the
        // *folding* rules rather than a whitespace policy neither side disagrees about.
        const inSql = row.normalised.replace(/\s+/g, ' ').trim();
        if (inNode !== inSql) {
          disagreements.push(`${JSON.stringify(row.input)}: node=${inNode} sql=${inSql}`);
        }
      }

      expect(disagreements).toEqual([]);
    });

    it('compacts codes identically', async () => {
      const rows = await prisma.$queryRaw<{ input: string; compacted: string }[]>`
        SELECT t.input, erp_compact_code(t.input) AS compacted
          FROM unnest(${CASES as unknown as string[]}::text[]) AS t(input)
      `;

      const disagreements: string[] = [];
      for (const row of rows) {
        if (compactCode(row.input) !== row.compacted) {
          disagreements.push(
            `${JSON.stringify(row.input)}: node=${compactCode(row.input)} sql=${row.compacted}`,
          );
        }
      }

      expect(disagreements).toEqual([]);
    });

    it('keeps the SQL function IMMUTABLE, or its indexes are illegal', async () => {
      // An expression index requires immutability. If somebody makes the function
      // STABLE the indexes silently stop being creatable on the next deploy.
      const [row] = await prisma.$queryRaw<{ volatile: string }[]>`
        SELECT provolatile::text AS volatile FROM pg_proc WHERE proname = 'erp_normalize_search'
      `;
      expect(row?.volatile).toBe('i');
    });
  });

  describe('the queries that used to return nothing', () => {
    beforeAll(async () => {
      const code = `SRCH_${randomUUID().slice(0, 8)}`;

      const tenant = await prisma.tenant.create({
        data: { code, nameAr: 'بحث', nameEn: 'Search' },
        select: { id: true },
      });
      tenantId = tenant.id;

      const [category, uom] = await Promise.all([
        prisma.category.create({
          data: { tenantId, code: 'C1', nameAr: 'تصنيف', nameEn: 'Category' },
          select: { id: true },
        }),
        prisma.unitOfMeasure.create({
          data: { tenantId, code: 'EA', nameAr: 'حبة', nameEn: 'Each' },
          select: { id: true },
        }),
      ]);

      await prisma.product.create({
        data: {
          tenantId,
          sku: 'BTC-1038',
          nameAr: 'سماعات رأس',
          nameEn: 'Headphones',
          categoryId: category.id,
          unitOfMeasureId: uom.id,
          salePrice: '100.0000',
          costPrice: '60.0000',
        },
      });

      await prisma.counterparty.createMany({
        data: [
          {
            tenantId,
            code: 'CUS-0001',
            type: 'CUSTOMER',
            nameAr: 'شركة الصفوة للخدمات',
            nameEn: 'Safwa Services',
          },
          {
            tenantId,
            code: 'CUS-0002',
            type: 'CUSTOMER',
            nameAr: 'مجموعة الأفق التجارية',
            nameEn: 'Ufuq Trading',
          },
          {
            tenantId,
            code: 'CUS-0003',
            type: 'CUSTOMER',
            nameAr: 'شركة الصفوة للتوريدات',
            nameEn: 'Safwa Supplies',
          },
        ],
      });
    });

    it('finds a product typed in Arabic-Indic digits', async () => {
      // The application *prints* these digits, so this query was the system failing to find
      // what it had just displayed.
      const hits = await search({ tenantId, query: '١٠٣٨', entities: ['product'] });
      expect(hits.map((hit) => hit.code)).toContain('BTC-1038');
    });

    it('finds a product typed without the separator', async () => {
      const hits = await search({ tenantId, query: 'BTC1038', entities: ['product'] });
      expect(hits[0]?.code).toBe('BTC-1038');
      // An exact match after folding, not a trigram guess.
      expect(hits[0]?.score).toBe(1);
    });

    it('still finds a product by digits alone', async () => {
      // The behaviour that already worked before any of this. Kept as a test because the
      // normalisation rewrite touched every WHERE clause it depends on.
      const hits = await search({ tenantId, query: '1038', entities: ['product'] });
      expect(hits[0]?.code).toBe('BTC-1038');
    });

    it('finds a counterparty spelled with ه where the data has ة', async () => {
      const hits = await search({ tenantId, query: 'الصفوه', entities: ['counterparty'] });
      expect(hits.length).toBeGreaterThanOrEqual(2);
    });

    it('finds a counterparty typed without the hamza', async () => {
      const hits = await search({ tenantId, query: 'الافق', entities: ['counterparty'] });
      expect(hits.map((hit) => hit.code)).toContain('CUS-0002');
    });

    it('matches two words that are not adjacent in the name', async () => {
      // `شركة الصفوة للخدمات` — the words are separated by text the user did not type, so a
      // single ILIKE cannot reach it.
      const hits = await search({ tenantId, query: 'صفوة خدمات', entities: ['counterparty'] });
      expect(hits.map((hit) => hit.code)).toContain('CUS-0001');
    });

    it('narrows rather than widens as a second word is added', async () => {
      const one = await search({ tenantId, query: 'الصفوة', entities: ['counterparty'] });
      const two = await search({ tenantId, query: 'الصفوة خدمات', entities: ['counterparty'] });
      expect(two.length).toBeLessThan(one.length);
      expect(two.map((hit) => hit.code)).toContain('CUS-0001');
    });

    it('ranks the row matching both words above one matching only the first', async () => {
      const hits = await search({ tenantId, query: 'صفوة خدمات', entities: ['counterparty'] });
      expect(hits[0]?.code).toBe('CUS-0001');
    });

    it('returns nothing for a query of only punctuation', async () => {
      // `compactCode('---')` is empty, and an empty code form must be skipped rather than
      // becoming `LIKE '%%'` — which would return the entire table.
      const hits = await search({ tenantId, query: '---', entities: ['product'] });
      expect(hits).toEqual([]);
    });

    it('browses rather than returning nothing for an empty query', async () => {
      // This assertion used to be `toEqual([])`, and that contract was the defect behind
      // "the invoice screen does not respond": a picker opened but not typed into asked for
      // an empty query, got nothing, and rendered an empty box. An empty query now means
      // "show me the start of the list", which is what a dropdown is expected to do.
      const browsed = await search({ tenantId, query: '   ', entities: ['product'] });

      expect(browsed.length).toBeGreaterThan(0);
      // Everything scores 0 when browsing, so the SQL-side `ORDER BY sku` survives.
      expect(browsed.every((hit) => hit.score === 0)).toBe(true);
    });

    it('still returns nothing for a query that is real but matches nothing', async () => {
      // The distinction that keeps browse mode safe. A term of pure punctuation tokenises to
      // nothing, and it must not widen to every row the way an empty term deliberately does.
      expect(await search({ tenantId, query: '...', entities: ['product'] })).toEqual([]);
      expect(await search({ tenantId, query: 'zzzzzqqq', entities: ['product'] })).toEqual([]);
    });
  });
});
