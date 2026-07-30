import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getBalanceSheet,
  getIncomeStatement,
  getTrialBalance,
} from '@/lib/application/services/report-service';

/**
 * The financial statements, against a real ledger.
 *
 * The test that matters here is the contra-account one, and it exists because the bug was
 * real and shipped. `getBalanceSheet` signed each account's balance by its **nature**, so
 * accumulated depreciation — `type: ASSET`, `nature: CREDIT` — came back positive and was
 * *added* to total assets, when reducing them is the entire purpose of a contra-asset. The
 * sheet then failed to balance by twice the accumulated depreciation.
 *
 * Nothing caught it for nine migrations because nothing had ever posted to a contra account.
 * Migration 3 made them expressible, the seed created four, and they sat at zero until the
 * depreciation run shipped and credited one. The first balance sheet rendered after that was
 * the first one that could have been wrong — and it was.
 *
 * So these tests post to a contra-asset deliberately. A suite that only exercised ordinary
 * debit-natured assets would have passed against the broken version, which is exactly what
 * happened.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let userId = '';
let cashId = '';
let equipmentId = '';
let accumulatedId = '';
let capitalId = '';
let revenueId = '';
let expenseId = '';
let journalSequence = 0;

const CURRENCY = 'SAR';
const PERIOD_START = new Date('2026-01-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-12-31T00:00:00.000Z');

/**
 * Posts a two-line balanced journal.
 *
 * Inserted as DRAFT then flipped to POSTED, because `journals_immutability` refuses a journal
 * inserted already posted and the balance trigger refuses one that does not balance — the two
 * guards that make this fixture's ledger a real one rather than a convenient one.
 */
async function post(input: {
  date: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: string;
}): Promise<void> {
  journalSequence += 1;
  const date = new Date(`${input.date}T00:00:00.000Z`);

  const journal = await prisma.journal.create({
    data: {
      tenantId,
      entryNumber: `RPT-${journalSequence}`,
      type: 'GENERAL',
      status: 'DRAFT',
      date,
      descriptionAr: 'قيد اختبار',
      totalDebit: input.amount,
      totalCredit: input.amount,
      createdById: userId,
    },
    select: { id: true },
  });

  await prisma.journalLine.createMany({
    data: [
      {
        tenantId,
        journalId: journal.id,
        journalDate: date,
        lineNumber: 1,
        accountId: input.debitAccountId,
        debit: input.amount,
        credit: '0',
      },
      {
        tenantId,
        journalId: journal.id,
        journalDate: date,
        lineNumber: 2,
        accountId: input.creditAccountId,
        debit: '0',
        credit: input.amount,
      },
    ],
  });

  await prisma.journal.update({
    where: { id_date: { id: journal.id, date } },
    data: { status: 'POSTED', postedAt: new Date() },
  });
}

