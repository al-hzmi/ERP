import Link from 'next/link';
import { AlertTriangle, ScrollText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getGeneralLedger } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate, formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'دفتر الأستاذ العام' };

const TYPE_LABELS: Record<string, string> = {
  GENERAL: 'عام',
  SALES: 'مبيعات',
  PURCHASE: 'مشتريات',
  CASH: 'نقدية',
  INVENTORY: 'مخزون',
  PAYROLL: 'رواتب',
  ADJUSTMENT: 'تسوية',
  DEPRECIATION: 'إهلاك',
  OPENING: 'افتتاحي',
  CLOSING: 'إقفال',
};

/**
 * The general ledger for one account.
 *
 * The report an accountant opens when the trial balance shows a figure they did not expect: it
 * is the only view that answers *which entries made this number*. Everything on it exists to
 * serve that question — the running balance so a discrepancy can be located by scanning rather
 * than by adding up, the opening balance so the period stands on its own, and the entry number
 * so the answer can be taken back to the journal register.
 *
 * The account is chosen from the postable accounts only. A journal line cannot land on a
 * grouping account — `isPostable` is exactly that rule — so offering one would produce an
 * empty ledger that looks like a data problem.
 */
export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: { account?: string; from?: string; to?: string; branch?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const fromDate = parseReportDate(searchParams.from, fallback.from);
  const toDate = parseReportDate(searchParams.to, fallback.to);
  const branchId = searchParams.branch;
  const accountId = searchParams.account;

  const { ledger, accounts, branches, currency } = await withPageScope(async (context) => {
    const [tenant, loadedAccounts, loadedBranches] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
      prisma.account.findMany({
        where: { tenantId: context.tenantId, isPostable: true, isActive: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
      prisma.branch.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
    ]);

    const loaded =
      accountId === undefined || accountId === ''
        ? null
        : await getGeneralLedger({
            tenantId: context.tenantId,
            accountId,
            fromDate: new Date(`${fromDate}T00:00:00.000Z`),
            toDate: new Date(`${toDate}T00:00:00.000Z`),
            ...(branchId !== undefined && branchId !== 'ALL' ? { branchId } : {}),
            currency: tenant.functionalCurrency,
          });

    return {
      ledger: loaded,
      accounts: loadedAccounts,
      branches: loadedBranches,
      currency: tenant.functionalCurrency,
    };
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">دفتر الأستاذ العام</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          كل حركات حساب واحد خلال فترة، برصيد متحرك — القيود المُرحَّلة فقط
        </p>
      </header>

      <ReportFilters
        action="/finance/general-ledger"
        fromDate={fromDate}
        toDate={toDate}
        branches={branches}
        branchId={branchId}
        extra={
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">الحساب</span>
            <select
              name="account"
              defaultValue={accountId ?? ''}
              className="h-9 min-w-[18rem] rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">— اختر حساباً —</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.nameAr}
                </option>
              ))}
            </select>
          </label>
        }
      />

      {ledger === null ? (
        <Card>
          <CardBody>
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <ScrollText className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                اختر حساباً قابلاً للترحيل لعرض دفتر الأستاذ الخاص به.
              </p>
              <Link
                href="/finance/accounts"
                className="text-xs text-primary hover:underline"
              >
                تصفّح شجرة الحسابات
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="الرصيد الافتتاحي"
              value={formatMoney(ledger.openingBalance, { currency })}
              hint="كل ما رُحِّل قبل بداية الفترة"
            />
            <Tile label="مدين الفترة" value={formatMoney(ledger.periodDebit, { currency })} />
            <Tile label="دائن الفترة" value={formatMoney(ledger.periodCredit, { currency })} />
            <Tile
              label="الرصيد الختامي"
              value={formatMoney(ledger.closingBalance, { currency })}
              hint={ledger.account.nature === 'DEBIT' ? 'بالاتجاه المدين' : 'بالاتجاه الدائن'}
              emphasise
            />
          </div>

          {ledger.truncated ? (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
              <div>
                <p className="font-medium">عُرضت أول ألف حركة فقط</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  الإجماليات أعلاه تخص المعروض لا الفترة كاملة. ضيِّق نطاق التاريخ أو حدِّد فرعاً
                  للحصول على صورة كاملة.
                </p>
              </div>
            </div>
          ) : null}

          <Card>
            <CardHeader
              title={`${ledger.account.code} · ${ledger.account.nameAr}`}
              description={`${ledger.lines.length} حركة — الرصيد المتحرك بالاتجاه ${
                ledger.account.nature === 'DEBIT' ? 'المدين' : 'الدائن'
              } للحساب`}
              action={
                <Badge tone="info">
                  {ledger.account.nature === 'DEBIT' ? 'حساب مدين' : 'حساب دائن'}
                </Badge>
              }
            />
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">التاريخ</th>
                    <th scope="col">رقم القيد</th>
                    <th scope="col">النوع</th>
                    <th scope="col">البيان</th>
                    <th scope="col">الطرف</th>
                    <th scope="col" className="numeric">مدين</th>
                    <th scope="col" className="numeric">دائن</th>
                    <th scope="col" className="numeric">الرصيد</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-muted/40 font-medium">
                    <td colSpan={7}>الرصيد الافتتاحي</td>
                    <td className="numeric">
                      {formatMoney(ledger.openingBalance, { currency, showCurrency: false })}
                    </td>
                  </tr>
                  {ledger.lines.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-muted-foreground">
                        لا توجد حركات على هذا الحساب خلال الفترة
                      </td>
                    </tr>
                  ) : (
                    ledger.lines.map((line, index) => (
                      <tr key={`${line.journalId}-${index}`}>
                        <td className="whitespace-nowrap text-xs">
                          {formatDate(line.date, { calendar: 'gregorian', style: 'medium' })}
                        </td>
                        <td>
                          <span className="bidi-isolate font-mono text-xs text-primary">
                            {line.entryNumber}
                          </span>
                        </td>
                        <td className="text-xs text-muted-foreground">
                          {TYPE_LABELS[line.journalType] ?? line.journalType}
                        </td>
                        <td className="max-w-[20rem]">
                          <p className="truncate">{line.descriptionAr}</p>
                          {line.lineDescription !== null ? (
                            <p className="truncate text-[11px] text-muted-foreground">
                              {line.lineDescription}
                            </p>
                          ) : null}
                        </td>
                        <td className="max-w-[12rem] truncate text-xs text-muted-foreground">
                          {line.counterpartyName ?? '—'}
                        </td>
                        <td className="numeric">
                          {line.debit === '0' || Number(line.debit) === 0
                            ? ''
                            : formatMoney(line.debit, { currency, showCurrency: false })}
                        </td>
                        <td className="numeric">
                          {line.credit === '0' || Number(line.credit) === 0
                            ? ''
                            : formatMoney(line.credit, { currency, showCurrency: false })}
                        </td>
                        <td className="numeric font-medium">
                          {formatMoney(line.runningBalance, { currency, showCurrency: false })}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td colSpan={5}>إجمالي الفترة</td>
                    <td className="numeric">
                      {formatMoney(ledger.periodDebit, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric">
                      {formatMoney(ledger.periodCredit, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric">
                      {formatMoney(ledger.closingBalance, { currency, showCurrency: false })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  emphasise = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasise?: boolean;
}): JSX.Element {
  return (
    <Card>
      <CardBody>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={
            emphasise
              ? 'numeric mt-1 text-2xl font-semibold tracking-tight text-primary'
              : 'numeric mt-1 text-2xl font-semibold tracking-tight'
          }
        >
          {value}
        </p>
        {hint !== undefined ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
      </CardBody>
    </Card>
  );
}
