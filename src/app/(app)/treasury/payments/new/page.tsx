import { PaymentVoucherForm } from '@/components/treasury/payment-voucher-form';

export const metadata = { title: 'سند جديد' };

/**
 * Voucher entry.
 *
 * `recordPayment` has been fully tested since the first commit with nothing calling it from a
 * screen. This is that screen, and it follows the convention the other entry forms set: the
 * arithmetic on display comes from the domain — `Money` at scale 4, the same type the API
 * posts with — so the "unallocated" figure read before submitting is the figure the server
 * computes.
 *
 * Unlike an invoice, a voucher does not save as a draft. It posts to the ledger immediately,
 * because a receipt is an event that has already happened by the time anyone types it.
 */
export default function NewPaymentVoucherPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">سند قبض / صرف</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          تخصيص المبلغ على المستندات غير المسددة، أو تسجيله كدفعة مقدمة غير مخصَّصة.
        </p>
      </header>

      <PaymentVoucherForm />
    </div>
  );
}
