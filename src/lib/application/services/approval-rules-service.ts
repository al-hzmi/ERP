import { Prisma } from '@prisma/client';
import type { ApprovalConditionField, ApprovalConditionOperator } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import {
  describeCondition,
  selectGoverningRule,
  type DocumentFacts,
  type EvaluableRule,
  type RuleMatch,
} from '@/lib/domain/approvals/rule-evaluator';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import type { TransactionClient } from '@/lib/infrastructure/db/prisma';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';
import { logger } from '@/lib/infrastructure/logging/logger';

/**
 * Approval rules: reading them, writing them, and the gate that applies them.
 *
 * The evaluation itself is in `domain/approvals/rule-evaluator.ts` and is pure. This module is
 * the part that talks to the database — loading the rules, computing the facts of a document,
 * and raising the request when one fires.
 *
 * ## The gate is a function, not a framework
 *
 * `evaluateApprovalGate` takes the caller's transaction and returns "held" or "not held". It
 * does not know what a trade document is; it is given `documentType` and a `DocumentFacts`
 * bag. Wiring a second document family to it means computing five numbers, not extending an
 * abstraction — which is the whole reason the seam is shaped this way.
 */

/** The document families a rule can govern. Kept narrow: only what a screen can produce. */
export const RULE_DOCUMENT_TYPES = [
  'SALES_ORDER',
  'PURCHASE_ORDER',
  'QUOTATION',
  'SALES_RETURN',
] as const;

export type RuleDocumentType = (typeof RULE_DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS_AR: Record<string, string> = {
  SALES_ORDER: 'أمر بيع',
  PURCHASE_ORDER: 'أمر شراء',
  QUOTATION: 'عرض سعر',
  SALES_RETURN: 'مرتجع مبيعات',
};

export interface RuleConditionRow {
  readonly id: string;
  readonly field: ApprovalConditionField;
  readonly operator: ApprovalConditionOperator;
  readonly value: string;
  readonly describedAr: string;
}

export interface RuleStepRow {
  readonly stepNumber: number;
  readonly roleId: string;
  readonly roleNameAr: string;
  readonly excludeInitiator: boolean;
}

export interface ApprovalRuleRow {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly documentType: string;
  readonly documentTypeLabelAr: string;
  readonly minAmount: string;
  readonly priority: number;
  readonly isActive: boolean;
  readonly conditions: readonly RuleConditionRow[];
  readonly steps: readonly RuleStepRow[];
  /** Requests this rule has raised. What makes deactivating it a considered act. */
  readonly requestCount: number;
}

export async function listApprovalRules(tenantId: string): Promise<ApprovalRuleRow[]> {
  return withTenantRead(async (tx) => {
    const rules = await tx.approvalPolicy.findMany({
      where: { tenantId },
      orderBy: [{ documentType: 'asc' }, { priority: 'asc' }],
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        documentType: true,
        minAmount: true,
        priority: true,
        isActive: true,
        conditions: {
          select: { id: true, field: true, operator: true, value: true },
          orderBy: { field: 'asc' },
        },
        steps: {
          select: {
            stepNumber: true,
            roleId: true,
            excludeInitiator: true,
            role: { select: { nameAr: true } },
          },
          orderBy: { stepNumber: 'asc' },
        },
        _count: { select: { requests: true } },
      },
    });

    return rules.map((rule) => ({
      id: rule.id,
      nameAr: rule.nameAr,
      nameEn: rule.nameEn,
      documentType: rule.documentType,
      documentTypeLabelAr: DOCUMENT_TYPE_LABELS_AR[rule.documentType] ?? rule.documentType,
      minAmount: rule.minAmount.toString(),
      priority: rule.priority,
      isActive: rule.isActive,
      conditions: rule.conditions.map((condition) => ({
        id: condition.id,
        field: condition.field,
        operator: condition.operator,
        value: condition.value.toString(),
        describedAr: describeCondition({
          field: condition.field,
          operator: condition.operator,
          value: condition.value.toString(),
        }),
      })),
      steps: rule.steps.map((step) => ({
        stepNumber: step.stepNumber,
        roleId: step.roleId,
        roleNameAr: step.role.nameAr,
        excludeInitiator: step.excludeInitiator,
      })),
      requestCount: rule._count.requests,
    }));
  });
}

export interface CreateRuleInput {
  readonly tenantId: string;
  readonly audit: AuditContext;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly documentType: string;
  readonly priority: number;
  readonly conditions: readonly {
    field: ApprovalConditionField;
    operator: ApprovalConditionOperator;
    value: string;
  }[];
  /** Ordered. Each is a role that must sign, in sequence. */
  readonly approverRoleIds: readonly string[];
  readonly excludeInitiator: boolean;
}

