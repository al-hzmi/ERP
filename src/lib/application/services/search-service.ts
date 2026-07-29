import { Prisma } from '@prisma/client';
import type { TransactionClient } from '@/lib/infrastructure/db/prisma';
import { prisma } from '@/lib/infrastructure/db/prisma';

/**
 * Intelligent search.
 *
 * The requirement that shapes everything here: typing `1001` must find
 * `BTC-1001`. A user thinks in the part of the code they remember, not in the
 * prefix the system assigned. Three techniques are combined, and the ranking is
 * what makes them useful together rather than merely simultaneously:
 *
 *   1. Exact and prefix matching — an exact hit always outranks a fuzzy one.
 *   2. Substring matching via `ILIKE '%term%'`, which a GIN trigram index serves
 *      without the full scan a leading wildcard would normally force.
 *   3. Trigram similarity for typos, so `Mohamad` finds `Mohammad`.
 *
 * The score is computed in SQL so that ordering and LIMIT happen in the database
 * — fetching every candidate and sorting in Node would be correct and useless.
 */

export type SearchEntity =
  | 'product'
  | 'counterparty'
  | 'account'
  | 'document'
  | 'employee';

export interface SearchHit {
  readonly entity: SearchEntity;
  readonly id: string;
  /** The code, SKU or document number — what the user was probably typing. */
  readonly code: string;
  readonly titleAr: string;
  readonly titleEn: string;
  readonly subtitle: string | null;
  /** 0..1, comparable across entity types. */
  readonly score: number;
  readonly href: string;
}

export interface SearchOptions {
  readonly tenantId: string;
  readonly query: string;
  readonly entities?: readonly SearchEntity[];
  readonly limitPerEntity?: number;
  readonly includeInactive?: boolean;
}

/** Below this, a trigram match is noise rather than a suggestion. */
const SIMILARITY_FLOOR = 0.2;

/**
 * Runs a federated search across the entities the user is looking at.
 *
 * Each entity is queried independently and in parallel, then merged and ranked.
 * Keeping them separate means a slow entity cannot delay the others, and an
 * entity the user has no permission to see is simply not queried.
 */
export async function search(options: SearchOptions): Promise<SearchHit[]> {
  const term = options.query.trim();
  if (term.length < 1) return [];

  const entities = options.entities ?? [
    'product',
    'counterparty',
    'account',
    'document',
    'employee',
  ];
  const limit = options.limitPerEntity ?? 8;

  const results = await Promise.all(
    entities.map((entity) => searchEntity(prisma, entity, term, options.tenantId, limit, options.includeInactive ?? false)),
  );

  return results
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 3);
}

async function searchEntity(
  db: TransactionClient,
  entity: SearchEntity,
  term: string,
  tenantId: string,
  limit: number,
  includeInactive: boolean,
): Promise<SearchHit[]> {
  switch (entity) {
    case 'product':
      return searchProducts(db, term, tenantId, limit, includeInactive);
    case 'counterparty':
      return searchCounterparties(db, term, tenantId, limit, includeInactive);
    case 'account':
      return searchAccounts(db, term, tenantId, limit, includeInactive);
    case 'document':
      return searchDocuments(db, term, tenantId, limit);
    case 'employee':
      return searchEmployees(db, term, tenantId, limit, includeInactive);
    default:
      return [];
  }
}

/**
 * The shared ranking expression.
 *
 * Ordered by decreasing confidence: an exact code match is certainly what the
 * user meant; a prefix match almost certainly is; a substring match on the code
 * is what makes `1001` find `BTC-1001`; a name match is next; and trigram
 * similarity is the fallback that catches typos.
 */
function scoreExpression(codeColumn: Prisma.Sql, nameArColumn: Prisma.Sql, nameEnColumn: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`
    GREATEST(
      CASE WHEN lower(${codeColumn}) = lower(${term})           THEN 1.00 ELSE 0 END,
      CASE WHEN ${codeColumn} ILIKE ${term + '%'}               THEN 0.92 ELSE 0 END,
      CASE WHEN ${codeColumn} ILIKE ${'%' + term + '%'}         THEN 0.85 ELSE 0 END,
      CASE WHEN ${nameArColumn} ILIKE ${term + '%'}             THEN 0.80 ELSE 0 END,
      CASE WHEN ${nameEnColumn} ILIKE ${term + '%'}             THEN 0.78 ELSE 0 END,
      CASE WHEN ${nameArColumn} ILIKE ${'%' + term + '%'}       THEN 0.70 ELSE 0 END,
      CASE WHEN ${nameEnColumn} ILIKE ${'%' + term + '%'}       THEN 0.68 ELSE 0 END,
      similarity(${codeColumn}, ${term}) * 0.6,
      similarity(${nameArColumn}, ${term}) * 0.55,
      similarity(${nameEnColumn}, ${term}) * 0.55
    )
  `;
}

