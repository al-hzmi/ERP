import { AssemblyBoard } from '@/components/inventory/assembly-board';
import { withPageScope } from '@/lib/api/page';
import { listAssemblyOrders } from '@/lib/application/services/commercial-setup-service';
import { prisma } from '@/lib/infrastructure/db/prisma';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'أوامر التجميع' };

export default async function Page(): Promise<JSX.Element> {
  const { orders, warehouses, canEdit } = await withPageScope(async (context) => ({
    orders: await listAssemblyOrders({ tenantId: context.tenantId }),
    warehouses: await prisma.warehouse.findMany({
      where: { tenantId: context.tenantId, isActive: true },
      select: { id: true, code: true, nameAr: true },
      orderBy: { code: 'asc' },
    }),
    canEdit: context.permissions.can('inventory.adjustment', 'create'),
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">أوامر التجميع</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          تعليمات تجميع صنف من مكوّناته — تسجيل ومتابعة
        </p>
      </header>

      <AssemblyBoard orders={orders} warehouses={warehouses} canEdit={canEdit} />
    </div>
  );
}
