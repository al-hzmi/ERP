import type { ApprovalStatus } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { TransactionClient } from '@/lib/infrastructure/db/prisma';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';
import { logger } from '@/lib/infrastructure/logging/logger';

/**
 * Multi-step approval, driven.
 *
 * The schema for this has existed since migration 1 and nothing ever wrote to it —
 * `approval_policies`, `approval_steps`, `approval_requests` and `approval_actions`
 * described a workflow that never ran. This is the service that runs it.
 *
 * Three rules carry the weight, and all three are enforced here rather than in the
 * screen, because a control that lives in a form is a control that an HTTP client
 * skips:
 *
 *   1. **Only the role the current step names may act.** Approval is a role's
 *      authority, not a permission's — `finance.approve` says a user approves
 *      things, the step says *which* user approves *this* thing.
 *   2. **The initiator may not approve their own document** when the step says so.
 *      This is the segregation-of-duties rule that the rest of the system already
 *      enforces on post-after-create; it is the same principle one level up.
 *   3. **A step is acted on once.** Not "the second click is ignored" — the second
 *      click is refused, because silently accepting it makes an approval count
 *      twice in the audit trail.
 */

export interface PendingApproval {
  readonly requestId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly requestedAt: Date;
  readonly requestedByName: string;
  /** Whatever identifies the thing being approved to a human — a document number. */
  readonly reference: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly descriptionAr: string | null;
}

/**
 * Raises an approval request for an entity, if any policy demands one.
 *
 * Returns `null` when no policy applies, which is the common case and not a
 * failure: most documents in most companies are below every threshold.
 *
 * The policy chosen is the one with the highest `minAmount` the amount clears, so
 * overlapping thresholds resolve to the strictest applicable rather than to whichever
 * row the database returned first.
 */
export async function requestApproval(
  tx: TransactionClient,
  input: {
    tenantId: string;
    entityType: string;
    entityId: string;
    documentType: string;
    amount: string;
    requestedById: string;
  },
): Promise<Result<{ requestId: string; totalSteps: number } | null, DomainError>> {
  const policies = await tx.approvalPolicy.findMany({
    where: {
      tenantId: input.tenantId,
      documentType: input.documentType,
      isActive: true,
      minAmount: { lte: input.amount },
    },
    select: { id: true, minAmount: true, _count: { select: { steps: true } } },
    orderBy: { minAmount: 'desc' },
    take: 1,
  });

  const policy = policies[0];
  if (policy === undefined) return ok(null);

  if (policy._count.steps === 0) {
    // A policy with no steps would create a request nobody can ever action, which
    // would block the document forever. Treating it as "no approval needed" would
    // hide a misconfiguration; refusing names it.
    return err(
      DomainErrors.validation(
        'سياسة الاعتماد المطبَّقة لا تحتوي على أي خطوات.',
        'The applicable approval policy has no steps configured.',
      ),
    );
  }

  const existing = await tx.approvalRequest.findFirst({
    where: { tenantId: input.tenantId, entityType: input.entityType, entityId: input.entityId },
    select: { id: true, status: true },
  });

  if (existing !== null) {
    // The unique constraint on (tenant, entityType, entityId) means one request per
    // entity, ever. Re-raising is a caller bug worth naming rather than a duplicate
    // row worth swallowing.
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
      policyId: policy.id,
      entityType: input.entityType,
      entityId: input.entityId,
      requestedById: input.requestedById,
    },
    select: { id: true },
  });

  return ok({ requestId: request.id, totalSteps: policy._count.steps });
}

/**
 * The approvals waiting on this user, and only those.
 *
 * Filtering by the user's roles in the query rather than in the page is what makes
 * this an inbox instead of a list with a permission check painted over it: a request
 * the caller cannot action never reaches them.
 */
