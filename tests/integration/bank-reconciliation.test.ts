import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  autoMatchStatement,
  finaliseStatement,
  getReconciliation,
  matchLine,
  reopenStatement,
  unmatchLine,
} from '@/lib/application/services/bank-reconciliation-service';

/**
 * Bank reconciliation, against a real database.
 *
 * The property under test is the arithmetic: `bank closing − statement-only` must equal
 * `book balance − books-only`, and the difference between them is what a person signs off.
 * A reconciliation that reaches zero by double-counting something is worse than one left
 * undone, because it has been signed.
 *
 * So the tests that matter most are the refusals — matching a payment twice, matching
 * across bank accounts, signing off a statement that does not balance — and the one
 * property no fake could demonstrate: the partial unique index that settles two clerks
 * matching the same payment at the same instant.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

/**
 * A fresh tenant per test, rather than a shared one torn down between them.
 *
 * The fixture posts journals so the ledger side of the arithmetic is real, and a posted
 * journal cannot be deleted — `journals_immutability` refuses it, which is the point of an
 * append-only ledger. So this suite isolates by never reusing a tenant instead of by
 * cleaning up, the same way `database-guards` leaves its fixture behind. It runs against a
 * scratch database.
 */
let tenantCode = '';
let tenantId = '';
let userId = '';
let bankAccountId = '';
let otherBankAccountId = '';
let counterpartyId = '';
let branchId = '';
let statementId = '';
let revenueAccountId = '';
let journalSequence = 0;

/** A posted payment through the statement's bank account. */
async function createPayment(input: {
  voucher: string;
  type: 'RECEIPT' | 'PAYMENT';
  amount: string;
  date: string;
  accountId?: string;
  bankReference?: string;
  status?: 'DRAFT' | 'POSTED';
}): Promise<string> {
  const payment = await prisma.payment.create({
    data: {
      tenantId,
      voucherNumber: input.voucher,
      type: input.type,
      status: input.status ?? 'POSTED',
      counterpartyId,
      branchId,
      paymentDate: new Date(input.date),
      amount: input.amount,
      currency: 'SAR',
      method: 'BANK',
      accountId: input.accountId ?? bankAccountId,
      bankReference: input.bankReference ?? null,
      createdById: userId,
      postedAt: input.status === 'DRAFT' ? null : new Date(),
    },
    select: { id: true },
  });
  return payment.id;
}

async function createLine(input: {
  debit?: string;
  credit?: string;
  date: string;
  description?: string;
  reference?: string;
}): Promise<string> {
  const line = await prisma.bankStatementLine.create({
    data: {
      bankStatementId: statementId,
      valueDate: new Date(input.date),
      description: input.description ?? 'حركة بنكية',
      reference: input.reference ?? null,
      debit: input.debit ?? '0',
      credit: input.credit ?? '0',
    },
    select: { id: true },
  });
  return line.id;
}

/**
 * Posts a balanced journal that moves money through the bank account.
 *
 * The fixture needs this because the reconciliation compares the bank against the
 * *ledger*, and a payment row alone does not touch the ledger — posting it does. Without a
 * journal the book balance is zero and every matched line looks like an unexplained
 * difference, which is exactly what the service correctly reported when this helper was
 * missing.
 *
 * Inserted as DRAFT and then posted, because `journals_immutability` refuses a journal
 * inserted already posted — and the balance trigger refuses one that does not balance.
 */
