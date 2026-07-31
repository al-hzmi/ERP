import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovalRule,
  listApprovalRules,
  setApprovalRuleActive,
} from '@/lib/application/services/approval-rules-service';
import {
  createTradeDocument,
  setTradeDocumentStatus,
} from '@/lib/application/services/trade-document-service';
import { decideApproval, listPendingApprovals } from '@/lib/application/services/approval-service';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * The approval gate, end to end against a real database.
 *
 * The property the whole feature rests on is that a held document **cannot proceed**. So the
 * tests that matter are the ones that try to get past the hold: confirming again, approving
 * with the wrong role, approving as the person who raised it, and approving a document
 * somebody cancelled while it sat in the inbox.
 *
 * The happy path is here too, but it is the least interesting case — a rule that fires and a
 * document that ends up CONFIRMED is what the register would show anyway.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let clerkId = '';
let managerId = '';
let managerRoleId = '';
let directorRoleId = '';
let branchId = '';
let customerId = '';
let productId = '';

function audit(userId: string) {
  return {
    tenantId,
    userId,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    correlationId: randomUUID(),
  };
}

/** A sales order whose total is `quantity × unitPrice` plus 15% tax. */
async function order(input: {
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
}): Promise<string> {
  const created = await runInTenantScope({ tenantId }, () =>
    createTradeDocument({
      tenantId,
      userId: clerkId,
      audit: audit(clerkId),
      type: 'SALES_ORDER',
      counterpartyId: customerId,
      branchId,
      documentDate: '2027-05-01',
      lines: [
        {
          productId,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          taxRate: '15',
          ...(input.discountPercent !== undefined
            ? { discountPercent: input.discountPercent }
            : {}),
        },
      ],
    }),
  );

  if (!created.ok) throw new Error(created.error.messageEn);
  return created.value.id;
}

async function confirm(documentId: string, userId = clerkId) {
  return runInTenantScope({ tenantId }, () =>
    setTradeDocumentStatus({
      tenantId,
      userId,
      audit: audit(userId),
      id: documentId,
      status: 'CONFIRMED',
    }),
  );
}

