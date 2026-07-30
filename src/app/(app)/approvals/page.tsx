import { ApprovalInbox } from '@/components/approvals/approval-inbox';

export const metadata = { title: 'صندوق الاعتمادات' };

/**
 * The approval inbox.
 *
 * The schema behind this — policies, steps, requests, actions — shipped in migration 1
 * and nothing ever wrote to it. `approval-service.ts` is what drives it, and this is
 * what a reviewer sees.
 */
export default function ApprovalsPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">صندوق الاعتمادات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          الطلبات التي تنتظر قرارك بحسب الدور المسنَد إلى خطوتها الحالية.
        </p>
      </header>

      <ApprovalInbox />
    </div>
  );
}
