import { Prisma } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';

/**
 * Currencies and exchange rates.
 *
 * ## One functional currency, and the screen will not let you have two
 *
 * `isFunctional` marks the currency the books are kept in. Every report, every balance and
 * every consolidated total is expressed in it, so a tenant with two would have a set of
 * accounts whose meaning depends on which row you read first. Setting it moves it: the write
 * clears the flag everywhere else in the same transaction rather than refusing, because
 * "change the functional currency" is a real if rare operation and refusing it just means
 * somebody does it in SQL.
 *
 * ## Rates are dated facts, not a current value
 *
 * `exchange_rates` is keyed on `(from, to, validOn)`. A rate is what a pair was worth on a
 * given day, and re-stating history silently re-values every document translated with it — so
 * entering a rate for a date that already has one is a refusal, not an update. Correcting one
 * is deliberate: delete the row and enter it again, and the audit trail shows both.
 */

export interface CurrencyRow {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly symbol: string;
  readonly minorUnits: number;
  readonly isFunctional: boolean;
  readonly isActive: boolean;
}

export interface ExchangeRateRow {
  readonly id: string;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate: string;
  readonly validOn: string;
}

export async function listCurrencies(tenantId: string): Promise<CurrencyRow[]> {
  return withTenantRead(async (tx) => {
    const rows = await tx.currency.findMany({
      where: { tenantId },
      orderBy: [{ isFunctional: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        symbol: true,
        minorUnits: true,
        isFunctional: true,
        isActive: true,
      },
    });

    return rows;
  });
}

export async function listExchangeRates(input: {
  tenantId: string;
  limit?: number;
}): Promise<ExchangeRateRow[]> {
  return withTenantRead(async (tx) => {
    const rows = await tx.exchangeRate.findMany({
      where: { tenantId: input.tenantId },
      orderBy: [{ validOn: 'desc' }, { fromCurrency: 'asc' }],
      take: input.limit ?? 200,
      select: {
        id: true,
        fromCurrency: true,
        toCurrency: true,
        rate: true,
        validOn: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      fromCurrency: row.fromCurrency,
      toCurrency: row.toCurrency,
      rate: row.rate.toString(),
      validOn: row.validOn.toISOString().slice(0, 10),
    }));
  });
}

export async function createCurrency(input: {
  tenantId: string;
  audit: AuditContext;
  code: string;
  nameAr: string;
  nameEn: string;
  symbol: string;
  minorUnits: number;
}): Promise<Result<{ id: string }, DomainError>> {
  const code = input.code.trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(code)) {
    return err(
      DomainErrors.validation(
        'رمز العملة يجب أن يكون ثلاثة أحرف (ISO 4217) مثل SAR.',
        'The currency code must be three letters (ISO 4217).',
        'code',
      ),
    );
  }

  if (input.minorUnits < 0 || input.minorUnits > 4) {
    return err(
      DomainErrors.validation(
        'عدد المنازل العشرية يجب أن يكون بين 0 و4.',
        'Minor units must be between 0 and 4.',
        'minorUnits',
      ),
    );
  }

  return withTransaction(async (tx) => {
    try {
      const created = await tx.currency.create({
        data: {
          tenantId: input.tenantId,
          code,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          symbol: input.symbol.trim() === '' ? code : input.symbol.trim(),
          minorUnits: input.minorUnits,
        },
        select: { id: true },
      });

      await recordAudit(
        tx,
        input.audit,
        'CREATE',
        { entityType: 'currency', entityId: created.id },
        { metadata: { code } },
      );

      return ok(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return err(
          DomainErrors.validation(
            `العملة "${code}" مسجلة بالفعل.`,
            'That currency is already registered.',
            'code',
          ),
        );
      }
      throw error;
    }
  });
}

/**
 * Marks a currency as the functional one, clearing the flag from whichever held it.
 *
 * Both writes in one transaction: a moment in which two currencies claim to be functional, or
 * none does, is a moment in which every report is wrong.
 */
