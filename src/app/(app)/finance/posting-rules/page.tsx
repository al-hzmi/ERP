import { PostingRulesTable } from '@/components/finance/posting-rules-table';
import { withPageScope } from '@/lib/api/page';
import {
  listPostableAccounts,
  listPostingRules,
} from '@/lib/application/services/posting-rules-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'قواعد الترحيل الآلي' };

export default async function Page(): Promise<JSX.Element> {
  const { rules, accounts, canEdit } = await withPageScope(async (context) => ({
    rules: await listPostingRules(context.tenantId),
    accounts: await listPostableAccounts(context.tenantId),
    canEdit: context.permissions.can('finance.account', 'update'),
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">قواعد الترحيل الآلي</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          الحساب الذي تُرحَّل إليه كل عملية — الفواتير والتسويات والرواتب والإهلاك
        </p>
      </header>

      <PostingRulesTable rules={rules} accounts={accounts} canEdit={canEdit} />
    </div>
  );
}