async function searchProducts(
  db: TransactionClient,
  term: string,
  tenantId: string,
  limit: number,
  includeInactive: boolean,
): Promise<SearchHit[]> {
  const rows = await db.$queryRaw<
    { id: string; sku: string; nameAr: string; nameEn: string; salePrice: string; score: number }[]
  >`
    SELECT p."id", p."sku", p."nameAr", p."nameEn",
           p."salePrice"::text AS "salePrice",
           ${scoreExpression(Prisma.sql`p."sku"`, Prisma.sql`p."nameAr"`, Prisma.sql`p."nameEn"`, term)}::float8 AS score
      FROM "products" p
     WHERE p."tenantId" = ${tenantId}::uuid
       AND (${includeInactive} OR p."isActive")
       AND (
            p."sku"     ILIKE ${'%' + term + '%'}
         OR p."nameAr"  ILIKE ${'%' + term + '%'}
         OR p."nameEn"  ILIKE ${'%' + term + '%'}
         OR p."barcode" ILIKE ${'%' + term + '%'}
         OR similarity(p."sku", ${term})    > ${SIMILARITY_FLOOR}
         OR similarity(p."nameAr", ${term}) > ${SIMILARITY_FLOOR}
         OR similarity(p."nameEn", ${term}) > ${SIMILARITY_FLOOR}
       )
     ORDER BY score DESC, p."sku"
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    entity: 'product' as const,
    id: row.id,
    code: row.sku,
    titleAr: row.nameAr,
    titleEn: row.nameEn,
    subtitle: `${row.salePrice} SAR`,
    score: row.score,
    href: `/inventory/products/${row.id}`,
  }));
}

async function searchCounterparties(
  db: TransactionClient,
  term: string,
  tenantId: string,
  limit: number,
  includeInactive: boolean,
): Promise<SearchHit[]> {
  const rows = await db.$queryRaw<
    {
      id: string;
      code: string;
      nameAr: string;
      nameEn: string;
      phone: string | null;
      type: string;
      score: number;
    }[]
  >`
    SELECT c."id", c."code", c."nameAr", c."nameEn", c."phone", c."type"::text AS type,
           GREATEST(
             ${scoreExpression(Prisma.sql`c."code"`, Prisma.sql`c."nameAr"`, Prisma.sql`c."nameEn"`, term)},
             CASE WHEN c."phone"     ILIKE ${'%' + term + '%'} THEN 0.75 ELSE 0 END,
             CASE WHEN c."email"     ILIKE ${'%' + term + '%'} THEN 0.72 ELSE 0 END,
             CASE WHEN c."taxNumber" ILIKE ${'%' + term + '%'} THEN 0.88 ELSE 0 END
           )::float8 AS score
      FROM "counterparties" c
     WHERE c."tenantId" = ${tenantId}::uuid
       AND (${includeInactive} OR c."isActive")
       AND (
            c."code"      ILIKE ${'%' + term + '%'}
         OR c."nameAr"    ILIKE ${'%' + term + '%'}
         OR c."nameEn"    ILIKE ${'%' + term + '%'}
         OR c."phone"     ILIKE ${'%' + term + '%'}
         OR c."email"     ILIKE ${'%' + term + '%'}
         OR c."taxNumber" ILIKE ${'%' + term + '%'}
         OR similarity(c."nameAr", ${term}) > ${SIMILARITY_FLOOR}
         OR similarity(c."nameEn", ${term}) > ${SIMILARITY_FLOOR}
       )
     ORDER BY score DESC, c."code"
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    entity: 'counterparty' as const,
    id: row.id,
    code: row.code,
    titleAr: row.nameAr,
    titleEn: row.nameEn,
    subtitle: row.phone,
    score: row.score,
    href:
      row.type === 'SUPPLIER'
        ? `/procurement/suppliers/${row.id}`
        : `/sales/customers/${row.id}`,
  }));
}