async function account(input: {
  code: string;
  nameAr: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  nature: 'DEBIT' | 'CREDIT';
  isContra?: boolean;
}): Promise<string> {
  const created = await prisma.account.create({
    data: {
      tenantId,
      code: input.code,
      nameAr: input.nameAr,
      nameEn: input.nameAr,
      type: input.type,
      nature: input.nature,
      isContra: input.isContra ?? false,
      path: input.code,
    },
    select: { id: true },
  });
  return created.id;
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('financial statements', () => {
  beforeEach(async () => {
    const code = `RPT_${randomUUID().slice(0, 8)}`;
    journalSequence = 0;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'تقارير', nameEn: 'Reports' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        username: 'controller',
        email: `controller@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'المدير المالي',
        fullNameEn: 'Controller',
      },
      select: { id: true },
    });
    userId = user.id;

    [cashId, equipmentId, accumulatedId, capitalId, revenueId, expenseId] = await Promise.all([
      account({ code: '1110', nameAr: 'النقدية', type: 'ASSET', nature: 'DEBIT' }),
      account({ code: '1210', nameAr: 'معدات', type: 'ASSET', nature: 'DEBIT' }),
      // The account the bug was invisible without: an asset that carries a credit balance.
      account({
        code: '1219',
        nameAr: 'مجمَّع الإهلاك',
        type: 'ASSET',
        nature: 'CREDIT',
        isContra: true,
      }),
      account({ code: '3100', nameAr: 'رأس المال', type: 'EQUITY', nature: 'CREDIT' }),
      account({ code: '4100', nameAr: 'إيرادات', type: 'REVENUE', nature: 'CREDIT' }),
      account({ code: '5310', nameAr: 'مصروف الإهلاك', type: 'EXPENSE', nature: 'DEBIT' }),
    ]) as [string, string, string, string, string, string];
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the balance sheet', () => {
    it('balances when only ordinary accounts are used', async () => {
      await post({
        date: '2026-01-15',
        debitAccountId: cashId,
        creditAccountId: capitalId,
        amount: '100000.00',
      });

      const sheet = await getBalanceSheet({
        tenantId,
        fromDate: PERIOD_START,
        toDate: PERIOD_END,
        currency: CURRENCY,
      });

      expect(sheet.isBalanced).toBe(true);
      expect(sheet.totalAssets).toBe('100000.00');
      expect(sheet.totalEquity).toBe('100000.00');
    });

    it('subtracts a contra-asset from total assets rather than adding it', async () => {
      // The regression. Before the fix this produced assets of 102,000 — the equipment plus
      // the accumulated depreciation — instead of 98,000, and the sheet failed to balance by
      // 4,000, which is twice the contra balance.
      await post({
        date: '2026-01-15',
        debitAccountId: equipmentId,
        creditAccountId: capitalId,
        amount: '100000.00',
      });
      await post({
        date: '2026-02-28',
        debitAccountId: expenseId,
        creditAccountId: accumulatedId,
        amount: '2000.00',
      });

      const sheet = await getBalanceSheet({
        tenantId,
        fromDate: PERIOD_START,
        toDate: PERIOD_END,
        currency: CURRENCY,
      });

      expect(sheet.totalAssets).toBe('98000.00');
      // Equity is capital 100,000 less the 2,000 loss carried by the depreciation expense.
      expect(sheet.totalEquity).toBe('98000.00');
      expect(sheet.currentPeriodProfit).toBe('-2000.00');
      expect(sheet.isBalanced).toBe(true);
    });

    it('reports the contra account as a negative line, not a hidden one', async () => {
      // Netting it into the equipment line would balance too, and would erase the one figure
      // an asset register exists to preserve: cost, shown separately from what has been
      // written off against it.
      await post({
        date: '2026-01-15',
        debitAccountId: equipmentId,
        creditAccountId: capitalId,
        amount: '100000.00',
      });
      await post({
        date: '2026-02-28',
        debitAccountId: expenseId,
        creditAccountId: accumulatedId,
        amount: '2000.00',
      });

      const sheet = await getBalanceSheet({
        tenantId,
        fromDate: PERIOD_START,
        toDate: PERIOD_END,
        currency: CURRENCY,
      });

      const contra = sheet.assets.find((line) => line.code === '1219');
      const cost = sheet.assets.find((line) => line.code === '1210');

      expect(cost?.amount).toBe('100000.0000');
      expect(contra?.amount).toBe('-2000.0000');
    });

    it('folds the period result into equity so the sheet balances mid-year', async () => {
      // Without this the sheet fails on every day of the year except 31 December, because
      // retained earnings have not been closed out yet.
      await post({
        date: '2026-01-15',
        debitAccountId: cashId,
        creditAccountId: capitalId,
        amount: '50000.00',
      });
      await post({
        date: '2026-03-10',
        debitAccountId: cashId,
        creditAccountId: revenueId,
        amount: '30000.00',
      });

      const sheet = await getBalanceSheet({
        tenantId,
        fromDate: PERIOD_START,
        toDate: new Date('2026-06-30T00:00:00.000Z'),
        currency: CURRENCY,
      });

      expect(sheet.totalAssets).toBe('80000.00');
      expect(sheet.currentPeriodProfit).toBe('30000.00');
      expect(sheet.isBalanced).toBe(true);
    });

    it('excludes a draft journal from every side', async () => {
      await post({
        date: '2026-01-15',
        debitAccountId: cashId,
        creditAccountId: capitalId,
        amount: '10000.00',
      });

      const date = new Date('2026-04-01T00:00:00.000Z');
      const draft = await prisma.journal.create({
        data: {
          tenantId,
          entryNumber: 'RPT-DRAFT',
          type: 'GENERAL',
          status: 'DRAFT',
          date,
          descriptionAr: 'مسودة',
          totalDebit: '999999.00',
          totalCredit: '999999.00',
          createdById: userId,
        },
        select: { id: true },
      });
      await prisma.journalLine.createMany({
        data: [
          {
            tenantId,
            journalId: draft.id,
            journalDate: date,
            lineNumber: 1,
            accountId: cashId,
            debit: '999999.00',
            credit: '0',
          },
          {
            tenantId,
            journalId: draft.id,
            journalDate: date,
            lineNumber: 2,
            accountId: capitalId,
            debit: '0',
            credit: '999999.00',
          },
        ],
      });

      const sheet = await getBalanceSheet({
        tenantId,
        fromDate: PERIOD_START,
        toDate: PERIOD_END,
        currency: CURRENCY,
      });

      expect(sheet.totalAssets).toBe('10000.00');
      expect(sheet.isBalanced).toBe(true);
    });
  });

  describe('the income statement', () => {
    it('nets revenue against expenses over the period', async () => {
      await post({
        date: '2026-03-10',
        debitAccountId: cashId,
        creditAccountId: revenueId,
        amount: '40000.00',
      });
      await post({
        date: '2026-03-20',
        debitAccountId: expenseId,
        creditAccountId: cashId,
        amount: '15000.00',
      });

      const statement = await getIncomeStatement({
        tenantId,
        fromDate: PERIOD_START,
        toDate: PERIOD_END,
        currency: CURRENCY,
      });

      expect(statement.totalRevenue).toBe('40000.00');
      expect(statement.totalExpenses).toBe('15000.00');
      expect(statement.netProfit).toBe('25000.00');
      expect(statement.netMargin).toBe('62.50');
    });

    it('leaves the margin undefined rather than reporting zero on no revenue', async () => {
      // Dividing by nothing has no answer. Rendering "0%" would state one.
      await post({
        date: '2026-03-20',
        debitAccountId: expenseId,
        creditAccountId: cashId,
        amount: '5000.00',
      });

      const statement = await getIncomeStatement({
        tenantId,
        fromDate: PERIOD_START,
        toDate: PERIOD_END,
        currency: CURRENCY,
      });

      expect(statement.totalRevenue).toBe('0.00');
      expect(statement.netProfit).toBe('-5000.00');
      expect(statement.netMargin).toBeNull();
    });

    it('respects the period boundaries at both ends', async () => {
      await post({
        date: '2026-03-10',
        debitAccountId: cashId,
        creditAccountId: revenueId,
        amount: '10000.00',
      });
      await post({
        date: '2026-09-10',
        debitAccountId: cashId,
        creditAccountId: revenueId,
        amount: '70000.00',
      });

      const firstHalf = await getIncomeStatement({
        tenantId,
        fromDate: PERIOD_START,
        toDate: new Date('2026-06-30T00:00:00.000Z'),
        currency: CURRENCY,
      });

      expect(firstHalf.totalRevenue).toBe('10000.00');
    });
  });

  describe('the trial balance', () => {
    it('always balances, which is the only thing it is for', async () => {
      await post({
        date: '2026-01-15',
        debitAccountId: cashId,
        creditAccountId: capitalId,
        amount: '100000.00',
      });
      await post({
        date: '2026-02-28',
        debitAccountId: expenseId,
        creditAccountId: accumulatedId,
        amount: '2000.00',
      });

      const balance = await getTrialBalance({
        tenantId,
        fromDate: PERIOD_START,
        toDate: PERIOD_END,
        currency: CURRENCY,
      });

      expect(balance.isBalanced).toBe(true);
      expect(balance.totalDebit).toBe(balance.totalCredit);
    });

    it('carries an opening balance into a later period', async () => {
      await post({
        date: '2026-01-15',
        debitAccountId: cashId,
        creditAccountId: capitalId,
        amount: '100000.00',
      });

      const secondHalf = await getTrialBalance({
        tenantId,
        fromDate: new Date('2026-07-01T00:00:00.000Z'),
        toDate: PERIOD_END,
        currency: CURRENCY,
      });

      const cash = secondHalf.rows.find((row) => row.code === '1110');

      expect(cash?.openingBalance).toBe('100000.0000');
      // Compared numerically: an untouched account's period movement comes back as the SQL
      // literal '0' rather than a scaled '0.0000', and pinning the string would be testing
      // PostgreSQL's formatting rather than the report.
      expect(Number(cash?.periodDebit)).toBe(0);
      expect(Number(cash?.periodCredit)).toBe(0);
      expect(secondHalf.isBalanced).toBe(true);
    });
  });
});
