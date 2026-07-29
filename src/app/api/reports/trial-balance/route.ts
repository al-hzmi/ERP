import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err, ok } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { getTrialBalance } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';

export const GET = apiHandler(
  async (context, request) => {
    const url = new URL(request.url);
    const from = DateOnly.create(url.searchParams.get('from') ?? `${new Date().getUTCFullYear()}-01-01`);
    const to = DateOnly.create(url.searchParams.get('to') ?? DateOnly.today().toString());

    if (!from.ok) return from;
    if (!to.ok) return to;

    if (from.value.isAfter(to.value)) {
      return err(
        DomainErrors.validation(
          'تاريخ البداية يجب أن يسبق تاريخ النهاية.',
          'The start date must be on or before the end date.',
          'from',
        ),
      );
    }

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    const branchId = url.searchParams.get('branchId') ?? undefined;

    const report = await getTrialBalance({
      tenantId: context.tenantId,
      fromDate: from.value.toDate(),
      toDate: to.value.toDate(),
      currency: tenant.functionalCurrency,
      ...(branchId !== undefined ? { branchId } : {}),
    });

    return ok({ from: from.value.toString(), to: to.value.toString(), ...report });
  },
  { permission: { resource: 'finance.report', action: 'read' } },
);
