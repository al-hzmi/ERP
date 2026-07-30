import { JournalEntryForm } from '@/components/finance/journal-entry-form';

export const metadata = { title: 'قيد محاسبي جديد' };

/**
 * The journal entry screen.
 *
 * Manual entries are the exception in this system, not the rule: almost every journal
 * is derived from a document by the posting engine. This screen exists for the ones
 * no document produces — accruals, reclassifications, opening balances — which is
 * also why it is the screen that refuses the most.
 */
export default function NewJournalEntryPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">قيد محاسبي جديد</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          للقيود اليدوية فقط — التسويات والمخصصات والأرصدة الافتتاحية. قيود المستندات
          تُنشأ آلياً عند الترحيل.
        </p>
      </header>

      <JournalEntryForm />
    </div>
  );
}
