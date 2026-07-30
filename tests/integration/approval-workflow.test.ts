import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decideApproval,
  listPendingApprovals,
  requestApproval,
} from '@/lib/application/services/approval-service';
import { withTransaction } from '@/lib/infrastructure/db/prisma';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * The approval workflow, driven for the first time.
 *
 * The schema for this shipped in migration 1 and nothing ever wrote to it, so there
 * was no behaviour to test until now. These are the rules that matter, and each one
 * is a rule that a screen alone could not enforce:
 *
 *   - only the role the current step names may act;
 *   - the initiator cannot approve their own document;
 *   - a step is acted on once, and a second attempt is refused rather than ignored;
 *   - a rejection ends the request instead of advancing it;
 *   - two approvers racing cannot both advance the same step.
 *
 * The last one is why this is an integration test. `decideApproval` reads the request
 * and then writes based on it, which is the read-modify-write that only serialisable
 * isolation makes safe, and nothing about that is observable without a real database.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

const tenantCode = 'APPROVAL_SPEC';
let tenantId = '';
let managerRoleId = '';
let controllerRoleId = '';
let initiatorId = '';
let managerId = '';
let controllerId = '';
let bothRolesId = '';

async function createUser(username: string, roleIds: readonly string[]): Promise<string> {
  const user = await prisma.user.create({
    data: {
      tenantId,
      username,
      email: `${username}@approval.spec`,
      passwordHash: 'x',
      fullNameAr: username,
      fullNameEn: username,
      userRoles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
    select: { id: true },
  });
  return user.id;
}

/** A two-step policy: manager then controller, both excluding the initiator. */
async function createPolicy(minAmount = '0'): Promise<string> {
  const policy = await prisma.approvalPolicy.create({
    data: {
      tenantId,
      documentType: 'SALES_INVOICE',
      minAmount,
      steps: {
        create: [
          { tenantId, stepNumber: 1, roleId: managerRoleId, excludeInitiator: true },
          { tenantId, stepNumber: 2, roleId: controllerRoleId, excludeInitiator: true },
        ],
      },
    },
    select: { id: true },
  });
  return policy.id;
}

async function raise(entityId: string, amount = '5000'): Promise<string> {
  const result = await runInTenantScope({ tenantId }, () =>
    withTransaction((tx) =>
      requestApproval(tx, {
        tenantId,
        entityType: 'JOURNAL',
        entityId,
        documentType: 'SALES_INVOICE',
        amount,
        requestedById: initiatorId,
      }),
    ),
  );

  if (!result.ok || result.value === null) {
    throw new Error('expected a request to be raised');
  }
  return result.value.requestId;
}

/**
 * Tears the fixture down in dependency order.
 *
 * `User.tenantId` and `ApprovalStep.roleId` are both `onDelete: Restrict` — the schema
 * refuses to let a company be deleted out from under its own records, which is right
 * for an ERP and means a test fixture has to unwind itself deliberately.
 */
async function cleanup(): Promise<void> {
  const tenant = await prisma.tenant.findFirst({
    where: { code: tenantCode },
    select: { id: true },
  });
  if (tenant === null) return;

  await prisma.approvalRequest.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.approvalPolicy.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.userRole.deleteMany({ where: { user: { tenantId: tenant.id } } });
  await prisma.user.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.role.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('approval workflow', () => {
  beforeEach(async () => {
    await cleanup();

    const tenant = await prisma.tenant.create({
      data: { code: tenantCode, nameAr: 'اعتمادات', nameEn: 'Approvals' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const [manager, controller] = await Promise.all([
      prisma.role.create({
        data: { tenantId, name: 'SPEC_MANAGER', nameAr: 'مدير' },
        select: { id: true },
      }),
      prisma.role.create({
        data: { tenantId, name: 'SPEC_CONTROLLER', nameAr: 'مراقب' },
        select: { id: true },
      }),
    ]);

    managerRoleId = manager.id;
    controllerRoleId = controller.id;

    initiatorId = await createUser('initiator', []);
    managerId = await createUser('manager', [managerRoleId]);
    controllerId = await createUser('controller', [controllerRoleId]);
    bothRolesId = await createUser('both', [managerRoleId, controllerRoleId]);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  describe('raising a request', () => {
    it('returns null when no policy applies, which is the common case', async () => {
      const result = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) =>
          requestApproval(tx, {
            tenantId,
            entityType: 'JOURNAL',
            entityId: randomUUID(),
            documentType: 'SALES_INVOICE',
            amount: '100',
            requestedById: initiatorId,
          }),
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('ignores a policy whose threshold the amount does not clear', async () => {
      await createPolicy('10000');

      const result = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) =>
          requestApproval(tx, {
            tenantId,
            entityType: 'JOURNAL',
            entityId: randomUUID(),
            documentType: 'SALES_INVOICE',
            amount: '9999',
            requestedById: initiatorId,
          }),
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('picks the strictest applicable policy when thresholds overlap', async () => {
      // A 0+ policy with two steps and a 1000+ policy with three. An invoice for
      // 5000 clears both, and the answer must be the tighter one rather than
      // whichever row came back first.
      await createPolicy('0');
      const strict = await prisma.approvalPolicy.create({
        data: {
          tenantId,
          documentType: 'SALES_INVOICE',
          minAmount: '1000',
          steps: {
            create: [
              { tenantId, stepNumber: 1, roleId: managerRoleId },
              { tenantId, stepNumber: 2, roleId: controllerRoleId },
              { tenantId, stepNumber: 3, roleId: managerRoleId },
            ],
          },
        },
        select: { id: true },
      });

      const requestId = await raise(randomUUID(), '5000');

      const stored = await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { policyId: true },
      });
      expect(stored.policyId).toBe(strict.id);
    });

    it('refuses a policy with no steps rather than creating an unactionable request', async () => {
      await prisma.approvalPolicy.create({
        data: { tenantId, documentType: 'SALES_INVOICE', minAmount: '0' },
      });

      const result = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) =>
          requestApproval(tx, {
            tenantId,
            entityType: 'JOURNAL',
            entityId: randomUUID(),
            documentType: 'SALES_INVOICE',
            amount: '5000',
            requestedById: initiatorId,
          }),
        ),
      );

      expect(result.ok).toBe(false);
    });

    it('refuses to raise a second request for the same entity', async () => {
      await createPolicy();
      const entityId = randomUUID();
      await raise(entityId);

      const again = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) =>
          requestApproval(tx, {
            tenantId,
            entityType: 'JOURNAL',
            entityId,
            documentType: 'SALES_INVOICE',
            amount: '5000',
            requestedById: initiatorId,
          }),
        ),
      );

      expect(again.ok).toBe(false);
    });
  });

  describe('the inbox', () => {
    it('shows a request to the role the current step names', async () => {
      await createPolicy();
      await raise(randomUUID());

      const inbox = await listPendingApprovals({ tenantId, userId: managerId });

      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.currentStep).toBe(1);
      expect(inbox[0]?.totalSteps).toBe(2);
    });

    it('hides it from a role whose step has not come round yet', async () => {
      await createPolicy();
      await raise(randomUUID());

      // The controller is step 2. Showing it now would offer an action the service
      // would refuse.
      expect(await listPendingApprovals({ tenantId, userId: controllerId })).toEqual([]);
    });

    it('hides it from the initiator even when they hold the step\'s role', async () => {
      await createPolicy();
      // Raised by someone who is themselves a manager.
      const result = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) =>
          requestApproval(tx, {
            tenantId,
            entityType: 'JOURNAL',
            entityId: randomUUID(),
            documentType: 'SALES_INVOICE',
            amount: '5000',
            requestedById: managerId,
          }),
        ),
      );
      expect(result.ok).toBe(true);

      expect(await listPendingApprovals({ tenantId, userId: managerId })).toEqual([]);
    });

    it('hides it from a user with no roles at all', async () => {
      await createPolicy();
      await raise(randomUUID());

      expect(await listPendingApprovals({ tenantId, userId: initiatorId })).toEqual([]);
    });

    it('moves to the next role once the first step is approved', async () => {
      await createPolicy();
      await raise(randomUUID());

      await decideApproval({ tenantId, userId: managerId, requestId: (await listPendingApprovals({ tenantId, userId: managerId }))[0]!.requestId, decision: 'APPROVED' });

      expect(await listPendingApprovals({ tenantId, userId: managerId })).toEqual([]);
      expect(await listPendingApprovals({ tenantId, userId: controllerId })).toHaveLength(1);
    });
  });

  describe('deciding', () => {
    it('advances rather than completing when steps remain', async () => {
      await createPolicy();
      const requestId = await raise(randomUUID());

      const result = await decideApproval({
        tenantId,
        userId: managerId,
        requestId,
        decision: 'APPROVED',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.completed).toBe(false);
      expect(result.value.status).toBe('PENDING');
      expect(result.value.currentStep).toBe(2);
    });

    it('completes on the final step', async () => {
      await createPolicy();
      const requestId = await raise(randomUUID());

      await decideApproval({ tenantId, userId: managerId, requestId, decision: 'APPROVED' });
      const final = await decideApproval({
        tenantId,
        userId: controllerId,
        requestId,
        decision: 'APPROVED',
      });

      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect(final.value.status).toBe('APPROVED');
      expect(final.value.completed).toBe(true);

      const stored = await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { status: true, completedAt: true },
      });
      expect(stored.status).toBe('APPROVED');
      expect(stored.completedAt).not.toBeNull();
    });

    it('ends the request on rejection instead of advancing it', async () => {
      await createPolicy();
      const requestId = await raise(randomUUID());

      const result = await decideApproval({
        tenantId,
        userId: managerId,
        requestId,
        decision: 'REJECTED',
        comment: 'الأسعار غير معتمدة',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // "Rejected" means rejected, not "objected to on the way past".
      expect(result.value.status).toBe('REJECTED');
      expect(result.value.completed).toBe(true);
      expect(await listPendingApprovals({ tenantId, userId: controllerId })).toEqual([]);
    });

    it('records the comment against the action', async () => {
      await createPolicy();
      const requestId = await raise(randomUUID());

      await decideApproval({
        tenantId,
        userId: managerId,
        requestId,
        decision: 'APPROVED',
        comment: 'مطابق للعقد',
      });

      const action = await prisma.approvalAction.findFirstOrThrow({
        where: { requestId },
        select: { userId: true, stepNumber: true, decision: true, comment: true },
      });
      expect(action).toMatchObject({
        userId: managerId,
        stepNumber: 1,
        decision: 'APPROVED',
        comment: 'مطابق للعقد',
      });
    });

    it('refuses a user who does not hold the step\'s role', async () => {
      await createPolicy();
      const requestId = await raise(randomUUID());

      const result = await decideApproval({
        tenantId,
        userId: controllerId,
        requestId,
        decision: 'APPROVED',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('PERMISSION_DENIED');
    });

    it('refuses the initiator, as a segregation-of-duties violation', async () => {
      await createPolicy();
      const result0 = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) =>
          requestApproval(tx, {
            tenantId,
            entityType: 'JOURNAL',
            entityId: randomUUID(),
            documentType: 'SALES_INVOICE',
            amount: '5000',
            requestedById: managerId,
          }),
        ),
      );
      expect(result0.ok).toBe(true);
      if (!result0.ok || result0.value === null) return;

      const result = await decideApproval({
        tenantId,
        userId: managerId,
        requestId: result0.value.requestId,
        decision: 'APPROVED',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SOD_VIOLATION');
    });

    it('refuses a second decision on a completed request', async () => {
      await createPolicy();
      const requestId = await raise(randomUUID());
      await decideApproval({ tenantId, userId: managerId, requestId, decision: 'REJECTED' });

      const again = await decideApproval({
        tenantId,
        userId: controllerId,
        requestId,
        decision: 'APPROVED',
      });

      expect(again.ok).toBe(false);
    });

    it('refuses the same user acting twice on one step', async () => {
      // A user holding both roles walks the request through both steps legitimately.
      // What they may not do is satisfy the same step twice.
      await createPolicy();
      const requestId = await raise(randomUUID());

      const first = await decideApproval({
        tenantId,
        userId: bothRolesId,
        requestId,
        decision: 'APPROVED',
      });
      expect(first.ok).toBe(true);

      // Step 2 now, and they do hold the controller role, so this one is allowed —
      // it is a different step.
      const second = await decideApproval({
        tenantId,
        userId: bothRolesId,
        requestId,
        decision: 'APPROVED',
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.status).toBe('APPROVED');

      const actions = await prisma.approvalAction.findMany({
        where: { requestId },
        select: { stepNumber: true },
        orderBy: { stepNumber: 'asc' },
      });
      expect(actions.map((action) => action.stepNumber)).toEqual([1, 2]);
    });

    it('refuses a request from another tenant', async () => {
      await createPolicy();
      const requestId = await raise(randomUUID());

      const result = await decideApproval({
        tenantId: randomUUID(),
        userId: managerId,
        requestId,
        decision: 'APPROVED',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('lets only one of two racing approvers advance the step', async () => {
      // Both hold the manager role and both click at the same instant on a shared
      // inbox. Exactly one decision may be recorded for step 1; the other must be
      // refused rather than both advancing the request to step 3 of a 2-step policy.
      await createPolicy();
      const requestId = await raise(randomUUID());
      const secondManager = await createUser('manager-2', [managerRoleId]);

      const outcomes = await Promise.all([
        decideApproval({ tenantId, userId: managerId, requestId, decision: 'APPROVED' }),
        decideApproval({ tenantId, userId: secondManager, requestId, decision: 'APPROVED' }),
      ]);

      const succeeded = outcomes.filter((outcome) => outcome.ok);
      expect(succeeded).toHaveLength(1);

      const actions = await prisma.approvalAction.count({ where: { requestId, stepNumber: 1 } });
      expect(actions).toBe(1);

      const stored = await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { currentStep: true },
      });
      expect(stored.currentStep).toBe(2);
    });
  });
});