/**
 * Writes a rule, its conditions and its approval chain in one transaction.
 *
 * **A rule with no approvers is refused.** `requestApproval` already refuses to raise against
 * a policy with no steps — it would create a request nobody can ever action and block the
 * document forever. Refusing at write time turns that from a runtime surprise into a form
 * error, which is where it belongs.
 */
export async function createApprovalRule(
  input: CreateRuleInput,
): Promise<Result<{ id: string }, DomainError>> {
  const nameAr = input.nameAr.trim();
  const nameEn = input.nameEn.trim();

  if (nameAr === '' || nameEn === '') {
    return err(
      DomainErrors.validation('اسم القاعدة مطلوب بالعربية والإنجليزية.', 'A rule name is required.', 'nameAr'),
    );
  }

  if (input.approverRoleIds.length === 0) {
    return err(
      DomainErrors.validation(
        'القاعدة تحتاج معتمِداً واحداً على الأقل — قاعدة بلا معتمِدين توقف المستند إلى الأبد.',
        'A rule needs at least one approver, or it holds documents forever.',
        'approverRoleIds',
      ),
    );
  }

  if (new Set(input.approverRoleIds).size !== input.approverRoleIds.length) {
    return err(
      DomainErrors.validation(
        'لا يمكن تكرار نفس الدور في سلسلة الاعتماد.',
        'A role cannot appear twice in one approval chain.',
        'approverRoleIds',
      ),
    );
  }

  if (input.conditions.length > 5) {
    return err(
      DomainErrors.validation('الحد الأقصى خمسة شروط للقاعدة.', 'At most five conditions.', 'conditions'),
    );
  }

  for (const condition of input.conditions) {
    if (!/^\d+(\.\d{1,4})?$/.test(condition.value)) {
      return err(
        DomainErrors.validation(
          'قيمة الشرط يجب أن تكون رقماً موجباً.',
          'A condition value must be a non-negative number.',
          'conditions',
        ),
      );
    }
  }

  return withTransaction(async (tx) => {
    const roles = await tx.role.findMany({
      where: { id: { in: [...input.approverRoleIds] }, tenantId: input.tenantId },
      select: { id: true },
    });

    if (roles.length !== new Set(input.approverRoleIds).size) {
      return err(DomainErrors.notFound('الدور', 'Role', input.approverRoleIds[0] ?? ''));
    }

    try {
      const rule = await tx.approvalPolicy.create({
        data: {
          tenantId: input.tenantId,
          nameAr,
          nameEn,
          documentType: input.documentType,
          priority: input.priority,
          // `minAmount` stays zero: with general conditions it is redundant, and a value in
          // both places is two thresholds a reader has to reconcile. It remains in the schema
          // for the rules written before conditions existed.
          minAmount: new Prisma.Decimal(0),
        },
        select: { id: true },
      });

      if (input.conditions.length > 0) {
        await tx.approvalRuleCondition.createMany({
          data: input.conditions.map((condition) => ({
            tenantId: input.tenantId,
            policyId: rule.id,
            field: condition.field,
            operator: condition.operator,
            value: new Prisma.Decimal(condition.value),
          })),
        });
      }

      await tx.approvalStep.createMany({
        data: input.approverRoleIds.map((roleId, index) => ({
          tenantId: input.tenantId,
          policyId: rule.id,
          stepNumber: index + 1,
          roleId,
          excludeInitiator: input.excludeInitiator,
        })),
      });

      await recordAudit(
        tx,
        input.audit,
        'CREATE',
        { entityType: 'approvalRule', entityId: rule.id },
        {
          metadata: {
            nameAr,
            documentType: input.documentType,
            conditions: input.conditions.length,
            steps: input.approverRoleIds.length,
          },
        },
      );

      return ok(rule);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return err(
          DomainErrors.validation(`اسم القاعدة "${nameAr}" مستخدم بالفعل.`, 'That rule name is taken.', 'nameAr'),
        );
      }
      throw error;
    }
  });
}

/**
 * Activates or deactivates a rule.
 *
 * There is no delete. A rule that has raised requests is the recorded reason those documents
 * were held, and deleting it would cascade its conditions away and leave the requests
 * pointing at a rule nobody can inspect. Deactivating stops it governing anything new and
 * leaves the history readable — the same argument the reference tables make.
 */
