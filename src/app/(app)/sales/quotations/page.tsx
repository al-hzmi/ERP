import { TradeDocumentBoard } from '@/components/commercial/trade-document-board';
import { withPageScope } from '@/lib/api/page';
import {
  TRADE_DOCUMENTS,
  listTradeDocuments,
} from '@/lib/application/services/trade-document-service';
import { prisma } from '@/lib/infrastructure/db/prisma';

export const dynamic = 'force-dynamic';

const TYPE = 'QUOTATION' as const;

export const metadata = { title: TRADE_DOCUMENTS[TYPE].titleAr };

export default async function Page(): Promise<JSX.Element> {
  const definition = TRADE_DOCUMENTS[TYPE];

  const { documents, branches, currency, canEdit } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    return {
      documents: await listTradeDocuments({ tenantId: context.tenantId, type: TYPE }),
      branches: await prisma.branch.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
      currency: tenant.functionalCurrency,
      canEdit: context.permissions.can(definition.resource, 'create'),
    };
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{definition.titleAr}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{definition.descriptionAr}</p>
      </header>

      <TradeDocumentBoard
        type={TYPE}
        definition={definition}
        documents={documents}
        branches={branches}
        currency={currency}
        canEdit={canEdit}
      />
    </div>
  );
}