export async function setFunctionalCurrency(input: {
  tenantId: string;
  audit: AuditContext;
  currencyId: string;
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const currency = await tx.currency.findFirst({
      where: { id: input.currencyId, tenantId: input.tenantId },
      select: { id: true, code: true, isActive: true },
    });

    if (currency === null) {
      return err(DomainErrors.notFound('العملة', 'Currency', input.currencyId));
    }

    if (!currency.isActive) {
      return err(
        DomainErrors.validation(
          'لا يمكن اعتماد عملة موقوفة كعملة أساسية.',
          'An inactive currency cannot be the functional currency.',
        ),
      );
    }

    await tx.currency.updateMany({
      where: { tenantId: input.tenantId, isFunctional: true },
      data: { isFunctional: false },
    });

    await tx.currency.update({
      where: { id: currency.id },
      data: { isFunctional: true },
    });

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'currency', entityId: currency.id },
      { metadata: { code: currency.code, isFunctional: true } },
    );

    return ok({ id: currency.id });
  });
}

export async function setCurrencyActive(input: {
  tenantId: string;
  audit: AuditContext;
  currencyId: string;
  isActive: boolean;
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const currency = await tx.currency.findFirst({
      where: { id: input.currencyId, tenantId: input.tenantId },
      select: { id: true, code: true, isFunctional: true },
    });

    if (currency === null) {
      return err(DomainErrors.notFound('العملة', 'Currency', input.currencyId));
    }

    // Deactivating the functional currency leaves the books denominated in something the
    // system considers unavailable. Refused rather than cascaded: the operation the user
    // wants is to move the flag first, and doing that for them hides the decision.
    if (currency.isFunctional && !input.isActive) {
      return err(
        DomainErrors.validation(
          'لا يمكن إيقاف العملة الأساسية — اعتمد عملة أساسية أخرى أولاً.',
          'The functional currency cannot be deactivated. Set another one first.',
        ),
      );
    }

    await tx.currency.update({
      where: { id: currency.id },
      data: { isActive: input.isActive },
    });

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'currency', entityId: currency.id },
      { metadata: { code: currency.code, isActive: input.isActive } },
    );

    return ok({ id: currency.id });
  });
}

/**
 * Records what a pair was worth on a date.
 *
 * A duplicate `(from, to, validOn)` is refused rather than overwritten — see the note at the
 * head of this file about why re-stating a historical rate is not an edit.
 */
export async function recordExchangeRate(input: {
  tenantId: string;
  audit: AuditContext;
  fromCurrencyId: string;
  toCurrencyId: string;
  rate: string;
  validOn: string;
}): Promise<Result<{ id: string }, DomainError>> {
  if (input.fromCurrencyId === input.toCurrencyId) {
    return err(
      DomainErrors.validation(
        'لا يمكن تسجيل سعر صرف لعملة مقابل نفسها.',
        'A currency cannot have a rate against itself.',
        'toCurrencyId',
      ),
    );
  }

  if (!/^\d+(\.\d{1,6})?$/.test(input.rate) || Number(input.rate) <= 0) {
    return err(
      DomainErrors.validation(
        'سعر الصرف يجب أن يكون رقماً موجباً بستة منازل عشرية على الأكثر.',
        'The rate must be a positive number with at most six decimal places.',
        'rate',
      ),
    );
  }

  return withTransaction(async (tx) => {
    const pair = await tx.currency.findMany({
      where: { tenantId: input.tenantId, id: { in: [input.fromCurrencyId, input.toCurrencyId] } },
      select: { id: true, code: true },
    });

    const from = pair.find((row) => row.id === input.fromCurrencyId);
    const to = pair.find((row) => row.id === input.toCurrencyId);

    if (from === undefined || to === undefined) {
      return err(DomainErrors.notFound('العملة', 'Currency', input.fromCurrencyId));
    }

    try {
      const created = await tx.exchangeRate.create({
        data: {
          tenantId: input.tenantId,
          fromCurrencyId: from.id,
          toCurrencyId: to.id,
          // Denormalised so a rate lookup on the posting path never joins `currencies`.
          fromCurrency: from.code,
          toCurrency: to.code,
          rate: input.rate,
          validOn: new Date(`${input.validOn}T00:00:00.000Z`),
        },
        select: { id: true },
      });

      await recordAudit(
        tx,
        input.audit,
        'CREATE',
        { entityType: 'exchangeRate', entityId: created.id },
        { metadata: { from: from.code, to: to.code, rate: input.rate, validOn: input.validOn } },
      );

      return ok(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return err(
          DomainErrors.validation(
            `يوجد سعر صرف مسجل لـ ${from.code}/${to.code} بتاريخ ${input.validOn}.`,
            'A rate for that pair and date already exists.',
            'validOn',
          ),
        );
      }
      throw error;
    }
  });
}
