import type { PaymentType } from '@prisma/client';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate, formatMoney, statusLabel } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'سندات القبض والصرف' };

const PAGE_SIZE = 25;

/**
 * The voucher register.
 *
 * `recordPayment` has been posting these since the first commit and nothing displayed them —
 * so the sidebar linked here and returned a 404. Receipts and payments share one register
 * rather than getting one each, because the question a cashier asks is "what moved through
 * this account today", and that question does not respect the direction.
 *
 * `unallocatedAmount` earns a column of its own. It is the part of a voucher not applied to
 * any document — a customer advance, an overpayment — and it is the number that quietly
 * accumulates when vouchers are entered without allocating them. A register that showed only
 * the total would hide it until someone asked why the customer's statement disagreed with
 * their balance.
 */

const TYPE_LABELS: Record<string, { label: string; tone: 'success' | 'warning' }> = {
  RECEIPT: { label: 'قبض', tone: 'success' },
  PAYMENT: { label: 'صرف', tone: 'warning' },
};

const METHOD_LABELS: Record<string, string> = {
  CASH: 'نقداً',
  BANK: 'تحويل بنكي',
  CHECK: 'شيك',
  CARD: 'بطاقة',
};

const TYPE_FILTERS = [
  { value: 'ALL', label: 'الكل' },
  { value: 'RECEIPT', label: 'قبض' },
  { value: 'PAYMENT', label: 'صرف' },
];

export default async function PaymentVouchersPage({
  searchParams,
}: {
  searchParams: { page?: string; type?: string; status?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const type = searchParams.type;
  const status = searchParams.status;

  const { vouchers, total, functionalCurrency, canCreate } = await withPageScope(
    async (context) => {
      const where = {
        tenantId: context.tenantId,
        ...(type === 'RECEIPT' || type === 'PAYMENT' ? { type: type as PaymentType } : {}),
        ...(status !== undefined && status !== 'ALL' ? { status: status as never } : {}),
      };

      const [loadedVouchers, loadedTotal, tenant] = await Promise.all([
        prisma.payment.findMany({
          where,
          select: {
            id: true,
            voucherNumber: true,
            type: true,
            status: true,
            paymentDate: true,
            amount: true,
            unallocatedAmount: true,
            currency: true,
            method: true,
            checkNumber: true,
            counterparty: { select: { code: true, nameAr: true } },
            account: { select: { code: true, nameAr: true } },
            _count: { select: { allocations: true } },
          },
          orderBy: [{ paymentDate: 'desc' }, { voucherNumber: 'desc' }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        prisma.payment.count({ where }),
        prisma.tenant.findUniqueOrThrow({
          where: { id: context.tenantId },
          select: { functionalCurrency: true },
        }),
      ]);

      return {
        vouchers: loadedVouchers,
        total: loadedTotal,
        functionalCurrency: tenant.functionalCurrency,
        canCreate: context.permissions.can('treasury.payment', 'create'),
      };
    },
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const queryFor = (next: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const merged = { type, status, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    return `/treasury/payments?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">سندات القبض والصرف</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="numeric">{total.toLocaleString('en-US')}</span> سند
          </p>
        </div>
        {canCreate ? (
          <Link href="/treasury/payments/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden="true" />
              سند جديد
            </Button>
          </Link>
        ) : null}
      </header>

      <Card>
        <CardHeader
          title="السجل"
          description="المبلغ غير المخصَّص هو ما لم يُطبَّق على أي مستند بعد — دفعة مقدمة أو زيادة سداد"
          action={
            <nav className="flex flex-wrap gap-1" aria-label="تصفية حسب النوع">
              {TYPE_FILTERS.map((filter) => {
                const active = (type ?? 'ALL') === filter.value;
                return (
                  <Link
                    key={filter.value}
                    href={queryFor({ type: filter.value, page: '1' })}
                    className={
                      active
                        ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                        : 'rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
                    }
                  >
                    {filter.label}
                  </Link>
                );
              })}
            </nav>
          }
        />

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم السند</th>
                <th scope="col">النوع</th>
                <th scope="col">التاريخ</th>
                <th scope="col">العميل / المورد</th>
                <th scope="col">الحساب</th>
                <th scope="col">الطريقة</th>
                <th scope="col" className="numeric">
                  المبلغ
                </th>
                <th scope="col" className="numeric">
                  غير مخصَّص
                </th>
                <th scope="col">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {vouchers.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-muted-foreground">
                    لا توجد سندات مطابقة للتصفية الحالية
                  </td>
                </tr>
              ) : (
                vouchers.map((voucher) => {
                  const badge = statusLabel(voucher.status);
                  const kind = TYPE_LABELS[voucher.type] ?? { label: voucher.type, tone: 'success' as const };
                  const unallocated = voucher.unallocatedAmount;

                  return (
                    <tr key={voucher.id}>
                      <td>
                        <span className="bidi-isolate font-mono text-xs font-medium text-primary">
                          {voucher.voucherNumber}
                        </span>
                      </td>
                      <td>
                        <Badge tone={kind.tone}>{kind.label}</Badge>
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {formatDate(voucher.paymentDate, {
                          calendar: 'gregorian',
                          style: 'medium',
                        })}
                      </td>
                      <td className="max-w-[14rem]">
                        <p className="truncate">{voucher.counterparty.nameAr}</p>
                        <p className="bidi-isolate text-[11px] text-muted-foreground">
                          {voucher.counterparty.code}
                        </p>
                      </td>
                      <td className="text-xs text-muted-foreground">
                        <span className="bidi-isolate font-mono">{voucher.account.code}</span>
                      </td>
                      <td className="text-xs text-muted-foreground">
                        {METHOD_LABELS[voucher.method] ?? voucher.method}
                        {voucher.checkNumber !== null ? (
                          <span className="bidi-isolate ms-1 font-mono text-[11px]">
                            {voucher.checkNumber}
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric font-medium">
                        {formatMoney(voucher.amount.toFixed(4), {
                          currency: voucher.currency,
                          showCurrency: false,
                        })}
                      </td>
                      <td className="numeric">
                        <span
                          className={
                            unallocated.greaterThan(0)
                              ? 'font-medium text-warning'
                              : 'text-muted-foreground'
                          }
                        >
                          {formatMoney(unallocated.toFixed(4), {
                            currency: voucher.currency,
                            showCurrency: false,
                          })}
                        </span>
                      </td>
                      <td>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm">
            <p className="text-muted-foreground">
              صفحة <span className="numeric">{page}</span> من{' '}
              <span className="numeric">{totalPages}</span>
            </p>
            <div className="flex gap-2">
              <Link
                href={queryFor({ page: String(Math.max(1, page - 1)) })}
                aria-disabled={page === 1}
                className={
                  page === 1
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                السابق
              </Link>
              <Link
                href={queryFor({ page: String(Math.min(totalPages, page + 1)) })}
                aria-disabled={page === totalPages}
                className={
                  page === totalPages
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                التالي
              </Link>
            </div>
          </div>
        ) : null}
      </Card>

      <p className="text-xs text-muted-foreground">
        العملة الوظيفية للمنشأة: <span className="bidi-isolate">{functionalCurrency}</span>
      </p>
    </div>
  );
}