async function searchAccounts(
  db: TransactionClient,
  term: string,
  tenantId: string,
  limit: number,
  includeInactive: boolean,
): Promise<SearchHit[]> {
  const rows = await db.$queryRaw<
    { id: string; code: string; nameAr: string; nameEn: string; balance: string; score: number }[]
  >`
    SELECT a."id", a."code", a."nameAr", a."nameEn", a."balance"::text AS balance,
           ${scoreExpression(Prisma.sql`a."code"`, Prisma.sql`a."nameAr"`, Prisma.sql`a."nameEn"`, term)}::float8 AS score
      FROM "accounts" a
     WHERE a."tenantId" = ${tenantId}::uuid
       AND (${includeInactive} OR a."isActive")
       AND (
            a."code"   ILIKE ${'%' + term + '%'}
         OR a."nameAr" ILIKE ${'%' + term + '%'}
         OR a."nameEn" ILIKE ${'%' + term + '%'}
         OR similarity(a."nameAr", ${term}) > ${SIMILARITY_FLOOR}
       )
     ORDER BY score DESC, a."code"
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    entity: 'account' as const,
    id: row.id,
    code: row.code,
    titleAr: row.nameAr,
    titleEn: row.nameEn,
    subtitle: row.balance,
    score: row.score,
    href: `/finance/accounts/${row.id}`,
  }));
}

async function searchDocuments(
  db: TransactionClient,
  term: string,
  tenantId: string,
  limit: number,
): Promise<SearchHit[]> {
  const rows = await db.$queryRaw<
    {
      id: string;
      documentNumber: string;
      type: string;
      status: string;
      total: string;
      counterpartyName: string;
      score: number;
    }[]
  >`
    SELECT d."id", d."documentNumber", d."type"::text AS type, d."status"::text AS status,
           d."total"::text AS total, c."nameAr" AS "counterpartyName",
           GREATEST(
             CASE WHEN lower(d."documentNumber") = lower(${term}) THEN 1.00 ELSE 0 END,
             CASE WHEN d."documentNumber" ILIKE ${term + '%'}     THEN 0.92 ELSE 0 END,
             CASE WHEN d."documentNumber" ILIKE ${'%' + term + '%'} THEN 0.85 ELSE 0 END,
             CASE WHEN c."nameAr" ILIKE ${'%' + term + '%'}       THEN 0.65 ELSE 0 END,
             similarity(d."documentNumber", ${term}) * 0.6
           )::float8 AS score
      FROM "documents" d
      JOIN "counterparties" c ON c."id" = d."counterpartyId"
     WHERE d."tenantId" = ${tenantId}::uuid
       AND (
            d."documentNumber" ILIKE ${'%' + term + '%'}
         OR c."nameAr" ILIKE ${'%' + term + '%'}
         OR similarity(d."documentNumber", ${term}) > ${SIMILARITY_FLOOR}
       )
     ORDER BY score DESC, d."issueDate" DESC
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    entity: 'document' as const,
    id: row.id,
    code: row.documentNumber,
    titleAr: row.counterpartyName,
    titleEn: row.counterpartyName,
    subtitle: `${row.total} — ${row.status}`,
    score: row.score,
    href: row.type.startsWith('SALES')
      ? `/sales/invoices/${row.id}`
      : `/procurement/invoices/${row.id}`,
  }));
}

async function searchEmployees(
  db: TransactionClient,
  term: string,
  tenantId: string,
  limit: number,
  includeInactive: boolean,
): Promise<SearchHit[]> {
  const rows = await db.$queryRaw<
    {
      id: string;
      employeeNumber: string;
      fullNameAr: string;
      fullNameEn: string;
      jobTitleAr: string;
      score: number;
    }[]
  >`
    SELECT e."id", e."employeeNumber", e."fullNameAr", e."fullNameEn", e."jobTitleAr",
           ${scoreExpression(
             Prisma.sql`e."employeeNumber"`,
             Prisma.sql`e."fullNameAr"`,
             Prisma.sql`e."fullNameEn"`,
             term,
           )}::float8 AS score
      FROM "employees" e
     WHERE e."tenantId" = ${tenantId}::uuid
       AND (${includeInactive} OR e."isActive")
       AND (
            e."employeeNumber" ILIKE ${'%' + term + '%'}
         OR e."fullNameAr"     ILIKE ${'%' + term + '%'}
         OR e."fullNameEn"     ILIKE ${'%' + term + '%'}
         OR similarity(e."fullNameAr", ${term}) > ${SIMILARITY_FLOOR}
         OR similarity(e."fullNameEn", ${term}) > ${SIMILARITY_FLOOR}
       )
     ORDER BY score DESC, e."employeeNumber"
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    entity: 'employee' as const,
    id: row.id,
    code: row.employeeNumber,
    titleAr: row.fullNameAr,
    titleEn: row.fullNameEn,
    subtitle: row.jobTitleAr,
    score: row.score,
    href: `/hr/employees/${row.id}`,
  }));
}
