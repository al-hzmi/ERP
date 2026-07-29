import type { CostingMethod } from '@/lib/domain/inventory/costing';
import {
  InMemoryAccountResolver,
  REQUIRED_MAPPING_KEYS,
  type AccountMappingKey,
} from '@/lib/domain/accounting/account-mapping';
import type { PostingContext } from '@/lib/domain/accounting/posting-rules';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { TransactionClient } from '@/lib/infrastructure/db/prisma';

/**
 * Loads everything a posting decision depends on, once per use case.
 *
 * Posting a single invoice touches a dozen GL accounts. Resolving each one with
 * its own query would turn one business operation into a chatty sequence that
 * gets slower as the chart of accounts grows. Here the whole mapping table for
 * the tenant is read in one query and answered from memory thereafter.
 */

export interface TenantSettings {
  readonly tenantId: string;
  readonly functionalCurrency: string;
  readonly costingMethod: CostingMethod;
  readonly allowNegativeStock: boolean;
  readonly allowOverpayment: boolean;
  readonly enforceSoD: boolean;
  readonly vatNumber: string | null;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly timezone: string;
}

export interface LoadedPostingContext {
  readonly settings: TenantSettings;
  readonly posting: PostingContext;
}

export async function loadTenantSettings(
  tx: TransactionClient,
  tenantId: string,
): Promise<Result<TenantSettings, DomainError>> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      nameAr: true,
      nameEn: true,
      functionalCurrency: true,
      costingMethod: true,
      allowNegativeStock: true,
      allowOverpayment: true,
      enforceSoD: true,
      vatNumber: true,
      timezone: true,
      isActive: true,
    },
  });

  if (tenant === null || !tenant.isActive) {
    return err(DomainErrors.notFound('المنشأة', 'Tenant', tenantId));
  }

  return ok({
    tenantId: tenant.id,
    functionalCurrency: tenant.functionalCurrency,
    costingMethod: tenant.costingMethod,
    allowNegativeStock: tenant.allowNegativeStock,
    allowOverpayment: tenant.allowOverpayment,
    enforceSoD: tenant.enforceSoD,
    vatNumber: tenant.vatNumber,
    nameAr: tenant.nameAr,
    nameEn: tenant.nameEn,
    timezone: tenant.timezone,
  });
}

/**
 * Builds a posting context for a branch.
 *
 * Loads the tenant's settings and its complete account-mapping table, then hands
 * back an in-memory resolver. The mapping table is small (tens of rows) and
 * changes rarely, so reading all of it is cheaper than reading part of it
 * repeatedly.
 */
export async function loadPostingContext(
  tx: TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<Result<LoadedPostingContext, DomainError>> {
  const settings = await loadTenantSettings(tx, tenantId);
  if (!settings.ok) return settings;

  const mappings = await tx.accountMapping.findMany({
    where: { tenantId },
    select: { key: true, accountId: true, branchId: true, categoryId: true },
  });

  const resolver = new InMemoryAccountResolver(
    mappings.map((mapping) => ({
      key: mapping.key as AccountMappingKey,
      accountId: mapping.accountId,
      branchId: mapping.branchId,
      categoryId: mapping.categoryId,
    })),
  );

  return ok({
    settings: settings.value,
    posting: {
      tenantId,
      branchId,
      functionalCurrency: settings.value.functionalCurrency,
      resolver,
    },
  });
}

/**
 * Reports which required mappings a tenant has not configured.
 *
 * Called by the setup wizard and by a health check, so a missing `COGS` mapping
 * is discovered while nobody is waiting rather than at the moment someone tries
 * to post the month's biggest invoice.
 */
export async function findMissingAccountMappings(
  tx: TransactionClient,
  tenantId: string,
): Promise<AccountMappingKey[]> {
  const configured = await tx.accountMapping.findMany({
    where: { tenantId, branchId: null, categoryId: null },
    select: { key: true },
  });

  const present = new Set(configured.map((row) => row.key));
  return REQUIRED_MAPPING_KEYS.filter((key) => !present.has(key));
}

/**
 * Resolves the exchange rate to use for a transaction.
 *
 * A document in the functional currency needs no rate. A document in any other
 * currency needs one, and if the user did not supply it we look for a published
 * rate on or before the document date — never a later one, because a document
 * cannot have been valued at a rate that did not yet exist.
 */
export async function resolveExchangeRate(
  tx: TransactionClient,
  tenantId: string,
  fromCurrency: string,
  functionalCurrency: string,
  onDate: Date,
  supplied?: string,
): Promise<Result<string, DomainError>> {
  if (fromCurrency === functionalCurrency) return ok('1.000000');

  if (supplied !== undefined && supplied !== '') {
    const parsed = Number.parseFloat(supplied);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return err(
        DomainErrors.validation(
          'سعر الصرف يجب أن يكون رقماً موجباً.',
          'The exchange rate must be a positive number.',
          'exchangeRate',
        ),
      );
    }
    return ok(supplied);
  }

  const rate = await tx.exchangeRate.findFirst({
    where: {
      tenantId,
      fromCurrency,
      toCurrency: functionalCurrency,
      validOn: { lte: onDate },
    },
    orderBy: { validOn: 'desc' },
    select: { rate: true },
  });

  if (rate === null) {
    return err(DomainErrors.exchangeRateRequired(fromCurrency, functionalCurrency));
  }

  return ok(rate.rate.toFixed(6));
}
