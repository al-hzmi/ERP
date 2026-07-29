import { apiHandler } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { getDashboardMetrics } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';

export const GET = apiHandler(
  async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    const metrics = await getDashboardMetrics(context.tenantId, tenant.functionalCurrency);
    return ok(metrics);
  },
  { permission: { resource: 'finance.report', action: 'read' } },
);