export async function listPendingApprovals(input: {
  tenantId: string;
  userId: string;
}): Promise<PendingApproval[]> {
  return withTenantRead(async (tx) => {
    const roles = await tx.userRole.findMany({
      where: { userId: input.userId },
      select: { roleId: true },
    });

    const roleIds = roles.map((role) => role.roleId);
    if (roleIds.length === 0) return [];

    const requests = await tx.approvalRequest.findMany({
      where: {
        tenantId: input.tenantId,
        status: 'PENDING',
        policy: {
          steps: {
            // The step matching this request's *current* position must name a role
            // the caller holds.
            some: { roleId: { in: roleIds } },
          },
        },
      },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        currentStep: true,
        createdAt: true,
        requestedById: true,
        policy: {
          select: {
            steps: {
              select: { stepNumber: true, roleId: true, excludeInitiator: true },
              orderBy: { stepNumber: 'asc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // `some` above narrows to requests whose policy mentions one of the caller's
    // roles *anywhere*. Which step is current is per row, so the precise match is
    // made here — over a page of rows, not over the table.
    const actionable = requests.filter((request) => {
      const step = request.policy.steps.find(
        (candidate) => candidate.stepNumber === request.currentStep,
      );
      if (step === undefined) return false;
      if (!roleIds.includes(step.roleId)) return false;
      if (step.excludeInitiator && request.requestedById === input.userId) return false;
      return true;
    });

    if (actionable.length === 0) return [];

    const requesters = await tx.user.findMany({
      where: { id: { in: [...new Set(actionable.map((request) => request.requestedById))] } },
      select: { id: true, fullNameAr: true },
    });
    const requesterById = new Map(requesters.map((user) => [user.id, user.fullNameAr]));

    // One query per entity *type*, not per row: an inbox of forty documents must
    // not be forty-one round trips.
    const documentIds = actionable
      .filter((request) => request.entityType === 'DOCUMENT')
      .map((request) => request.entityId);
    const journalIds = actionable
      .filter((request) => request.entityType === 'JOURNAL')
      .map((request) => request.entityId);

    const [documents, journals] = await Promise.all([
      documentIds.length > 0
        ? tx.document.findMany({
            where: { id: { in: documentIds } },
            select: { id: true, documentNumber: true, total: true, currency: true, notes: true },
          })
        : Promise.resolve([]),
      journalIds.length > 0
        ? tx.journal.findMany({
            where: { id: { in: journalIds } },
            select: {
              id: true,
              entryNumber: true,
              totalDebit: true,
              descriptionAr: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const documentById = new Map(documents.map((document) => [document.id, document]));
    const journalById = new Map(journals.map((journal) => [journal.id, journal]));

    return actionable.map((request) => {
      const document = documentById.get(request.entityId);
      const journal = journalById.get(request.entityId);

      return {
        requestId: request.id,
        entityType: request.entityType,
        entityId: request.entityId,
        currentStep: request.currentStep,
        totalSteps: request.policy.steps.length,
        requestedAt: request.createdAt,
        requestedByName: requesterById.get(request.requestedById) ?? 'غير معروف',
        reference: document?.documentNumber ?? journal?.entryNumber ?? null,
        amount: document?.total.toString() ?? journal?.totalDebit.toString() ?? null,
        currency: document?.currency ?? null,
        descriptionAr: journal?.descriptionAr ?? document?.notes ?? null,
      };
    });
  });
}

export interface ApprovalDecisionResult {
  readonly requestId: string;
  readonly status: ApprovalStatus;
  readonly currentStep: number;
  readonly totalSteps: number;
  /** True when this decision completed the request either way. */
  readonly completed: boolean;
}

/**
 * Records one approval decision.
 *
 * Runs at `SERIALIZABLE` through `withTransaction`, and re-reads the request inside
 * it. Two approvers clicking at the same instant is not hypothetical on a shared
 * inbox, and the read-then-write here is exactly the shape that weaker isolation
 * lets both of them complete — advancing the step twice and skipping an approver.
 */
export async function decideApproval(input: {
  tenantId: string;
  userId: string;
  requestId: string;
  decision: 'APPROVED' | 'REJECTED';
  comment?: string;
}): Promise<Result<ApprovalDecisionResult, DomainError>> {
  return withTransaction(async (tx) => {
    const request = await tx.approvalRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId },
      select: {
        id: true,
        status: true,
        currentStep: true,
        requestedById: true,
        entityType: true,
        entityId: true,
        policy: {
          select: {
            steps: {
              select: { stepNumber: true, roleId: true, excludeInitiator: true },
              orderBy: { stepNumber: 'asc' },
            },
          },
        },
      },
    });

    if (request === null) {
      return err(DomainErrors.notFound('طلب الاعتماد', 'Approval request', input.requestId));
    }

    if (request.status !== 'PENDING') {
      return err(
        DomainErrors.validation(
          'تم اتخاذ قرار في هذا الطلب بالفعل.',
          'This request has already been decided.',
        ),
      );
    }

    const step = request.policy.steps.find(
      (candidate) => candidate.stepNumber === request.currentStep,
    );

    if (step === undefined) {
      return err(
        DomainErrors.validation(
          'خطوة الاعتماد الحالية غير معرَّفة في السياسة.',
          'The current approval step is not defined in the policy.',
        ),
      );
    }

    const roles = await tx.userRole.findMany({
      where: { userId: input.userId },
      select: { roleId: true },
    });

    if (!roles.some((role) => role.roleId === step.roleId)) {
      return err(
        DomainErrors.permissionDenied(
          'اعتماد',
          'approve',
          'هذه الخطوة',
          'this approval step (it is assigned to a role you do not hold)',
        ),
      );
    }

    if (step.excludeInitiator && request.requestedById === input.userId) {
      return err(
        // The same segregation-of-duties error the post-after-create rule raises:
        // one level up, same principle, so it reads identically to the user.
        DomainErrors.sodViolation(
          'لا يمكن للمستخدم الذي أنشأ المستند أن يعتمده.',
          'the user who raised this document cannot approve it',
        ),
      );
    }

    const alreadyActed = await tx.approvalAction.findFirst({
      where: {
        requestId: request.id,
        stepNumber: request.currentStep,
        userId: input.userId,
      },
      select: { id: true },
    });

    if (alreadyActed !== null) {
      return err(
        DomainErrors.validation(
          'سجّلت قرارك في هذه الخطوة بالفعل.',
          'You have already recorded a decision on this step.',
        ),
      );
    }

    await tx.approvalAction.create({
      data: {
        requestId: request.id,
        stepNumber: request.currentStep,
        userId: input.userId,
        decision: input.decision,
        comment: input.comment ?? null,
      },
    });

    const totalSteps = request.policy.steps.length;

    // A rejection ends the request outright. Continuing to the next step after one
    // would make "rejected" mean "objected to", which is not what a reviewer who
    // rejects a document is saying.
    const isFinalStep = request.currentStep >= totalSteps;
    const status: ApprovalStatus =
      input.decision === 'REJECTED' ? 'REJECTED' : isFinalStep ? 'APPROVED' : 'PENDING';
    const completed = status !== 'PENDING';

    const updated = await tx.approvalRequest.update({
      where: { id: request.id },
      data: {
        status,
        currentStep: completed ? request.currentStep : request.currentStep + 1,
        completedAt: completed ? new Date() : null,
      },
      select: { status: true, currentStep: true },
    });

    logger.info('Approval decision recorded', {
      requestId: request.id,
      entityType: request.entityType,
      entityId: request.entityId,
      step: request.currentStep,
      decision: input.decision,
      status: updated.status,
    });

    return ok({
      requestId: request.id,
      status: updated.status,
      currentStep: updated.currentStep,
      totalSteps,
      completed,
    });
  });
}