async function makeRule(input: {
  nameAr: string;
  conditions: { field: string; operator: string; value: string }[];
  roleIds?: string[];
  priority?: number;
}) {
  return runInTenantScope({ tenantId }, () =>
    createApprovalRule({
      tenantId,
      audit: audit(managerId),
      nameAr: input.nameAr,
      nameEn: input.nameAr,
      documentType: 'SALES_ORDER',
      priority: input.priority ?? 100,
      conditions: input.conditions as never,
      approverRoleIds: input.roleIds ?? [managerRoleId],
      excludeInitiator: true,
    }),
  );
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('the approval gate', () => {
  beforeEach(async () => {
    const code = `GATE_${randomUUID().slice(0, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'بوابة', nameEn: 'Gate' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const [manager, director] = await Promise.all([
      prisma.role.create({
        data: { tenantId, name: 'MANAGER', nameAr: 'مدير' },
        select: { id: true },
      }),
      prisma.role.create({
        data: { tenantId, name: 'DIRECTOR', nameAr: 'مدير عام' },
        select: { id: true },
      }),
    ]);
    managerRoleId = manager.id;
    directorRoleId = director.id;

    const clerk = await prisma.user.create({
      data: {
        tenantId,
        username: 'clerk',
        email: `clerk@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'موظف',
        fullNameEn: 'Clerk',
      },
      select: { id: true },
    });
    clerkId = clerk.id;

    const boss = await prisma.user.create({
      data: {
        tenantId,
        username: 'manager',
        email: `manager@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'المدير',
        fullNameEn: 'Manager',
        userRoles: { create: [{ roleId: managerRoleId }] },
      },
      select: { id: true },
    });
    managerId = boss.id;

    const branch = await prisma.branch.create({
      data: { tenantId, code: 'BR1', nameAr: 'الفرع', nameEn: 'Branch' },
      select: { id: true },
    });
    branchId = branch.id;

    const [category, uom] = await Promise.all([
      prisma.category.create({
        data: { tenantId, code: 'C1', nameAr: 'تصنيف', nameEn: 'Category' },
        select: { id: true },
      }),
      prisma.unitOfMeasure.create({
        data: { tenantId, code: 'EA', nameAr: 'حبة', nameEn: 'Each' },
        select: { id: true },
      }),
    ]);

    const product = await prisma.product.create({
      data: {
        tenantId,
        sku: 'SKU-1',
        nameAr: 'صنف',
        nameEn: 'Product',
        categoryId: category.id,
        unitOfMeasureId: uom.id,
        salePrice: '100.0000',
        costPrice: '60.0000',
      },
      select: { id: true },
    });
    productId = product.id;

    const customer = await prisma.counterparty.create({
      data: { tenantId, code: 'CU1', type: 'CUSTOMER', nameAr: 'عميل', nameEn: 'Customer' },
      select: { id: true },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('confirms straight through when no rule matches', async () => {
    await makeRule({
      nameAr: 'الكبيرة',
      conditions: [{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '50000' }],
    });

    // 10 × 100 + 15% = 1,150. Well under the threshold.
    const result = await confirm(await order({ quantity: '10', unitPrice: '100' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('CONFIRMED');
    expect(result.value.held).toBeNull();
    expect(await prisma.approvalRequest.count({ where: { tenantId } })).toBe(0);
  });

  it('holds the document and raises a request when a rule matches', async () => {
    await makeRule({
      nameAr: 'أوامر البيع الكبيرة',
      conditions: [{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '50000' }],
    });

    // 1000 × 100 + 15% = 115,000.
    const documentId = await order({ quantity: '1000', unitPrice: '100' });
    const result = await confirm(documentId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('PENDING_APPROVAL');
    expect(result.value.held?.ruleNameAr).toBe('أوامر البيع الكبيرة');

    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { tenantId, entityId: documentId },
      select: { status: true, entityType: true, triggeredBy: true },
    });
    expect(request.status).toBe('PENDING');
    expect(request.entityType).toBe('TRADE_DOCUMENT');

    // The evidence is frozen on the request, so the hold stays explicable after the rule or
    // the document changes.
    const evidence = request.triggeredBy as { matched: { actual: string }[] };
    expect(evidence.matched[0]?.actual).toBe('115000');
  });

  it('refuses to confirm a held document again', async () => {
    // The property the feature exists for: a user cannot confirm their way past a hold.
    await makeRule({
      nameAr: 'الكل',
      conditions: [],
    });

    const documentId = await order({ quantity: '1', unitPrice: '100' });
    await confirm(documentId);

    const again = await confirm(documentId);
    expect(again.ok).toBe(false);

    const document = await prisma.tradeDocument.findFirstOrThrow({
      where: { id: documentId },
      select: { status: true },
    });
    expect(document.status).toBe('PENDING_APPROVAL');
  });

  it('freezes the lines of a held document', async () => {
    // Migration 011's trigger freezes anything that is not DRAFT. A document under review is
    // precisely one whose terms must not move under the reviewer.
    await makeRule({ nameAr: 'الكل', conditions: [] });

    const documentId = await order({ quantity: '1', unitPrice: '100' });
    await confirm(documentId);

    const line = await prisma.tradeDocumentLine.findFirstOrThrow({
      where: { documentId },
      select: { id: true },
    });

    await expect(
      prisma.tradeDocumentLine.update({ where: { id: line.id }, data: { unitPrice: '1' } }),
    ).rejects.toThrow();
  });

  it('releases the document to CONFIRMED when the last approver signs', async () => {
    await makeRule({ nameAr: 'الكل', conditions: [] });

    const documentId = await order({ quantity: '1', unitPrice: '100' });
    await confirm(documentId);

    const pending = await runInTenantScope({ tenantId }, () =>
      listPendingApprovals({ tenantId, userId: managerId }),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ruleNameAr).toBe('الكل');

    const decided = await runInTenantScope({ tenantId }, () =>
      decideApproval({
        tenantId,
        userId: managerId,
        requestId: pending[0]?.requestId ?? '',
        decision: 'APPROVED',
      }),
    );

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.value.completed).toBe(true);

    const document = await prisma.tradeDocument.findFirstOrThrow({
      where: { id: documentId },
      select: { status: true },
    });
    expect(document.status).toBe('CONFIRMED');
  });

  it('returns a rejected document to DRAFT so it can be revised', async () => {
    // Not CANCELLED: "no" from a reviewer usually means "not like this", and DRAFT is where
    // the lines unfreeze.
    await makeRule({ nameAr: 'الكل', conditions: [] });

    const documentId = await order({ quantity: '1', unitPrice: '100' });
    await confirm(documentId);

    const pending = await runInTenantScope({ tenantId }, () =>
      listPendingApprovals({ tenantId, userId: managerId }),
    );

    await runInTenantScope({ tenantId }, () =>
      decideApproval({
        tenantId,
        userId: managerId,
        requestId: pending[0]?.requestId ?? '',
        decision: 'REJECTED',
        comment: 'الخصم مرتفع',
      }),
    );

    const document = await prisma.tradeDocument.findFirstOrThrow({
      where: { id: documentId },
      select: { status: true },
    });
    expect(document.status).toBe('DRAFT');

    // And the lines are editable again.
    const line = await prisma.tradeDocumentLine.findFirstOrThrow({
      where: { documentId },
      select: { id: true },
    });
    await expect(
      prisma.tradeDocumentLine.update({ where: { id: line.id }, data: { unitPrice: '90' } }),
    ).resolves.toBeTruthy();
  });

  it('does not let the initiator approve their own document', async () => {
    // Segregation of duties, which the existing engine already enforced — this asserts the
    // gate did not route around it.
    await makeRule({ nameAr: 'الكل', conditions: [] });

    // The clerk holds no role, so give them the approver role and have them raise it.
    await prisma.userRole.create({ data: { userId: clerkId, roleId: managerRoleId } });

    const documentId = await order({ quantity: '1', unitPrice: '100' });
    await confirm(documentId, clerkId);

    const ownInbox = await runInTenantScope({ tenantId }, () =>
      listPendingApprovals({ tenantId, userId: clerkId }),
    );

    expect(ownInbox).toHaveLength(0);
    expect(await prisma.approvalRequest.count({ where: { tenantId, entityId: documentId } })).toBe(1);
  });

  it('walks a two-step chain in order', async () => {
    await makeRule({
      nameAr: 'خطوتان',
      conditions: [],
      roleIds: [managerRoleId, directorRoleId],
    });

    const boss = await prisma.user.create({
      data: {
        tenantId,
        username: 'director',
        email: `director@${tenantId.slice(0, 8)}.spec`,
        passwordHash: 'x',
        fullNameAr: 'المدير العام',
        fullNameEn: 'Director',
        userRoles: { create: [{ roleId: directorRoleId }] },
      },
      select: { id: true },
    });

    const documentId = await order({ quantity: '1', unitPrice: '100' });
    await confirm(documentId);

    // The director cannot act first — step one names the manager.
    expect(
      await runInTenantScope({ tenantId }, () =>
        listPendingApprovals({ tenantId, userId: boss.id }),
      ),
    ).toHaveLength(0);

    const first = await runInTenantScope({ tenantId }, () =>
      listPendingApprovals({ tenantId, userId: managerId }),
    );
    await runInTenantScope({ tenantId }, () =>
      decideApproval({
        tenantId,
        userId: managerId,
        requestId: first[0]?.requestId ?? '',
        decision: 'APPROVED',
      }),
    );

    // Still held after step one.
    expect(
      (
        await prisma.tradeDocument.findFirstOrThrow({
          where: { id: documentId },
          select: { status: true },
        })
      ).status,
    ).toBe('PENDING_APPROVAL');

    const second = await runInTenantScope({ tenantId }, () =>
      listPendingApprovals({ tenantId, userId: boss.id }),
    );
    expect(second).toHaveLength(1);

    await runInTenantScope({ tenantId }, () =>
      decideApproval({
        tenantId,
        userId: boss.id,
        requestId: second[0]?.requestId ?? '',
        decision: 'APPROVED',
      }),
    );

    expect(
      (
        await prisma.tradeDocument.findFirstOrThrow({
          where: { id: documentId },
          select: { status: true },
        })
      ).status,
    ).toBe('CONFIRMED');
  });

  it('does not resurrect a document cancelled while it sat in the inbox', async () => {
    await makeRule({ nameAr: 'الكل', conditions: [] });

    const documentId = await order({ quantity: '1', unitPrice: '100' });
    await confirm(documentId);

    await runInTenantScope({ tenantId }, () =>
      setTradeDocumentStatus({
        tenantId,
        userId: clerkId,
        audit: audit(clerkId),
        id: documentId,
        status: 'CANCELLED',
      }),
    );

    const pending = await runInTenantScope({ tenantId }, () =>
      listPendingApprovals({ tenantId, userId: managerId }),
    );

    await runInTenantScope({ tenantId }, () =>
      decideApproval({
        tenantId,
        userId: managerId,
        requestId: pending[0]?.requestId ?? '',
        decision: 'APPROVED',
      }),
    );

    // The release is conditional on the document still being held. Approving must not undo a
    // cancellation.
    expect(
      (
        await prisma.tradeDocument.findFirstOrThrow({
          where: { id: documentId },
          select: { status: true },
        })
      ).status,
    ).toBe('CANCELLED');
  });

  it('applies the lowest-priority rule when two match', async () => {
    await makeRule({
      nameAr: 'العامة',
      conditions: [{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '100' }],
      priority: 50,
    });
    await makeRule({
      nameAr: 'الصارمة',
      conditions: [{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '1000' }],
      priority: 10,
      roleIds: [directorRoleId],
    });

    const result = await confirm(await order({ quantity: '100', unitPrice: '100' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.held?.ruleNameAr).toBe('الصارمة');
  });

  it('ignores a deactivated rule', async () => {
    const created = await makeRule({ nameAr: 'موقوفة', conditions: [] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await runInTenantScope({ tenantId }, () =>
      setApprovalRuleActive({
        tenantId,
        audit: audit(managerId),
        id: created.value.id,
        isActive: false,
      }),
    );

    const result = await confirm(await order({ quantity: '1', unitPrice: '100' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('CONFIRMED');
  });

  it('refuses a rule with no approvers at write time', async () => {
    // It would raise a request nobody can action and hold every matching document forever.
    const refused = await runInTenantScope({ tenantId }, () =>
      createApprovalRule({
        tenantId,
        audit: audit(managerId),
        nameAr: 'بلا معتمِدين',
        nameEn: 'No approvers',
        documentType: 'SALES_ORDER',
        priority: 100,
        conditions: [],
        approverRoleIds: [],
        excludeInitiator: true,
      }),
    );

    expect(refused.ok).toBe(false);
  });

  it('refuses a duplicate rule name', async () => {
    await makeRule({ nameAr: 'مكررة', conditions: [] });
    const again = await makeRule({ nameAr: 'مكررة', conditions: [] });
    expect(again.ok).toBe(false);
  });

  it('lists rules with their conditions rendered as sentences', async () => {
    await makeRule({
      nameAr: 'خصم مرتفع',
      conditions: [
        { field: 'TOTAL_AMOUNT', operator: 'GT', value: '50000' },
        { field: 'MAX_LINE_DISCOUNT_PERCENT', operator: 'GT', value: '15' },
      ],
    });

    const rules = await runInTenantScope({ tenantId }, () => listApprovalRules(tenantId));
    const rule = rules.find((candidate) => candidate.nameAr === 'خصم مرتفع');

    expect(rule?.conditions).toHaveLength(2);
    expect(rule?.conditions.map((condition) => condition.describedAr)).toContain(
      'أعلى نسبة خصم في سطر أكبر من 15%',
    );
    expect(rule?.steps).toHaveLength(1);
  });

  it('fires on a discount rule that an amount rule would miss', async () => {
    // The second example from the brief: a small order given away at a large discount.
    await makeRule({
      nameAr: 'خصم فوق ١٥٪',
      conditions: [{ field: 'MAX_LINE_DISCOUNT_PERCENT', operator: 'GT', value: '15' }],
    });

    const cheap = await confirm(await order({ quantity: '1', unitPrice: '100', discountPercent: '5' }));
    expect(cheap.ok && cheap.value.status).toBe('CONFIRMED');

    const discounted = await confirm(
      await order({ quantity: '1', unitPrice: '100', discountPercent: '25' }),
    );
    expect(discounted.ok && discounted.value.status).toBe('PENDING_APPROVAL');
  });
});