export async function setApprovalRuleActive(input: {
  tenantId: string;
  audit: AuditContext;
  id: string;
  isActive: boolean;
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const updated = await tx.approvalPolicy.updateMany({
      where: { id: input.id, tenantId: input.tenantId },
      data: { isActive: input.isActive },
    });

    if (updated.count === 0) {
      return err(DomainErrors.notFound('القاعدة', 'Approval rule', input.id));
    }

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'approvalRule', entityId: input.id },
      { metadata: { isActive: input.isActive } },
    );

    return ok({ id: input.id });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  The gate
// ─────────────────────────────────────────────────────────────────────────────

export interface GateOutcome {
  readonly held: boolean;
  readonly requestId: string | null;
  readonly ruleNameAr: string | null;
  readonly totalSteps: number;
}

/**
 * Decides whether a document is held, and raises the request when it is.
 *
 * Runs inside the caller's transaction, deliberately: the document's status change and the
 * approval request are one fact. A gate that committed separately could leave a document
 * confirmed with a pending request against it, or held with no request — and the second is
 * unrecoverable from the UI, because nothing would appear in anyone's inbox.
 *
 * Returns `held: false` when no rule matches, which is the common case and not a failure.
 */
export async function evaluateApprovalGate(
  tx: TransactionClient,
  input: {
    tenantId: string;
    entityType: string;
    entityId: string;
    documentType: string;
    facts: DocumentFacts;
    requestedById: string;
  },
): Promise<Result<GateOutcome, DomainError>> {
  const policies = await tx.approvalPolicy.findMany({
    where: { tenantId: input.tenantId, documentType: input.documentType, isActive: true },
    select: {
      id: true,
      nameAr: true,
      nameEn: true,
      priority: true,
      minAmount: true,
      conditions: { select: { field: true, operator: true, value: true } },
      _count: { select: { steps: true } },
    },
  });

  if (policies.length === 0) {
    return ok({ held: false, requestId: null, ruleNameAr: null, totalSteps: 0 });
  }

  const evaluable: EvaluableRule[] = policies.map((policy) => ({
    id: policy.id,
    nameAr: policy.nameAr,
    nameEn: policy.nameEn,
    priority: policy.priority,
    minAmount: policy.minAmount.toString(),
    conditions: policy.conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      value: condition.value.toString(),
    })),
  }));

  const match: RuleMatch | null = selectGoverningRule(evaluable, input.facts);
  if (match === null) {
    return ok({ held: false, requestId: null, ruleNameAr: null, totalSteps: 0 });
  }

  const policy = policies.find((candidate) => candidate.id === match.rule.id);

  // Refused rather than passed through. A rule with no approvers would raise a request nobody
  // can action and hold the document forever; letting the document sail past instead would
  // mean a control the administrator configured silently did nothing. Neither is acceptable,
  // so the confirm fails and names the rule. `createApprovalRule` prevents this at write time;
  // this covers rules created before that check, and steps deleted afterwards.
  if (policy === undefined || policy._count.steps === 0) {
    return err(
      DomainErrors.validation(
        `القاعدة "${match.rule.nameAr}" لا تحتوي على أي معتمِد — لا يمكن ترحيل المستند حتى تُصحَّح.`,
        `Approval rule "${match.rule.nameEn}" has no approvers configured.`,
      ),
    );
  }

  const existing = await tx.approvalRequest.findFirst({
    where: {
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
    },
    select: { id: true, status: true },
  });

  if (existing !== null) {
    return err(
      DomainErrors.validation(
        'يوجد طلب اعتماد لهذا المستند بالفعل.',
        'An approval request already exists for this document.',
      ),
    );
  }

  const request = await tx.approvalRequest.create({
    data: {
      tenantId: input.tenantId,
      policyId: match.rule.id,
      entityType: input.entityType,
      entityId: input.entityId,
      requestedById: input.requestedById,
      // The facts as they stood. Both the rule and the document can change afterwards, and
      // without this the request cannot be explained once either does.
      triggeredBy: {
        ruleNameAr: match.rule.nameAr,
        matched: match.matched,
        facts: input.facts,
      },
    },
    select: { id: true },
  });

  logger.info('Approval gate held a document', {
    entityType: input.entityType,
    entityId: input.entityId,
    rule: match.rule.nameAr,
    requestId: request.id,
  });

  return ok({
    held: true,
    requestId: request.id,
    ruleNameAr: match.rule.nameAr,
    totalSteps: policy._count.steps,
  });
}

/** Roles, for the builder's approver picker. */
export async function listRoles(
  tenantId: string,
): Promise<{ id: string; nameAr: string; name: string }[]> {
  return withTenantRead(async (tx) =>
    tx.role.findMany({
      where: { tenantId },
      select: { id: true, nameAr: true, name: true },
      orderBy: { name: 'asc' },
    }),
  );
}
