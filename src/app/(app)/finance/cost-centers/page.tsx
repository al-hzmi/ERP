import { ReferenceTable } from '@/components/master-data/reference-table';
import { withPageScope } from '@/lib/api/page';
import { MASTER_DATA, listMasterData } from '@/lib/application/services/master-data-service';

export const dynamic = 'force-dynamic';

const KIND = 'costCenter' as const;
const BASE_PATH = '/finance/cost-centers';

export const metadata = { title: MASTER_DATA[KIND].titleAr };

/**
 * A reference table.
 *
 * Thin: the query lives in `master-data-service` and the table in `ReferenceTable`, because
 * four models of the same shape should not be four implementations of the same screen.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { inactive?: string };
}): Promise<JSX.Element> {
  const includeInactive = searchParams.inactive === 'true';
  const definition = MASTER_DATA[KIND];

  const { rows, canEdit } = await withPageScope(async (context) => ({
    rows: await listMasterData({ tenantId: context.tenantId, kind: KIND, includeInactive }),
    canEdit: context.permissions.can(definition.resource, 'create'),
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{definition.titleAr}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{definition.descriptionAr}</p>
      </header>

      <ReferenceTable
        kind={KIND}
        definition={definition}
        rows={rows}
        canEdit={canEdit}
        includeInactive={includeInactive}
        basePath={BASE_PATH}
      />
    </div>
  );
}
