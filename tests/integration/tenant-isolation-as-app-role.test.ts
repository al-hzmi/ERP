import { PrismaClient, Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Tenant isolation as the role the application is meant to connect as.
 *
 * `tenant-isolation.test.ts` inspects the *shape* of the policies, because while
 * the application connects as the table owner the policies are inert and asserting
 * on rows would prove nothing: PostgreSQL exempts a table's owner from its own
 * policies unless RLS is FORCEd, and migration 004 deliberately does not force it
 * so that migrations and the seed generator can cross tenants.
 *
 * This file is the other half — the verification the migration's own footer asks an
 * operator to run by hand. It connects as a **non-owner** member of `erp_app` and
 * asserts on rows, which is the only way to demonstrate that the control bites.
 *
 * It needs a login role that is a member of `erp_app`, in `APP_DATABASE_URL`:
 *
 *   CREATE ROLE erp_web LOGIN PASSWORD '...';
 *   GRANT erp_app TO erp_web;
 *
 * Without it the file skips rather than passing vacuously — a green tick from a
 * suite that never connected as the restricted role would be worse than no test.
 */

const ownerUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
const canRun = ownerUrl !== undefined && ownerUrl !== '' && appUrl !== undefined && appUrl !== '';

const owner = new PrismaClient();
const app = new PrismaClient({ datasources: { db: { url: appUrl ?? ownerUrl ?? '' } } });

const TENANT_A = '33333333-3333-3333-3333-333333333333';
const TENANT_B = '44444444-4444-4444-4444-444444444444';

/** Runs `work` with a tenant bound, the way the client extension does. */
async function asTenant<T>(
  tenantId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('erp.tenant_id', ${tenantId}::text, true)`;
    return work(tx);
  });
}

describe.skipIf(!canRun)('tenant isolation under the erp_app role', () => {
  beforeAll(async () => {
    await owner.$executeRaw`DELETE FROM "users" WHERE "tenantId" IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await owner.$executeRaw`DELETE FROM "tenants" WHERE "id" IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;

    await owner.tenant.createMany({
      data: [
        { id: TENANT_A, code: 'ISO_A', nameAr: 'أ', nameEn: 'A' },
        { id: TENANT_B, code: 'ISO_B', nameAr: 'ب', nameEn: 'B' },
      ],
    });

    await owner.user.createMany({
      data: [
        {
          tenantId: TENANT_A,
          username: 'shared-name',
          email: 'a@iso.test',
          passwordHash: 'x',
          fullNameAr: 'أ',
          fullNameEn: 'A',
        },
        {
          tenantId: TENANT_B,
          username: 'shared-name',
          email: 'b@iso.test',
          passwordHash: 'x',
          fullNameAr: 'ب',
          fullNameEn: 'B',
        },
      ],
    });
  });

  afterAll(async () => {
    await owner.$executeRaw`DELETE FROM "users" WHERE "tenantId" IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await owner.$executeRaw`DELETE FROM "tenants" WHERE "id" IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('is not the table owner, or none of this proves anything', async () => {
    const rows = await app.$queryRaw<{ is_owner: boolean }[]>`
      SELECT pg_has_role(current_user, 'erp', 'MEMBER') AS is_owner
    `;

    expect(rows[0]?.is_owner).toBe(false);
  });

  it('is a member of erp_app, so the policies address it', async () => {
    const rows = await app.$queryRaw<{ is_app: boolean }[]>`
      SELECT pg_has_role(current_user, 'erp_app', 'MEMBER') AS is_app
    `;

    expect(rows[0]?.is_app).toBe(true);
  });

  it('sees no rows at all with nothing bound', async () => {
    // Fail-closed. This is what makes a forgotten scope an empty screen rather
    // than another company's ledger — and why the client extension warns about it.
    const count = await app.user.count();

    expect(count).toBe(0);
  });

  it('sees exactly one tenant\'s rows when bound to it', async () => {
    const [fromA, fromB] = await Promise.all([
      asTenant(TENANT_A, (tx) => tx.user.findMany({ where: { username: 'shared-name' } })),
      asTenant(TENANT_B, (tx) => tx.user.findMany({ where: { username: 'shared-name' } })),
    ]);

    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
    expect(fromA[0]?.tenantId).toBe(TENANT_A);
    expect(fromB[0]?.tenantId).toBe(TENANT_B);
    // The same username in both tenants, resolving to different users. This is why
    // sign-in has to know the tenant before it reads `users`: `username` is unique
    // per tenant, so an unscoped lookup returns whichever row came back first.
    expect(fromA[0]?.id).not.toBe(fromB[0]?.id);
  });

  it('cannot reach another tenant by asking for its id directly', async () => {
    const found = await asTenant(TENANT_A, (tx) =>
      tx.user.findMany({ where: { tenantId: TENANT_B } }),
    );

    expect(found).toEqual([]);
  });

  it('cannot count another tenant\'s rows', async () => {
    const count = await asTenant(TENANT_A, (tx) => tx.user.count({ where: { tenantId: TENANT_B } }));

    expect(count).toBe(0);
  });

  it('cannot write a row into another tenant', async () => {
    // `WITH CHECK` is the half of the policy that stops a scoped session from
    // *planting* a row somewhere it cannot read.
    await expect(
      asTenant(TENANT_A, (tx) =>
        tx.user.create({
          data: {
            tenantId: TENANT_B,
            username: 'smuggled',
            email: 'smuggled@iso.test',
            passwordHash: 'x',
            fullNameAr: 'س',
            fullNameEn: 'S',
          },
        }),
      ),
    ).rejects.toThrow();

    const planted = await owner.user.findFirst({ where: { username: 'smuggled' } });
    expect(planted).toBeNull();
  });

  it('cannot update another tenant\'s row', async () => {
    await asTenant(TENANT_A, (tx) =>
      tx.$executeRaw`UPDATE "users" SET "fullNameEn" = 'hijacked' WHERE "tenantId" = ${TENANT_B}::uuid`,
    );

    // The UPDATE is not an error — it simply matches nothing, because the rows are
    // invisible to it. Asserting on the row rather than on a thrown error is the
    // only way to tell those two apart.
    const untouched = await owner.user.findFirst({
      where: { tenantId: TENANT_B, username: 'shared-name' },
      select: { fullNameEn: true },
    });

    expect(untouched?.fullNameEn).toBe('B');
  });

  it('reads `tenants` with nothing bound, which is what lets sign-in resolve one', async () => {
    // `tenants` carries no `tenantId` and so has no policy. Sign-in depends on
    // exactly this: it has to learn which tenant to bind before it may read `users`.
    const found = await app.tenant.findFirst({ where: { code: 'ISO_A' }, select: { id: true } });

    expect(found?.id).toBe(TENANT_A);
  });

  it('can read `users` once sign-in has bound the tenant it resolved', async () => {
    // The sign-in sequence, in miniature: resolve the tenant unscoped, then look up
    // the user inside that scope.
    const tenant = await app.tenant.findFirstOrThrow({
      where: { code: 'ISO_B' },
      select: { id: true },
    });

    const user = await asTenant(tenant.id, (tx) =>
      tx.user.findFirst({ where: { username: 'shared-name' }, select: { tenantId: true } }),
    );

    expect(user?.tenantId).toBe(TENANT_B);
  });

  it('protects every model that carries a tenantId', async () => {
    // The client extension derives which models to warn about from the presence of
    // a `tenantId` column. If a model has one and no policy, that derivation is
    // right and the migration's table list has drifted — which is a silent hole.
    const scopedModels = Prisma.dmmf.datamodel.models
      .filter((model) => model.fields.some((field) => field.name === 'tenantId'))
      .map((model) => model.dbName ?? model.name);

    const policies = await owner.$queryRaw<{ tablename: string }[]>`
      SELECT DISTINCT tablename FROM pg_policies
       WHERE schemaname = 'public' AND policyname LIKE '%\\_tenant\\_isolation'
    `;

    const covered = new Set(policies.map((row) => row.tablename));
    const uncovered = scopedModels.filter((table) => !covered.has(table));

    expect(uncovered).toEqual([]);
  });
});
