import { ListTree, Lock } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { listNumberSequences } from '@/lib/application/services/numbering-service';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'تسلسل الترقيم' };

/**
 * Document numbering.
 *
 * The screen is deliberately read-only, and says so rather than leaving the reader to wonder
 * where the edit button is. A counter a user can set is a counter that can be set backwards —
 * the next allocation then collides with a document that already exists — or forwards, which
 * silently manufactures the gap an auditor reads as a deleted invoice.
 *
 * What the page is *for* is answering "where does the next invoice number come from, and has
 * anything skipped?", which is the question people actually bring to a numbering screen.
 */
export default async function Page(): Promise<JSX.Element> {
  const series = await withPageScope(async (context) =>
    withTenantRead((tx) => listNumberSequences(tx, context.tenantId)),
  );

  const totalIssued = series.reduce((sum, row) => sum + row.issued, 0n);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">تسلسل الترقيم</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {series.length} سلسلة نشطة، صدر منها{' '}
          <span className="numeric">{totalIssued.toLocaleString('en-US')}</span> مستند. يُخصَّص كل
          رقم داخل قفل على صف العدّاد، فلا تحصل معاملتان متزامنتان على الرقم نفسه.
        </p>
      </header>

      <Card>
        <CardHeader
          title="السلاسل"
          description="الرقم التالي لكل سلسلة، ونموذج لشكله"
          action={
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              للعرض فقط
            </span>
          }
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">السلسلة</th>
                <th scope="col">السنة</th>
                <th scope="col">البادئة</th>
                <th scope="col" className="numeric">عدد المستندات</th>
                <th scope="col" className="numeric">الرقم التالي</th>
                <th scope="col">النموذج</th>
              </tr>
            </thead>
            <tbody>
              {series.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-muted-foreground">
                    لم يصدر أي مستند بعد. تظهر السلسلة هنا عند إصدار أول مستند منها.
                  </td>
                </tr>
              ) : (
                series.map((row) => (
                  <tr key={`${row.key}-${row.year}`}>
                    <td>
                      <p>{row.labelAr}</p>
                      <p className="bidi-isolate font-mono text-[11px] text-muted-foreground">
                        {row.key}
                      </p>
                    </td>
                    <td className="numeric">{row.year === 0 ? '—' : row.year}</td>
                    <td>
                      <span className="bidi-isolate font-mono text-xs">{row.prefix}</span>
                    </td>
                    <td className="numeric">{row.issued.toLocaleString('en-US')}</td>
                    <td className="numeric font-medium">{row.nextValue}</td>
                    <td>
                      <span className="bidi-isolate font-mono text-xs text-primary">
                        {row.sample}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <CardBody className="border-t border-border text-xs text-muted-foreground">
          <p className="flex items-start gap-2">
            <ListTree className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              الأرقام تُستهلك ولا تُعاد: حذف مسودة يترك فجوة دائمة، لأن سلسلة تعيد ترقيم نفسها
              سلسلة لا يستطيع المدقق الاعتماد عليها. عدّاد الفوترة الإلكترونية (ICV) مسجَّل تحت
              السنة «—» لأنه لا يُصفَّر مع بداية كل سنة — الهيئة تقرأ أي انقطاع فيه كفاتورة صدرت
              ثم أُخفيت.
            </span>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
