import Link from 'next/link';
import { Search, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { formatMoney } from '@/lib/utils/format';
import type { CounterpartyRow } from '@/lib/application/services/counterparty-service';

/**
 * The customer and supplier registers, which are the same table read two ways.
 *
 * A server component, not a client one: it renders from data the page already fetched inside
 * the tenant scope, and it holds no state. Shipping it to the browser would send a filter form
 * and a table to the client for nothing.
 *
 * `creditLimit` is behind `FIELD_LEVEL_PROTECTED['sales.customer']`, so the caller passes
 * `canSeeCredit` rather than this component deciding — the permission check belongs where the
 * request context is, and a presentational component that reached for it would be a second
 * place to get it wrong.
 */

const CLASS_TONES: Record<string, 'success' | 'info' | 'neutral'> = {
  A: 'success',
  B: 'info',
  C: 'neutral',
};

export function CounterpartyRegister({
  kind,
  basePath,
  rows,
  total,
  page,
  pageSize,
  query,
  status,
  canSeeCredit,
}: {
  kind: 'CUSTOMER' | 'SUPPLIER';
  basePath: string;
  rows: readonly CounterpartyRow[];
  total: number;
  page: number;
  pageSize: number;
  query: string | undefined;
  status: string;
  canSeeCredit: boolean;
}): JSX.Element {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const isCustomer = kind === 'CUSTOMER';

  const queryFor = (next: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const merged = { q: query, status, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    return `${basePath}?${params.toString()}`;
  };

  const STATUS_FILTERS = [
    { value: 'ACTIVE', label: 'النشِطون' },
    { value: 'INACTIVE', label: 'الموقوفون' },
    { value: 'ALL', label: 'الكل' },
  ];

  const columns = canSeeCredit ? 8 : 7;

  return (
    <Card>
      <CardHeader
        title="السجل"
        description={
          isCustomer
            ? 'الرصيد موجب يعني مديونية على العميل. اضغط الرمز لفتح البطاقة وأعمار الدين'
            : 'الرصيد موجب يعني التزاماً على المنشأة تجاه المورد'
        }
        action={
          <nav className="flex flex-wrap gap-1" aria-label="تصفية حسب الحالة">
            {STATUS_FILTERS.map((filter) => {
              const active = status === filter.value;
              return (
                <Link
                  key={filter.value}
                  href={queryFor({ status: filter.value, page: '1' })}
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

      <form method="get" action={basePath} className="flex flex-wrap gap-2 px-5 pb-4">
        <input type="hidden" name="status" value={status} />
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder="ابحث بالرمز أو الاسم أو الرقم الضريبي أو الهاتف…"
            aria-label="بحث"
            className="h-9 w-full rounded-md border border-input bg-background ps-9 pe-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button
          type="submit"
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          بحث
        </button>
      </form>

      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">الرمز</th>
              <th scope="col">الاسم</th>
              <th scope="col">التواصل</th>
              <th scope="col">الرقم الضريبي</th>
              <th scope="col" className="numeric">
                مهلة السداد
              </th>
              {canSeeCredit ? (
                <th scope="col" className="numeric">
                  حد الائتمان
                </th>
              ) : null}
              <th scope="col" className="numeric">
                الرصيد
              </th>
              <th scope="col">الحالة</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns} className="py-16 text-center text-muted-foreground">
                  <Users className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
                  لا توجد نتائج مطابقة للتصفية الحالية
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const balance = Number.parseFloat(row.balance);
                const limit = Number.parseFloat(row.creditLimit);
                // Only a display hint — the real credit check lives in the posting path, where
                // it can refuse. A colour here that pretended to be a control would be worse
                // than none.
                const overLimit = canSeeCredit && limit > 0 && balance > limit;

                return (
                  <tr key={row.id}>
                    <td>
                      <Link
                        href={`${basePath}/${row.id}`}
                        className="bidi-isolate font-mono text-xs font-medium text-primary hover:underline"
                      >
                        {row.code}
                      </Link>
                    </td>
                    <td className="max-w-[16rem]">
                      <p className="truncate">{row.nameAr}</p>
                      <p className="bidi-isolate truncate text-[11px] text-muted-foreground">
                        {row.nameEn}
                      </p>
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {row.phone !== null ? (
                        <span className="bidi-isolate block">{row.phone}</span>
                      ) : null}
                      {row.email !== null ? (
                        <span className="bidi-isolate block truncate">{row.email}</span>
                      ) : null}
                      {row.phone === null && row.email === null ? '—' : null}
                    </td>
                    <td className="bidi-isolate font-mono text-xs text-muted-foreground">
                      {row.taxNumber ?? '—'}
                    </td>
                    <td className="numeric text-xs text-muted-foreground">
                      {row.paymentTerms} يوم
                    </td>
                    {canSeeCredit ? (
                      <td className="numeric text-muted-foreground">
                        {formatMoney(row.creditLimit, {
                          currency: row.currency,
                          showCurrency: false,
                        })}
                      </td>
                    ) : null}
                    <td className="numeric font-medium">
                      <span className={overLimit ? 'text-destructive' : undefined}>
                        {formatMoney(row.balance, {
                          currency: row.currency,
                          showCurrency: false,
                        })}
                      </span>
                    </td>
                    <td>
                      <Badge tone={CLASS_TONES[row.classification] ?? 'neutral'}>
                        {row.classification}
                      </Badge>
                      {!row.isActive ? (
                        <Badge tone="neutral" className="ms-1">
                          موقوف
                        </Badge>
                      ) : null}
                      {row.type === 'BOTH' ? (
                        <Badge tone="info" className="ms-1">
                          عميل ومورد
                        </Badge>
                      ) : null}
                      {overLimit ? (
                        <Badge tone="danger" className="ms-1">
                          تجاوز الحد
                        </Badge>
                      ) : null}
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
  );
}