async function postToBank(input: { date: string; amount: string; direction: 'IN' | 'OUT' }): Promise<void> {
  journalSequence += 1;
  const date = new Date(input.date);

  const journal = await prisma.journal.create({
    data: {
      tenantId,
      entryNumber: `JV-${journalSequence}`,
      type: 'CASH',
      status: 'DRAFT',
      date,
      descriptionAr: 'حركة بنكية',
      totalDebit: input.amount,
      totalCredit: input.amount,
      createdById: userId,
    },
    select: { id: true },
  });

  // Created separately rather than nested: `journalDate` is half of the composite foreign
  // key to the partitioned journal, so Prisma manages it in a nested create and will not
  // accept it as an argument.
  await prisma.journalLine.createMany({
    data: [
      {
        tenantId,
        journalId: journal.id,
        journalDate: date,
        lineNumber: 1,
        accountId: input.direction === 'IN' ? bankAccountId : revenueAccountId,
        debit: input.amount,
        credit: '0',
      },
      {
        tenantId,
        journalId: journal.id,
        journalDate: date,
        lineNumber: 2,
        accountId: input.direction === 'IN' ? revenueAccountId : bankAccountId,
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

/** Sets the statement's closing balance, which stands in for what the bank says. */
async function setClosing(value: string): Promise<void> {
  await prisma.bankStatement.update({
    where: { id: statementId },
    data: { closingBalance: value },
  });
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('bank reconciliation', () => {
  beforeEach(async () => {
    tenantCode = `BANKREC_${randomUUID().slice(0, 8)}`;
    journalSequence = 0;

    const tenant = await prisma.tenant.create({
      data: { code: tenantCode, nameAr: 'تسوية', nameEn: 'Reconciliation' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        username: 'clerk',
        email: `clerk@${tenantCode}.spec`,
        passwordHash: 'x',
        fullNameAr: 'أمين',
        fullNameEn: 'Clerk',
      },
      select: { id: true },
    });
    userId = user.id;

    const branch = await prisma.branch.create({
      data: { tenantId, code: 'BR1', nameAr: 'الفرع', nameEn: 'Branch' },
      select: { id: true },
    });
    branchId = branch.id;

    const [bank, otherBank] = await Promise.all([
      prisma.account.create({
        data: {
          tenantId,
          code: '1110',
          nameAr: 'البنك الأول',
          nameEn: 'Bank One',
          type: 'ASSET',
          nature: 'DEBIT',
          // Materialised path, required by the chart-of-accounts hierarchy.
          path: '1110',
        },
        select: { id: true },
      }),
      prisma.account.create({
        data: {
          tenantId,
          code: '1120',
          nameAr: 'البنك الثاني',
          nameEn: 'Bank Two',
          type: 'ASSET',
          nature: 'DEBIT',
          path: '1120',
        },
        select: { id: true },
      }),
    ]);
    bankAccountId = bank.id;
    otherBankAccountId = otherBank.id;

    const revenue = await prisma.account.create({
      data: {
        tenantId,
        code: '4100',
        nameAr: 'إيرادات',
        nameEn: 'Revenue',
        type: 'REVENUE',
        nature: 'CREDIT',
        path: '4100',
      },
      select: { id: true },
    });
    revenueAccountId = revenue.id;

    const counterparty = await prisma.counterparty.create({
      data: {
        tenantId,
        code: 'C1',
        nameAr: 'عميل',
        nameEn: 'Customer',
        type: 'CUSTOMER',
      },
      select: { id: true },
    });
    counterpartyId = counterparty.id;

    const statement = await prisma.bankStatement.create({
      data: {
        tenantId,
        accountId: bankAccountId,
        statementRef: 'ST-2026-03',
        periodStart: new Date('2026-03-01'),
        periodEnd: new Date('2026-03-31'),
        openingBalance: '0',
        closingBalance: '0',
      },
      select: { id: true },
    });
    statementId = statement.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the database guards', () => {
    it('refuses a line with both a debit and a credit', async () => {
      await expect(createLine({ debit: '100', credit: '50', date: '2026-03-05' })).rejects.toThrow();
    });

    it('refuses a line with neither', async () => {
      await expect(createLine({ debit: '0', credit: '0', date: '2026-03-05' })).rejects.toThrow();
    });

    it('refuses a half-written match', async () => {
      const lineId = await createLine({ debit: '100', date: '2026-03-05' });
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '100',
        date: '2026-03-05',
      });

      // A payment id with no timestamp is a match with no audit trail.
      await expect(
        prisma.bankStatementLine.update({
          where: { id: lineId },
          data: { matchedPaymentId: paymentId },
        }),
      ).rejects.toThrow();
    });

    it('refuses a statement signed off with nobody\'s name against it', async () => {
      await expect(
        prisma.bankStatement.update({
          where: { id: statementId },
          data: { isReconciled: true },
        }),
      ).rejects.toThrow();
    });

    it('refuses one payment matched to two lines', async () => {
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '100',
        date: '2026-03-05',
      });
      const first = await createLine({ debit: '100', date: '2026-03-05' });
      const second = await createLine({ debit: '100', date: '2026-03-06' });

      await prisma.bankStatementLine.update({
        where: { id: first },
        data: { matchedPaymentId: paymentId, matchedAt: new Date(), matchScore: 100 },
      });

      // Reconciled twice, the bank balance appears to agree while concealing a genuine
      // unexplained difference — the exact failure the exercise exists to surface.
      await expect(
        prisma.bankStatementLine.update({
          where: { id: second },
          data: { matchedPaymentId: paymentId, matchedAt: new Date(), matchScore: 100 },
        }),
      ).rejects.toThrow();
    });
  });

  describe('the summary arithmetic', () => {
    it('reports a difference when nothing is matched', async () => {
      await createLine({ debit: '1000', date: '2026-03-05' });
      await setClosing('1000');

      const view = await getReconciliation({ tenantId, statementId });

      expect(view.ok).toBe(true);
      if (!view.ok) return;
      // The bank shows 1000, the ledger shows nothing, and the unmatched line explains it:
      // 1000 − 1000 = 0 per bank, 0 − 0 = 0 per books.
      expect(view.value.summary.isBalanced).toBe(true);
      expect(view.value.summary.unmatchedLines).toBe(1);
    });

    it('leaves an unexplained difference when the bank shows more than anything accounts for', async () => {
      await createLine({ debit: '1000', date: '2026-03-05' });
      await setClosing('1500');

      const view = await getReconciliation({ tenantId, statementId });

      expect(view.ok).toBe(true);
      if (!view.ok) return;
      expect(view.value.summary.isBalanced).toBe(false);
      expect(view.value.summary.difference).toBe('500');
    });

    it('counts an unmatched payment as a books-only item', async () => {
      await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '700',
        date: '2026-03-10',
      });
      await setClosing('0');

      const view = await getReconciliation({ tenantId, statementId });

      expect(view.ok).toBe(true);
      if (!view.ok) return;
      // A deposit in transit: the books know, the bank does not.
      expect(view.value.summary.unmatchedPayments).toBe(1);
      expect(view.value.summary.booksOnlyNet).toBe('700');
    });

    it('treats a credit line as money out when netting statement-only items', async () => {
      await createLine({ credit: '250', date: '2026-03-07', description: 'رسوم بنكية' });
      await setClosing('-250');

      const view = await getReconciliation({ tenantId, statementId });

      expect(view.ok).toBe(true);
      if (!view.ok) return;
      expect(view.value.summary.statementOnlyNet).toBe('-250');
      expect(view.value.summary.isBalanced).toBe(true);
    });
  });

  describe('matching', () => {
    it('matches a line to a payment of the same amount and direction', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
      });

      const result = await matchLine({ tenantId, statementId, lineId, paymentId, userId });

      expect(result.ok).toBe(true);
      const stored = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
      expect(stored.matchedPaymentId).toBe(paymentId);
      expect(stored.matchedAt).not.toBeNull();
      // A human chose it, so the recorded confidence is total — `matchScore` records how
      // sure the *system* was, and this was not the system's opinion.
      expect(stored.matchScore).toBe(100);
    });

    it('refuses a payment whose amount differs', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '4999.99',
        date: '2026-03-10',
      });

      const result = await matchLine({ tenantId, statementId, lineId, paymentId, userId });

      expect(result.ok).toBe(false);
    });

    it('refuses a payment in the opposite direction', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });
      const paymentId = await createPayment({
        voucher: 'PV-1',
        type: 'PAYMENT',
        amount: '5000',
        date: '2026-03-10',
      });

      expect((await matchLine({ tenantId, statementId, lineId, paymentId, userId })).ok).toBe(false);
    });

    it('refuses a payment made through a different bank account', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
        accountId: otherBankAccountId,
      });

      // Two identical transfers made from two accounts on the same day would otherwise
      // match each other's statements.
      const result = await matchLine({ tenantId, statementId, lineId, paymentId, userId });

      expect(result.ok).toBe(false);
    });

    it('refuses a payment that is not posted', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
        status: 'DRAFT',
      });

      expect((await matchLine({ tenantId, statementId, lineId, paymentId, userId })).ok).toBe(false);
    });

    it('refuses a second match on the same line', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });
      const first = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
      });
      const second = await createPayment({
        voucher: 'RV-2',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-11',
      });

      await matchLine({ tenantId, statementId, lineId, paymentId: first, userId });

      expect(
        (await matchLine({ tenantId, statementId, lineId, paymentId: second, userId })).ok,
      ).toBe(false);
    });

    it('refuses a payment already matched elsewhere', async () => {
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
      });
      const first = await createLine({ debit: '5000', date: '2026-03-10' });
      const second = await createLine({ debit: '5000', date: '2026-03-11' });

      await matchLine({ tenantId, statementId, lineId: first, paymentId, userId });

      const result = await matchLine({ tenantId, statementId, lineId: second, paymentId, userId });

      expect(result.ok).toBe(false);
    });

    it('lets only one of two racing clerks match the same payment', async () => {
      // The read-then-write here is what the unique index settles. Both find the payment
      // unmatched; only one may write.
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
      });
      const first = await createLine({ debit: '5000', date: '2026-03-10' });
      const second = await createLine({ debit: '5000', date: '2026-03-11' });

      const outcomes = await Promise.all([
        matchLine({ tenantId, statementId, lineId: first, paymentId, userId }),
        matchLine({ tenantId, statementId, lineId: second, paymentId, userId }),
      ]).catch(() => []);

      const succeeded = outcomes.filter((outcome) => outcome.ok);
      expect(succeeded.length).toBeLessThanOrEqual(1);

      const matchedCount = await prisma.bankStatementLine.count({
        where: { bankStatementId: statementId, matchedPaymentId: paymentId },
      });
      expect(matchedCount).toBe(1);
    });

    it('releases a match so a mistake can be corrected', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
      });
      await matchLine({ tenantId, statementId, lineId, paymentId, userId });

      const result = await unmatchLine({ tenantId, statementId, lineId, userId });

      expect(result.ok).toBe(true);
      const stored = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
      // All three cleared together, as the constraint requires.
      expect(stored.matchedPaymentId).toBeNull();
      expect(stored.matchedAt).toBeNull();
      expect(stored.matchScore).toBeNull();
    });

    it('refuses to unmatch a line that is not matched', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });

      expect((await unmatchLine({ tenantId, statementId, lineId, userId })).ok).toBe(false);
    });

    it('does not offer a matched payment as a candidate again', async () => {
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
      });
      const first = await createLine({ debit: '5000', date: '2026-03-10' });
      await createLine({ debit: '5000', date: '2026-03-11' });

      await matchLine({ tenantId, statementId, lineId: first, paymentId, userId });

      const view = await getReconciliation({ tenantId, statementId });
      expect(view.ok).toBe(true);
      if (!view.ok) return;

      const stillUnmatched = view.value.lines.find((line) => line.matchedPaymentId === null);
      expect(stillUnmatched?.candidates).toEqual([]);
    });
  });

  describe('the automatic pass', () => {
    it('matches an unambiguous confident candidate', async () => {
      await createLine({
        debit: '5000',
        date: '2026-03-10',
        description: 'حوالة واردة TRX556677',
      });
      await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
        bankReference: 'TRX556677',
      });

      const result = await autoMatchStatement({ tenantId, statementId, userId });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.matched).toBe(1);
    });

    it('declines two equally good candidates and says so', async () => {
      // Two identical receipts on the same day. The evidence does not distinguish them.
      await createLine({ debit: '5000', date: '2026-03-10', description: 'إيداع' });
      await createPayment({ voucher: 'RV-1', type: 'RECEIPT', amount: '5000', date: '2026-03-10' });
      await createPayment({ voucher: 'RV-2', type: 'RECEIPT', amount: '5000', date: '2026-03-10' });

      const result = await autoMatchStatement({ tenantId, statementId, userId });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.matched).toBe(0);
      expect(result.value.unmatched).toBe(1);
    });

    it('never matches two lines to the same payment in one pass', async () => {
      await createLine({ debit: '5000', date: '2026-03-10', description: 'TRX556677' });
      await createLine({ debit: '5000', date: '2026-03-11', description: 'TRX556677' });
      await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
        bankReference: 'TRX556677',
      });

      const result = await autoMatchStatement({ tenantId, statementId, userId });

      expect(result.ok).toBe(true);
      const matched = await prisma.bankStatementLine.count({
        where: { bankStatementId: statementId, matchedPaymentId: { not: null } },
      });
      expect(matched).toBe(1);
    });
  });

  describe('sign-off', () => {
    it('refuses while a difference remains', async () => {
      await createLine({ debit: '1000', date: '2026-03-05' });
      await setClosing('1500');

      const result = await finaliseStatement({ tenantId, statementId, userId });

      expect(result.ok).toBe(false);
      const stored = await prisma.bankStatement.findUniqueOrThrow({ where: { id: statementId } });
      expect(stored.isReconciled).toBe(false);
    });

    it('signs off a balanced statement, with a name against it', async () => {
      await createLine({ debit: '1000', date: '2026-03-05' });
      await setClosing('1000');

      const result = await finaliseStatement({ tenantId, statementId, userId });

      expect(result.ok).toBe(true);
      const stored = await prisma.bankStatement.findUniqueOrThrow({ where: { id: statementId } });
      expect(stored.isReconciled).toBe(true);
      expect(stored.reconciledById).toBe(userId);
      expect(stored.reconciledAt).not.toBeNull();
    });

    it('refuses a second sign-off', async () => {
      await setClosing('0');
      await finaliseStatement({ tenantId, statementId, userId });

      expect((await finaliseStatement({ tenantId, statementId, userId })).ok).toBe(false);
    });

    it('freezes matching once signed off', async () => {
      const lineId = await createLine({ debit: '5000', date: '2026-03-10' });
      const paymentId = await createPayment({
        voucher: 'RV-1',
        type: 'RECEIPT',
        amount: '5000',
        date: '2026-03-10',
      });
      await matchLine({ tenantId, statementId, lineId, paymentId, userId });
      // The ledger has to show the movement too, or the matched line is an unexplained
      // difference — which is what the service said when this was missing.
      await postToBank({ date: '2026-03-10', amount: '5000', direction: 'IN' });
      await setClosing('5000');
      expect((await finaliseStatement({ tenantId, statementId, userId })).ok).toBe(true);

      // Changing a match under a signed-off reconciliation would silently invalidate the
      // assertion somebody made.
      expect((await unmatchLine({ tenantId, statementId, lineId, userId })).ok).toBe(false);
    });

    it('reopens so matches can be corrected, clearing the assertion', async () => {
      await setClosing('0');
      await finaliseStatement({ tenantId, statementId, userId });

      const result = await reopenStatement({ tenantId, statementId, userId });

      expect(result.ok).toBe(true);
      const stored = await prisma.bankStatement.findUniqueOrThrow({ where: { id: statementId } });
      expect(stored.isReconciled).toBe(false);
      expect(stored.reconciledById).toBeNull();
      expect(stored.reconciledAt).toBeNull();
    });

    it('refuses to reopen a statement that is not signed off', async () => {
      expect((await reopenStatement({ tenantId, statementId, userId })).ok).toBe(false);
    });
  });

  it('refuses a statement from another tenant', async () => {
    const result = await getReconciliation({ tenantId: randomUUID(), statementId });

    expect(result.ok).toBe(false);
  });
});
