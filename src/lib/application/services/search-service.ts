import { Prisma } from '@prisma/client';
import type { RawQueryClient } from '@/lib/infrastructure/db/prisma';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { compactCode, normalizeSearchTerm, tokenize } from '@/lib/search/normalize';

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
 *
 * ## Normalisation (migration 012)
 *
 * The three techniques above all compare raw text, which left four kinds of query returning
 * nothing against the seeded company:
 *
 *   - `١٠٣٨` — Arabic-Indic digits. Self-inflicted: `formatQuantity` *prints* them, so the
 *     application rendered codes its own search could not find.
 *   - `BTC1038` — the separator is a house style nobody types back.
 *   - `الصفوه` for `الصفوة`, `الافق` for `الأفق` — ordinary Arabic spelling variance.
 *
 * So every comparison now runs through `erp_normalize_search()` / `erp_compact_code()` on the
 * column and `normalizeSearchTerm()` / `compactCode()` on the term. Migration 012 carries
 * trigram expression indexes on exactly those expressions, so the normalised comparison is
 * still index-served rather than a sequential scan.
 *
 * ## Multi-token
 *
 * `صفوة خدمات` finds `شركة الصفوة للخدمات`, which no single `ILIKE` can — the words are
 * separated by text the user did not type. Every token must match *somewhere* in the row, so
 * adding a word narrows the result, which is what a search box is expected to do.
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
  /**
   * Where selecting this hit goes — or `null` when nothing has been built to go to.
   *
   * Nullable rather than always a string, because it was always a string and six of the seven
   * values it produced were routes that did not exist: a search hit was a 404 waiting for
   * someone to press Enter on it. A hit with no destination is still worth returning — it
   * confirms the record exists and shows its code, name and balance — so it is rendered as a
   * plain row instead of a link.
   *
   * Where a *register* exists it is preferred over a detail page that does not: an invoice hit
   * lands on the sales register filtered to that number, which answers the question the search
   * was asking without inventing a screen.
   */
  readonly href: string | null;
}

export interface SearchOptions {
  readonly tenantId: string;
  readonly query: string;
  readonly entities?: readonly SearchEntity[];
  readonly limitPerEntity?: number;
  readonly includeInactive?: boolean;
  /**
   * Narrows a counterparty search to one side of the trade.
   *
   * Without it a sales invoice's customer picker offers suppliers, and picking one produces a
   * receivable against a company you owe money to. `BOTH` counterparties satisfy either filter,
   * because they genuinely are both.
   */
  readonly counterpartyType?: 'CUSTOMER' | 'SUPPLIER';
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

  const entities = options.entities ?? [
    'product',
    'counterparty',
    'account',
    'document',
    'employee',
  ];
  const limit = options.limitPerEntity ?? 8;

  const results = await Promise.all(
    entities.map((entity) =>
      searchEntity(prisma, entity, term, options.tenantId, limit, options.includeInactive ?? false, options.counterpartyType),
    ),
  );

  // Browsing returns every row at score 0, so the score sort is a no-op and the per-entity
  // `ORDER BY code` survives. Sorting would otherwise shuffle an alphabetical list into an
  // arbitrary one, which is worse than useless in a dropdown someone is scanning.
  return results
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 3);
}

