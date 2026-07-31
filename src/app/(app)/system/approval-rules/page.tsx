import { RulesBuilder } from '@/components/system/rules-builder';
import { withPageScope } from '@/lib/api/page';
import {
  DOCUMENT_TYPE_LABELS_AR,
  RULE_DOCUMENT_TYPES,
  listApprovalRules,
  listRoles,
} from '@/lib/application/services/approval-rules-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'قواعد الموافقات' };

/**
 * The rules builder.
 *
 * `system.role` authority, not `finance.approve`: a rule decides *who must sign for what*,
 * which is a statement about the organisation's controls rather than about any one document.
 */
export default async function Page(): Promise<JSX.Element> {
  const { rules, roles, canEdit } = await withPageScope(async (context) => ({
    rules: await listApprovalRules(context.tenantId),
    roles: await listRoles(context.tenantId),
    canEdit: context.permissions.can('system.role', 'update'),
  }));

  const active = rules.filter((rule) => rule.isActive).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">قواعد الموافقات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {active} قاعدة مفعَّلة. تُقيَّم عند تأكيد المستند — لا عند إنشائه، لأن المسودة لا
          تُلزم أحداً — وإذا تطابقت قاعدة تَوقَّف المستند بحالة «بانتظار الاعتماد».
        </p>
      </header>

      <RulesBuilder
        rules={rules}
        documentTypes={RULE_DOCUMENT_TYPES.map((type) => ({
          value: type,
          label: DOCUMENT_TYPE_LABELS_AR[type] ?? type,
        }))}
        roles={roles}
        canEdit={canEdit}
      />
    </div>
  );
}
