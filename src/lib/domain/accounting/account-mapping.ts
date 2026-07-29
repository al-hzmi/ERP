import { DomainErrors, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * The vocabulary of "which account does this business event hit?".
 *
 * Posting rules refer to accounts by intent, never by code. A tenant can rename
 * or renumber `1201-001` without touching a line of posting logic, and the same
 * rules work for a chart of accounts we have never seen.
 */
export type AccountMappingKey =
  // Receivables / payables control accounts (maintained only by sub-ledgers)
  | 'AR_CONTROL'
  | 'AP_CONTROL'
  // Tax
  | 'VAT_OUTPUT'
  | 'VAT_INPUT'
  // Sales
  | 'SALES_REVENUE'
  | 'SALES_DISCOUNT'
  | 'SALES_RETURNS'
  | 'COGS'
  // Inventory
  | 'INVENTORY'
  | 'INVENTORY_ADJUSTMENT'
  | 'PURCHASE_EXPENSE'
  // Treasury
  | 'CASH'
  | 'BANK'
  | 'FX_GAIN'
  | 'FX_LOSS'
  | 'ROUNDING_DIFFERENCE'
  // Payroll
  | 'SALARIES_EXPENSE'
  | 'SALARIES_PAYABLE'
  | 'EMPLOYEE_DEDUCTIONS_PAYABLE'
  // Fixed assets
  | 'DEPRECIATION_EXPENSE'
  | 'ACCUMULATED_DEPRECIATION'
  // Equity
  | 'RETAINED_EARNINGS'
  | 'OPENING_BALANCE_EQUITY';

/** Optional narrowing — a branch or product category may override the default. */
export interface AccountMappingScope {
  readonly branchId?: string;
  readonly categoryId?: string;
}

/**
 * Resolves an intent to a concrete GL account id.
 *
 * Implemented over an in-memory snapshot loaded once per use case, so a posting
 * rule that touches twenty accounts still issues zero extra queries.
 */
export interface AccountResolver {
  resolve(key: AccountMappingKey, scope?: AccountMappingScope): Result<string, DomainError>;
}

interface MappingRecord {
  readonly key: AccountMappingKey;
  readonly accountId: string;
  readonly branchId: string | null;
  readonly categoryId: string | null;
}

/**
 * Resolution order, most specific first:
 *   1. branch + category
 *   2. category
 *   3. branch
 *   4. tenant default
 *
 * A missing mapping is a configuration error, not a user error — it surfaces as
 * a 500 with the key named, so an administrator knows exactly what to configure.
 */
export class InMemoryAccountResolver implements AccountResolver {
  private readonly index = new Map<string, string>();

  constructor(mappings: readonly MappingRecord[]) {
    for (const mapping of mappings) {
      this.index.set(
        InMemoryAccountResolver.indexKey(mapping.key, mapping.branchId, mapping.categoryId),
        mapping.accountId,
      );
    }
  }

  resolve(key: AccountMappingKey, scope: AccountMappingScope = {}): Result<string, DomainError> {
    const branchId = scope.branchId ?? null;
    const categoryId = scope.categoryId ?? null;

    const candidates: (string | undefined)[] = [
      branchId !== null && categoryId !== null
        ? this.index.get(InMemoryAccountResolver.indexKey(key, branchId, categoryId))
        : undefined,
      categoryId !== null
        ? this.index.get(InMemoryAccountResolver.indexKey(key, null, categoryId))
        : undefined,
      branchId !== null
        ? this.index.get(InMemoryAccountResolver.indexKey(key, branchId, null))
        : undefined,
      this.index.get(InMemoryAccountResolver.indexKey(key, null, null)),
    ];

    for (const candidate of candidates) {
      if (candidate !== undefined) return ok(candidate);
    }

    return err(DomainErrors.accountMappingMissing(key));
  }

  /** Every key the tenant has configured — used by the configuration health check. */
  get configuredKeys(): string[] {
    return [...this.index.keys()];
  }

  private static indexKey(
    key: string,
    branchId: string | null,
    categoryId: string | null,
  ): string {
    return `${key}|${branchId ?? '*'}|${categoryId ?? '*'}`;
  }
}

/**
 * Keys without which the system cannot post its core documents. Checked at
 * startup and by the configuration screen, so a tenant discovers a gap during
 * setup rather than halfway through month-end close.
 */
export const REQUIRED_MAPPING_KEYS: readonly AccountMappingKey[] = [
  'AR_CONTROL',
  'AP_CONTROL',
  'VAT_OUTPUT',
  'VAT_INPUT',
  'SALES_REVENUE',
  'SALES_DISCOUNT',
  'SALES_RETURNS',
  'COGS',
  'INVENTORY',
  'INVENTORY_ADJUSTMENT',
  'PURCHASE_EXPENSE',
  'CASH',
  'BANK',
  'FX_GAIN',
  'FX_LOSS',
  'ROUNDING_DIFFERENCE',
  'SALARIES_EXPENSE',
  'SALARIES_PAYABLE',
  'EMPLOYEE_DEDUCTIONS_PAYABLE',
  'DEPRECIATION_EXPENSE',
  'ACCUMULATED_DEPRECIATION',
  'RETAINED_EARNINGS',
  'OPENING_BALANCE_EQUITY',
];