async function searchEntity(
  db: RawQueryClient,
  entity: SearchEntity,
  term: string,
  tenantId: string,
  limit: number,
  includeInactive: boolean,
  counterpartyType?: 'CUSTOMER' | 'SUPPLIER',
): Promise<SearchHit[]> {
  switch (entity) {
    case 'product':
      return searchProducts(db, term, tenantId, limit, includeInactive);
    case 'counterparty':
      return searchCounterparties(db, term, tenantId, limit, includeInactive, counterpartyType);
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
 * The shared ranking expression, computed on the normalised forms.
 *
 * Ordered by decreasing confidence: an exact code match is certainly what the user meant; a
 * prefix match almost certainly is; a substring match on the code is what makes `1001` find
 * `BTC-1001`; a name match is next; and trigram similarity is the fallback that catches typos.
 *
 * Both sides are folded — `erp_compact_code` on the column, `compactCode` on the term — so a
 * user who typed `btc١٠٣٨` still scores the full 1.00 exact-match rung rather than dropping to
 * a trigram guess.
 */
function scoreExpression(
  codeColumn: Prisma.Sql,
  nameArColumn: Prisma.Sql,
  nameEnColumn: Prisma.Sql,
  term: string,
): Prisma.Sql {
  const tokens = tokenize(term);
  if (tokens.length === 0) return Prisma.sql`0::float8`;

  // The whole query first. A row matching the entire string contiguously is a better answer
  // than one that merely contains each word somewhere, so it keeps the undiluted ladder.
  const whole = ladder(codeColumn, nameArColumn, nameEnColumn, term);
  if (tokens.length === 1) return whole;

  // Otherwise average the per-token ladders. Averaging rather than taking the best, because
  // `صفوة خدمات` matching both words in one row should outrank a row that matches only one —
  // GREATEST would score those identically and leave the ordering to the tiebreak.
  const perToken = tokens.map((token) => ladder(codeColumn, nameArColumn, nameEnColumn, token));
  const average = Prisma.sql`((${Prisma.join(perToken, ' + ')}) / ${tokens.length}::float8)`;

  // The contiguous match still wins when there is one; the average is the floor beneath it.
  return Prisma.sql`GREATEST(${whole}, ${average})`;
}

/** One term against one row's columns: the confidence ladder, on normalised forms. */
function ladder(
  codeColumn: Prisma.Sql,
  nameArColumn: Prisma.Sql,
  nameEnColumn: Prisma.Sql,
  term: string,
): Prisma.Sql {
  // Browse mode has nothing to score against. Returning a constant 0 keeps every row equal so
  // the query's own `ORDER BY code` decides the order.
  if (term.trim() === '') return Prisma.sql`0`;

  const normalized = normalizeSearchTerm(term);
  const code = compactCode(term);

  return Prisma.sql`
    GREATEST(
      CASE WHEN erp_compact_code(${codeColumn}) = ${code}                     THEN 1.00 ELSE 0 END,
      CASE WHEN erp_compact_code(${codeColumn}) LIKE ${code + '%'}            THEN 0.92 ELSE 0 END,
      CASE WHEN erp_compact_code(${codeColumn}) LIKE ${'%' + code + '%'}      THEN 0.85 ELSE 0 END,
      CASE WHEN erp_normalize_search(${nameArColumn}) LIKE ${normalized + '%'}       THEN 0.80 ELSE 0 END,
      CASE WHEN erp_normalize_search(${nameEnColumn}) LIKE ${normalized + '%'}       THEN 0.78 ELSE 0 END,
      CASE WHEN erp_normalize_search(${nameArColumn}) LIKE ${'%' + normalized + '%'} THEN 0.70 ELSE 0 END,
      CASE WHEN erp_normalize_search(${nameEnColumn}) LIKE ${'%' + normalized + '%'} THEN 0.68 ELSE 0 END,
      similarity(erp_compact_code(${codeColumn}), ${code}) * 0.6,
      similarity(erp_normalize_search(${nameArColumn}), ${normalized}) * 0.55,
      similarity(erp_normalize_search(${nameEnColumn}), ${normalized}) * 0.55
    )::float8
  `;
}

/**
 * The candidate filter: every token must match somewhere in the row.
 *
 * A single `ILIKE '%صفوة خدمات%'` requires the words to be adjacent and in that order, which
 * they are not in `شركة الصفوة للخدمات`. Requiring each token *independently* — in any of the
 * row's searchable columns — is what makes typing a second word narrow the list instead of
 * emptying it.
 *
 * `codeColumns` are compared through `erp_compact_code` (separators dropped) and `textColumns`
 * through `erp_normalize_search` (separators kept, so words stay apart). Passing a name as a
 * code column would join `شركة الصفوة` into one token and stop it matching either half.
 *
 * An empty token list yields `false` rather than `true`: no query should not mean every row.
 */
function matchClause(
  term: string,
  codeColumns: readonly Prisma.Sql[],
  textColumns: readonly Prisma.Sql[],
): Prisma.Sql {
  // An *empty* term is browse mode: the user opened the dropdown without typing, and the
  // honest answer is "here is the start of the list", not "no results". A term that is
  // non-empty but tokenises to nothing (pure punctuation) still yields `false` — that is a
  // query which matched nothing, and pretending it matched everything would be a lie.
  if (term.trim() === '') return Prisma.sql`true`;

  const tokens = tokenize(term);
  if (tokens.length === 0) return Prisma.sql`false`;

  const perToken = tokens.map((token) => {
    const code = compactCode(token);
    const alternatives: Prisma.Sql[] = [];

    for (const column of codeColumns) {
      // A token that normalises to nothing in code form (pure punctuation) would become
      // LIKE '%%' and match every row, so it is skipped rather than allowed to widen.
      if (code !== '') {
        alternatives.push(Prisma.sql`erp_compact_code(${column}) LIKE ${'%' + code + '%'}`);
      }
    }

    for (const column of textColumns) {
      alternatives.push(
        Prisma.sql`erp_normalize_search(${column}) LIKE ${'%' + token + '%'}`,
      );
      alternatives.push(
        Prisma.sql`similarity(erp_normalize_search(${column}), ${token}) > ${SIMILARITY_FLOOR}`,
      );
    }

    if (alternatives.length === 0) return Prisma.sql`false`;
    return Prisma.sql`(${Prisma.join(alternatives, ' OR ')})`;
  });

  return Prisma.sql`(${Prisma.join(perToken, ' AND ')})`;
}

async function searchProducts(
  db: RawQueryClient,
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
       AND ${matchClause(
         term,
         [Prisma.sql`p."sku"`, Prisma.sql`p."barcode"`],
         [Prisma.sql`p."nameAr"`, Prisma.sql`p."nameEn"`],
       )}
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
  db: RawQueryClient,
  term: string,
  tenantId: string,
  limit: number,
  includeInactive: boolean,
  counterpartyType?: 'CUSTOMER' | 'SUPPLIER',
): Promise<SearchHit[]> {
  // The extra clauses below compare against `compactCode(term)`, which is `''` when browsing —
  // and `erp_compact_code(c."taxNumber") = ''` is true for every counterparty without a tax
  // number, scoring them 1.00 and floating them to the top of an alphabetical list. So browse
  // mode skips the scoring entirely rather than trying to make each clause empty-safe.
  const scoring = term.trim() === ''
    ? Prisma.sql`0`
    : Prisma.sql`GREATEST(
             ${scoreExpression(Prisma.sql`c."code"`, Prisma.sql`c."nameAr"`, Prisma.sql`c."nameEn"`, term)},
             CASE WHEN erp_compact_code(c."taxNumber") = ${compactCode(term)}                 THEN 1.00 ELSE 0 END,
             CASE WHEN erp_compact_code(c."phone")     = ${compactCode(term)}                 THEN 1.00 ELSE 0 END,
             CASE WHEN erp_compact_code(c."phone")     LIKE ${compactCode(term) + '%'}        THEN 0.82 ELSE 0 END,
             CASE WHEN erp_compact_code(c."taxNumber") LIKE ${compactCode(term) + '%'}        THEN 0.82 ELSE 0 END,
             CASE WHEN erp_normalize_search(c."email") LIKE ${'%' + normalizeSearchTerm(term) + '%'} THEN 0.72 ELSE 0 END,
             CASE WHEN erp_compact_code(c."phone")     LIKE ${'%' + compactCode(term) + '%'}  THEN 0.66 ELSE 0 END,
             CASE WHEN erp_compact_code(c."taxNumber") LIKE ${'%' + compactCode(term) + '%'}  THEN 0.64 ELSE 0 END
           )`;

  // `BOTH` is a customer as much as it is a supplier, so it satisfies either filter.
  const typeClause =
    counterpartyType === undefined
      ? Prisma.sql`TRUE`
      : Prisma.sql`c."type" IN (${counterpartyType}::"CounterpartyType", 'BOTH')`;

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
           ${scoring}::float8 AS score
      FROM "counterparties" c
     WHERE c."tenantId" = ${tenantId}::uuid
       AND (${includeInactive} OR c."isActive")
       AND ${typeClause}
       AND ${matchClause(
         term,
         // Phone and VAT numbers are codes: nobody types a phone number's spacing back.
         [Prisma.sql`c."code"`, Prisma.sql`c."phone"`, Prisma.sql`c."taxNumber"`],
         [Prisma.sql`c."nameAr"`, Prisma.sql`c."nameEn"`, Prisma.sql`c."email"`],
       )}
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
    // `BOTH` is a customer as much as a supplier; the customer card is the one that shows
    // receivable ageing, which is what someone searching a trading partner usually wants.
    href:
      row.type === 'SUPPLIER'
        ? `/procurement/suppliers/${row.id}`
        : `/sales/customers/${row.id}`,
  }));
}

async function searchAccounts(
  db: RawQueryClient,
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
       AND ${matchClause(
         term,
         [Prisma.sql`a."code"`],
         [Prisma.sql`a."nameAr"`, Prisma.sql`a."nameEn"`],
       )}
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
    // The general ledger is the account view: a hit lands on that account's own ledger,
    // which is what someone searching an account code almost always wants.
    href: `/finance/general-ledger?account=${row.id}`,
  }));
}

async function searchDocuments(
  db: RawQueryClient,
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
             CASE WHEN erp_compact_code(d."documentNumber") = ${compactCode(term)}                THEN 1.00 ELSE 0 END,
             CASE WHEN erp_compact_code(d."documentNumber") LIKE ${compactCode(term) + '%'}       THEN 0.92 ELSE 0 END,
             CASE WHEN erp_compact_code(d."documentNumber") LIKE ${'%' + compactCode(term) + '%'} THEN 0.85 ELSE 0 END,
             CASE WHEN erp_normalize_search(c."nameAr") LIKE ${'%' + normalizeSearchTerm(term) + '%'} THEN 0.65 ELSE 0 END,
             similarity(erp_compact_code(d."documentNumber"), ${compactCode(term)}) * 0.6
           )::float8 AS score
      FROM "documents" d
      JOIN "counterparties" c ON c."id" = d."counterpartyId"
     WHERE d."tenantId" = ${tenantId}::uuid
       AND ${matchClause(
         term,
         [Prisma.sql`d."documentNumber"`],
         [Prisma.sql`c."nameAr"`],
       )}
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
    // The sales register supports `?q=`, so a hit filters it to this document. There is no
    // purchase register at all, so those hits carry no destination.
    href: row.type.startsWith('SALES')
      ? `/sales/invoices?q=${encodeURIComponent(row.documentNumber)}`
      : null,
  }));
}

async function searchEmployees(
  db: RawQueryClient,
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
       AND ${matchClause(
         term,
         [Prisma.sql`e."employeeNumber"`],
         [Prisma.sql`e."fullNameAr"`, Prisma.sql`e."fullNameEn"`],
       )}
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
    // No employee screen yet.
    href: null,
  }));
}
