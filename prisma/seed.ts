/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Data Generator Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds a complete, internally consistent trading company: five branches, ten
 * warehouses, 500 products, 300 counterparties, 50 employees, and a year of
 * trading activity that actually adds up.
 *
 * The design decision that matters most: business documents are created as
 * drafts and then posted **through the real application use cases**. Nothing
 * here writes a journal line or a stock movement by hand.
 *
 * That is slower than bulk-inserting fabricated rows, and it is the entire
 * point. Every generated invoice goes through the same stock availability check,
 * the same FIFO costing, the same balanced-journal validation and the same
 * database triggers as an invoice typed by a user. So the dataset cannot contain
 * a state the application would refuse to produce — and running the generator is
 * itself an end-to-end test of the posting engine. When it finishes, the trial
 * balance is verified to balance and the stock ledger is reconciled against its
 * movements; if either check fails, the generator exits non-zero.
 *
 * Randomness is seeded (SEED_RANDOM_SEED), so the same seed always produces
 * byte-identical data.
 */

import { PrismaClient, type CounterpartyClass, type PaymentMethod } from '@prisma/client';
import { JournalEntryDraft } from '../src/lib/domain/accounting/journal-entry';
import { Money } from '../src/lib/domain/shared/money';
import { Quantity } from '../src/lib/domain/shared/quantity';
import { DateOnly } from '../src/lib/domain/shared/value-objects';
import { calculateInvoice } from '../src/lib/domain/sales/invoice-calculator';
import { persistJournalEntry } from '../src/lib/application/services/journal-service';
import { allocateDocumentNumber } from '../src/lib/application/services/numbering-service';
import { postSalesInvoice } from '../src/lib/application/use-cases/post-sales-invoice';
import { postPurchaseInvoice } from '../src/lib/application/use-cases/post-purchase-invoice';
import { recordPayment } from '../src/lib/application/use-cases/record-payment';
import { transferStock } from '../src/lib/application/services/inventory-service';
import { generateSchedule, runDepreciation } from '../src/lib/application/services/depreciation-service';
import { encryptField } from '../src/lib/infrastructure/crypto/encryption';
import { hashPassword } from '../src/lib/infrastructure/auth/password';
import { PermissionSet, SYSTEM_ROLES, expandPermissionCatalogue } from '../src/lib/infrastructure/auth/rbac';
import type { RequestContext } from '../src/lib/infrastructure/auth/request-context';
import { withTransaction } from '../src/lib/infrastructure/db/prisma';
import {
  DeterministicRandom,
  generateIban,
  generateNationalId,
  generatePhone,
  generateVatNumber,
} from './seed/random';
import {
  ALLOWANCE_TYPES,
  BRANCH_TEMPLATES,
  BRANDS,
  CATEGORY_TEMPLATES,
  CITIES,
  COMPANY_NAMES,
  COMPANY_PREFIXES,
  COMPANY_SUFFIXES,
  COST_CENTERS,
  DEDUCTION_TYPES,
  DEPARTMENTS,
  FAMILY_NAMES,
  FEMALE_FIRST_NAMES,
  JOB_TITLES,
  JOURNAL_DESCRIPTIONS,
  MALE_FIRST_NAMES,
  PROJECTS,
  UNITS_OF_MEASURE,
} from './seed/reference-data';
import { CHART_OF_ACCOUNTS, GENERAL_EXPENSE_CODES, findParentCode } from './seed/chart-of-accounts';

const prisma = new PrismaClient();

// ── Target volumes ──────────────────────────────────────────────────────────
const TARGET = {
  products: 500,
  customers: 200,
  suppliers: 100,
  employees: 50,
  purchaseInvoices: 100,
  salesInvoices: 200,
  inventoryMovements: 1000,
  journals: 500,
} as const;

const FUNCTIONAL_CURRENCY = 'SAR';
/** Trivially simple on purpose — see the note where it is hashed. */
const DEMO_PASSWORD = '1234';

const FISCAL_YEAR = 2026;
const PERIOD_START = new Date(Date.UTC(2026, 0, 2));
const PERIOD_END = new Date(Date.UTC(2026, 6, 25));

const random = new DeterministicRandom(
  Number.parseInt(process.env['SEED_RANDOM_SEED'] ?? '20260101', 10),
);

function log(step: string, detail = ''): void {
  const stamp = new Date().toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`  [${stamp}] ${step}${detail !== '' ? ` — ${detail}` : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  // eslint-disable-next-line no-console
  console.log('║   Enterprise ERP — Data Generator Engine                      ║');
  // eslint-disable-next-line no-console
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const startedAt = Date.now();

  await reset();

  const tenantId = await createTenant();
  const accounts = await createChartOfAccounts(tenantId);
  await createFiscalCalendar(tenantId);
  const { adminUserId, users } = await createUsersAndRoles(tenantId);
  const org = await createOrganisation(tenantId);
  const catalogue = await createProductCatalogue(tenantId);
  const parties = await createCounterparties(tenantId);
  await createHumanResources(tenantId, org.branchIds);

  const context = buildSystemContext(tenantId, adminUserId);

  await postOpeningBalances(context, accounts, org.branchIds[0] ?? '');

  const stock = new StockTracker();

  await generatePurchaseInvoices(context, {
    org,
    catalogue,
    supplierIds: parties.supplierIds,
    stock,
    users,
  });

  await generateSalesInvoices(context, {
    org,
    catalogue,
    customerIds: parties.customerIds,
    stock,
    users,
  });

  await generateTransfersAndAdjustments(context, { org, catalogue, stock, accounts });
  await generatePayments(context, org);
  await generateGeneralJournals(context, accounts, org.branchIds);
  await createFixedAssets(context, accounts, org.branchIds);

  const report = await verify(tenantId);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // eslint-disable-next-line no-console
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  // eslint-disable-next-line no-console
  console.log('║   Verification                                                ║');
  // eslint-disable-next-line no-console
  console.log('╚══════════════════════════════════════════════════════════════╝');
  for (const line of report.lines) {
    // eslint-disable-next-line no-console
    console.log(`  ${line}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n  Completed in ${elapsed}s\n`);

  if (!report.passed) {
    throw new Error('Data generation produced an inconsistent dataset — see the failures above.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clears the database.
 *
 * TRUNCATE ... CASCADE rather than a chain of `deleteMany` calls: the ledger
 * tables carry triggers that (correctly) refuse UPDATE and DELETE, so a normal
 * delete cannot remove them at all. TRUNCATE bypasses row triggers, which is
 * exactly the escape hatch a re-seed needs and exactly why it is confined here.
 */
async function reset(): Promise<void> {
  log('Resetting database');

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE '\\_prisma%'
       AND tablename NOT IN (
             SELECT c.relname FROM pg_class c WHERE c.relispartition
           )
  `;

  const quoted = tables.map((row) => `"${row.tablename}"`).join(', ');
  if (quoted !== '') {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }

  log('Reset complete', `${tables.length} tables`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tenant, calendar, chart of accounts
// ─────────────────────────────────────────────────────────────────────────────

async function createTenant(): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: {
      code: 'DEMO',
      nameAr: 'شركة الأفق المتحدة للتجارة',
      nameEn: 'United Horizon Trading Company',
      functionalCurrency: FUNCTIONAL_CURRENCY,
      vatNumber: process.env['ZATCA_SELLER_VAT_NUMBER'] ?? '300000000000003',
      crn: '1010000001',
      addressJson: {
        street: 'طريق الملك فهد',
        district: 'حي العليا',
        city: 'الرياض',
        postalCode: '12211',
        country: 'SA',
      },
      timezone: 'Asia/Riyadh',
      costingMethod: 'WEIGHTED_AVERAGE',
      allowNegativeStock: false,
      allowOverpayment: false,
      // Disabled for generation: one system account creates and posts every
      // document. Enforcement is exercised by the test suite instead, where a
      // second user can be introduced to prove the rule actually bites.
      enforceSoD: false,
    },
    select: { id: true },
  });

  await prisma.currency.createMany({
    data: [
      { tenantId: tenant.id, code: 'SAR', nameAr: 'ريال سعودي', nameEn: 'Saudi Riyal', symbol: 'ر.س', minorUnits: 2, isFunctional: true },
      { tenantId: tenant.id, code: 'USD', nameAr: 'دولار أمريكي', nameEn: 'US Dollar', symbol: '$', minorUnits: 2 },
      { tenantId: tenant.id, code: 'EUR', nameAr: 'يورو', nameEn: 'Euro', symbol: '€', minorUnits: 2 },
      { tenantId: tenant.id, code: 'AED', nameAr: 'درهم إماراتي', nameEn: 'UAE Dirham', symbol: 'د.إ', minorUnits: 2 },
    ],
  });

  const currencies = await prisma.currency.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, code: true },
  });
  const byCode = new Map(currencies.map((currency) => [currency.code, currency.id]));
  const sar = byCode.get('SAR');

  // A rate per month, so multi-currency documents dated across the year each
  // find a published rate on or before their own date.
  const rates: { from: string; to: string; rate: number }[] = [
    { from: 'USD', to: 'SAR', rate: 3.75 },
    { from: 'EUR', to: 'SAR', rate: 4.08 },
    { from: 'AED', to: 'SAR', rate: 1.021 },
  ];

  const rateRows = [];
  for (const rate of rates) {
    const fromId = byCode.get(rate.from);
    if (fromId === undefined || sar === undefined) continue;
    for (let month = 0; month < 12; month += 1) {
      const drift = 1 + (random.next() - 0.5) * 0.02;
      rateRows.push({
        tenantId: tenant.id,
        fromCurrencyId: fromId,
        toCurrencyId: sar,
        fromCurrency: rate.from,
        toCurrency: 'SAR',
        rate: (rate.rate * drift).toFixed(6),
        validOn: new Date(Date.UTC(FISCAL_YEAR, month, 1)),
      });
    }
  }
  await prisma.exchangeRate.createMany({ data: rateRows });

  log('Tenant created', 'United Horizon Trading Company (SAR)');
  return tenant.id;
}

interface AccountIndex {
  readonly byCode: ReadonlyMap<string, string>;
  readonly mappingByKey: ReadonlyMap<string, string>;
}

async function createChartOfAccounts(tenantId: string): Promise<AccountIndex> {
  const allCodes = new Set(CHART_OF_ACCOUNTS.map((account) => account.code));
  const byCode = new Map<string, string>();

  // Shallowest first, so a parent always exists before its children reference it.
  const ordered = [...CHART_OF_ACCOUNTS].sort(
    (a, b) => a.code.split('-').length - b.code.split('-').length || a.code.localeCompare(b.code),
  );

  for (const template of ordered) {
    const parentCode = findParentCode(template.code, allCodes);
    const parentId = parentCode === null ? null : (byCode.get(parentCode) ?? null);

    const created = await prisma.account.create({
      data: {
        tenantId,
        code: template.code,
        nameAr: template.nameAr,
        nameEn: template.nameEn,
        type: template.type,
        nature: template.nature,
        parentId,
        level: template.code.split('-').length - 1,
        path: template.code.replace(/-/g, '.'),
        isPostable: template.isPostable,
        isControl: template.isControl ?? false,
        isContra: template.isContra ?? false,
      },
      select: { id: true },
    });

    byCode.set(template.code, created.id);
  }

  const mappingByKey = new Map<string, string>();
  const mappingRows = [];

  for (const template of CHART_OF_ACCOUNTS) {
    if (template.mappingKey === undefined) continue;
    const accountId = byCode.get(template.code);
    if (accountId === undefined) continue;
    mappingByKey.set(template.mappingKey, accountId);
    mappingRows.push({ tenantId, key: template.mappingKey, accountId });
  }

  await prisma.accountMapping.createMany({ data: mappingRows });

  log('Chart of accounts created', `${byCode.size} accounts, ${mappingRows.length} mappings`);
  return { byCode, mappingByKey };
}

async function createFiscalCalendar(tenantId: string): Promise<void> {
  for (const year of [FISCAL_YEAR - 1, FISCAL_YEAR]) {
    const fiscalYear = await prisma.fiscalYear.create({
      data: {
        tenantId,
        year,
        startDate: new Date(Date.UTC(year, 0, 1)),
        endDate: new Date(Date.UTC(year, 11, 31)),
        status: year < FISCAL_YEAR ? 'CLOSED' : 'OPEN',
      },
      select: { id: true },
    });

    await prisma.fiscalPeriod.createMany({
      data: Array.from({ length: 12 }, (_, index) => ({
        tenantId,
        fiscalYearId: fiscalYear.id,
        periodNumber: index + 1,
        startDate: new Date(Date.UTC(year, index, 1)),
        endDate: new Date(Date.UTC(year, index + 1, 0)),
        status: year < FISCAL_YEAR ? ('CLOSED' as const) : ('OPEN' as const),
      })),
    });
  }

  log('Fiscal calendar created', `${FISCAL_YEAR - 1} (closed), ${FISCAL_YEAR} (open)`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Users, roles, permissions
// ─────────────────────────────────────────────────────────────────────────────

async function createUsersAndRoles(
  tenantId: string,
): Promise<{ adminUserId: string; users: Record<string, string> }> {
  const catalogue = expandPermissionCatalogue();
  await prisma.permission.createMany({ data: catalogue, skipDuplicates: true });

  const permissions = await prisma.permission.findMany({
    select: { id: true, resource: true, action: true, field: true },
  });
  const permissionByKey = new Map(
    permissions.map((permission) => [
      `${permission.resource}:${permission.action}${permission.field !== null ? `:${permission.field}` : ''}`,
      permission.id,
    ]),
  );

  const roleIdByName = new Map<string, string>();

  for (const roleTemplate of SYSTEM_ROLES) {
    const role = await prisma.role.create({
      data: {
        tenantId,
        name: roleTemplate.name,
        nameAr: roleTemplate.nameAr,
        description: roleTemplate.description,
        isSystem: true,
      },
      select: { id: true },
    });

    roleIdByName.set(roleTemplate.name, role.id);

    const rows = roleTemplate.permissions
      .map((permission) => permissionByKey.get(permission))
      .filter((id): id is string => id !== undefined)
      .map((permissionId) => ({ roleId: role.id, permissionId }));

    if (rows.length > 0) {
      await prisma.rolePermission.createMany({ data: rows, skipDuplicates: true });
    }
  }

  // A single well-known password for the demo dataset. It is hashed with the
  // production cost factor, and the seed prints it — a demo credential that is
  // secret is a demo credential nobody can use.
  // Deliberately trivial. This generator builds a demonstration dataset that is shown to
  // people in a room, and a password nobody can type from memory is friction with no benefit
  // — there is nothing here to protect. The *policy* that governs real password changes is
  // untouched: `validatePassword` would still refuse this, and `hashPassword` only hashes.
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const userTemplates = [
    { username: 'admin', nameAr: 'مدير النظام', nameEn: 'System Administrator', role: 'SYSTEM_ADMINISTRATOR', isSuperAdmin: true },
    { username: 'admin-2', nameAr: 'سعود المالكي', nameEn: 'Saud Almalki', role: 'FINANCIAL_CONTROLLER', isSuperAdmin: false },
    { username: 'accountant', nameAr: 'نورة العتيبي', nameEn: 'Noura Alotaibi', role: 'ACCOUNTANT', isSuperAdmin: false },
    { username: 'sales', nameAr: 'خالد الحربي', nameEn: 'Khalid Alharbi', role: 'SALES_REPRESENTATIVE', isSuperAdmin: false },
    { username: 'warehouse', nameAr: 'ماجد الغامدي', nameEn: 'Majed Alghamdi', role: 'WAREHOUSE_KEEPER', isSuperAdmin: false },
    { username: 'cashier', nameAr: 'ريم الدوسري', nameEn: 'Reem Aldosari', role: 'CASHIER', isSuperAdmin: false },
    { username: 'hr', nameAr: 'فهد الشهري', nameEn: 'Fahad Alshehri', role: 'HR_MANAGER', isSuperAdmin: false },
    { username: 'auditor', nameAr: 'أحمد القحطاني', nameEn: 'Ahmed Alqahtani', role: 'AUDITOR', isSuperAdmin: false },
  ];

  const users: Record<string, string> = {};

  for (const template of userTemplates) {
    const user = await prisma.user.create({
      data: {
        tenantId,
        username: template.username,
        email: `${template.username}@united-horizon.example`,
        passwordHash,
        fullNameAr: template.nameAr,
        fullNameEn: template.nameEn,
        isSuperAdmin: template.isSuperAdmin,
        locale: 'ar',
      },
      select: { id: true },
    });

    users[template.username] = user.id;

    const roleId = roleIdByName.get(template.role);
    if (roleId !== undefined) {
      await prisma.userRole.create({ data: { userId: user.id, roleId } });
    }
  }

  const adminUserId = users['admin'];
  if (adminUserId === undefined) throw new Error('Admin user was not created.');

  log('Users and roles created', `${userTemplates.length} users, ${SYSTEM_ROLES.length} roles`);
  return { adminUserId, users };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Organisation
// ─────────────────────────────────────────────────────────────────────────────

interface Organisation {
  readonly branchIds: string[];
  /** Branch id -> its non-quarantine warehouse ids. */
  readonly warehousesByBranch: Map<string, string[]>;
  readonly allWarehouseIds: string[];
  readonly cashAccountId: string;
  readonly bankAccountId: string;
  readonly costCenterIds: string[];
  readonly projectIds: string[];
}

async function createOrganisation(tenantId: string): Promise<Organisation> {
  const branchIds: string[] = [];
  const warehousesByBranch = new Map<string, string[]>();
  const allWarehouseIds: string[] = [];

  for (const template of BRANCH_TEMPLATES) {
    const city = CITIES[template.cityIndex] ?? CITIES[0];

    const branch = await prisma.branch.create({
      data: {
        tenantId,
        code: template.code,
        nameAr: template.ar,
        nameEn: template.en,
        city: city?.ar ?? 'الرياض',
        phone: generatePhone(random),
        addressJson: { city: city?.ar ?? 'الرياض', country: 'SA' },
      },
      select: { id: true },
    });

    branchIds.push(branch.id);
    const warehouseIds: string[] = [];

    for (const warehouseTemplate of template.warehouses) {
      const isQuarantine = warehouseTemplate.code === 'WH03';
      const warehouse = await prisma.warehouse.create({
        data: {
          tenantId,
          branchId: branch.id,
          code: warehouseTemplate.code,
          nameAr: warehouseTemplate.ar,
          nameEn: warehouseTemplate.en,
          location: city?.ar ?? 'الرياض',
          isQuarantine,
        },
        select: { id: true },
      });

      allWarehouseIds.push(warehouse.id);
      // Quarantine stock is not available to promise, so the generator never
      // sells out of it.
      if (!isQuarantine) warehouseIds.push(warehouse.id);
    }

    warehousesByBranch.set(branch.id, warehouseIds);

    const defaultWarehouse = warehouseIds[0];
    if (defaultWarehouse !== undefined) {
      await prisma.branch.update({
        where: { id: branch.id },
        data: { defaultWarehouseId: defaultWarehouse },
      });
    }
  }

  const costCenterIds: string[] = [];
  for (const template of COST_CENTERS) {
    const created = await prisma.costCenter.create({
      data: { tenantId, code: template.code, nameAr: template.ar, nameEn: template.en },
      select: { id: true },
    });
    costCenterIds.push(created.id);
  }

  const projectIds: string[] = [];
  for (const template of PROJECTS) {
    const created = await prisma.project.create({
      data: {
        tenantId,
        code: template.code,
        nameAr: template.ar,
        nameEn: template.en,
        startDate: new Date(Date.UTC(FISCAL_YEAR, 0, 15)),
        endDate: new Date(Date.UTC(FISCAL_YEAR, 11, 15)),
        budget: template.budget.toFixed(4),
      },
      select: { id: true },
    });
    projectIds.push(created.id);
  }

  const cash = await prisma.account.findFirst({
    where: { tenantId, code: '1-1-01-001' },
    select: { id: true },
  });
  const bank = await prisma.account.findFirst({
    where: { tenantId, code: '1-1-02-001' },
    select: { id: true },
  });

  log(
    'Organisation created',
    `${branchIds.length} branches, ${allWarehouseIds.length} warehouses, ${costCenterIds.length} cost centres`,
  );

  return {
    branchIds,
    warehousesByBranch,
    allWarehouseIds,
    cashAccountId: cash?.id ?? '',
    bankAccountId: bank?.id ?? '',
    costCenterIds,
    projectIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Product catalogue
// ─────────────────────────────────────────────────────────────────────────────

interface ProductRecord {
  readonly id: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly salePrice: string;
  readonly costPrice: string;
  readonly taxRate: string;
  readonly isStockItem: boolean;
  readonly trackBatch: boolean;
  readonly trackExpiry: boolean;
  readonly trackSerial: boolean;
}

interface Catalogue {
  readonly products: ProductRecord[];
  readonly stockProducts: ProductRecord[];
}

async function createProductCatalogue(tenantId: string): Promise<Catalogue> {
  const unitIdByCode = new Map<string, string>();
  for (const unit of UNITS_OF_MEASURE) {
    const created = await prisma.unitOfMeasure.create({
      data: {
        tenantId,
        code: unit.code,
        nameAr: unit.ar,
        nameEn: unit.en,
        baseFactor: unit.baseFactor,
      },
      select: { id: true },
    });
    unitIdByCode.set(unit.code, created.id);
  }

  const brandIds: string[] = [];
  for (const brand of BRANDS) {
    const created = await prisma.brand.create({
      data: { tenantId, nameAr: brand.ar, nameEn: brand.en },
      select: { id: true },
    });
    brandIds.push(created.id);
  }

  const categoryIdByCode = new Map<string, string>();
  for (const template of CATEGORY_TEMPLATES) {
    const created = await prisma.category.create({
      data: {
        tenantId,
        code: template.code,
        nameAr: template.nameAr,
        nameEn: template.nameEn,
      },
      select: { id: true },
    });
    categoryIdByCode.set(template.code, created.id);
  }

  const products: ProductRecord[] = [];
  const rows: {
    tenantId: string;
    sku: string;
    nameAr: string;
    nameEn: string;
    description: string;
    categoryId: string;
    brandId: string | null;
    unitOfMeasureId: string;
    salePrice: string;
    costPrice: string;
    taxRate: string;
    trackExpiry: boolean;
    trackBatch: boolean;
    trackSerial: boolean;
    isStockItem: boolean;
    reorderPoint: string;
    barcode: string;
  }[] = [];

  // Distribute the target across categories in proportion to how many distinct
  // item names each has, so no category ends up with 60 variants of one product.
  const totalItems = CATEGORY_TEMPLATES.reduce((sum, template) => sum + template.items.length, 0);
  let serial = 1000;

  for (const template of CATEGORY_TEMPLATES) {
    const categoryId = categoryIdByCode.get(template.code);
    const unitId = unitIdByCode.get(template.unitCode) ?? unitIdByCode.get('PCS');
    if (categoryId === undefined || unitId === undefined) continue;

    const share = Math.round((template.items.length / totalItems) * TARGET.products);

    for (let index = 0; index < share; index += 1) {
      const item = template.items[index % template.items.length];
      if (item === undefined) continue;

      serial += 1;
      const variant = Math.floor(index / template.items.length) + 1;
      const salePrice = Number.parseFloat(
        random.decimal(template.minPrice, template.maxPrice, 2),
      );
      const costPrice = salePrice * template.costRatio * (0.95 + random.next() * 0.1);
      const isService = template.code === 'SRV';

      rows.push({
        tenantId,
        sku: `${template.prefix}-${serial}`,
        nameAr: variant > 1 ? `${item.ar} - طراز ${variant}` : item.ar,
        nameEn: variant > 1 ? `${item.en} - Model ${variant}` : item.en,
        description: `${item.ar} — ${template.nameAr}`,
        categoryId,
        brandId: isService ? null : random.pick(brandIds),
        unitOfMeasureId: unitId,
        salePrice: salePrice.toFixed(4),
        costPrice: costPrice.toFixed(4),
        // A slice of the catalogue is zero-rated, so VAT logic is exercised
        // rather than merely assumed to be 15% everywhere.
        taxRate: random.chance(0.08) ? '0.00' : '15.00',
        trackExpiry: template.trackExpiry,
        trackBatch: template.trackBatch,
        trackSerial: false,
        isStockItem: !isService,
        reorderPoint: String(random.int(5, 60)),
        barcode: `628${String(serial).padStart(10, '0')}`,
      });
    }
  }

  // Top up to exactly the target if the proportional split rounded down.
  while (rows.length < TARGET.products) {
    const template = CATEGORY_TEMPLATES[0];
    const seed = rows[random.int(0, rows.length - 1)];
    if (template === undefined || seed === undefined) break;
    serial += 1;
    rows.push({ ...seed, sku: `${template.prefix}-${serial}`, barcode: `628${String(serial).padStart(10, '0')}` });
  }

  await prisma.product.createMany({ data: rows.slice(0, TARGET.products) });

  const created = await prisma.product.findMany({
    where: { tenantId },
    select: {
      id: true,
      sku: true,
      nameAr: true,
      salePrice: true,
      costPrice: true,
      taxRate: true,
      isStockItem: true,
      trackBatch: true,
      trackExpiry: true,
      trackSerial: true,
    },
  });

  for (const product of created) {
    products.push({
      id: product.id,
      sku: product.sku,
      nameAr: product.nameAr,
      salePrice: product.salePrice.toFixed(4),
      costPrice: product.costPrice.toFixed(4),
      taxRate: product.taxRate.toFixed(2),
      isStockItem: product.isStockItem,
      trackBatch: product.trackBatch,
      trackExpiry: product.trackExpiry,
      trackSerial: product.trackSerial,
    });
  }

  log('Product catalogue created', `${products.length} products across ${CATEGORY_TEMPLATES.length} categories`);

  return { products, stockProducts: products.filter((product) => product.isStockItem) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Counterparties
// ─────────────────────────────────────────────────────────────────────────────

function companyName(): { ar: string; en: string } {
  const prefix = random.pick(COMPANY_PREFIXES);
  const name = random.pick(COMPANY_NAMES);
  const suffix = random.pick(COMPANY_SUFFIXES);
  return {
    ar: `${prefix.ar} ${name.ar} ${suffix.ar}`,
    en: `${name.en} ${suffix.en} ${prefix.en}`,
  };
}

async function createCounterparties(
  tenantId: string,
): Promise<{ customerIds: string[]; supplierIds: string[] }> {
  const rows: {
    tenantId: string;
    code: string;
    type: 'CUSTOMER' | 'SUPPLIER';
    nameAr: string;
    nameEn: string;
    email: string;
    phone: string;
    addressJson: object;
    taxNumber: string;
    crn: string;
    creditLimit: string;
    paymentTerms: number;
    classification: CounterpartyClass;
    currency: string;
  }[] = [];

  for (let index = 1; index <= TARGET.customers; index += 1) {
    const name = companyName();
    const city = random.pick(CITIES);
    // A/B/C classification drives credit limit and payment terms, the way a real
    // credit policy does.
    const classification = random.weighted<CounterpartyClass>([
      { value: 'A', weight: 15 },
      { value: 'B', weight: 35 },
      { value: 'C', weight: 50 },
    ]);
    const creditLimit =
      classification === 'A'
        ? random.decimal(500_000, 2_000_000, 2)
        : classification === 'B'
          ? random.decimal(100_000, 500_000, 2)
          : random.decimal(0, 100_000, 2);

    rows.push({
      tenantId,
      code: `CUS-${String(index).padStart(4, '0')}`,
      type: 'CUSTOMER',
      nameAr: name.ar,
      nameEn: name.en,
      email: `info${index}@${name.en.split(' ')[0]?.toLowerCase() ?? 'company'}.example`,
      phone: generatePhone(random),
      addressJson: { city: city.ar, country: 'SA' },
      taxNumber: generateVatNumber(random),
      crn: `10${String(random.int(10_000_000, 99_999_999))}`,
      creditLimit,
      paymentTerms: random.pick([0, 15, 30, 45, 60, 90]),
      classification,
      currency: FUNCTIONAL_CURRENCY,
    });
  }

  for (let index = 1; index <= TARGET.suppliers; index += 1) {
    const name = companyName();
    const city = random.pick(CITIES);
    rows.push({
      tenantId,
      code: `SUP-${String(index).padStart(4, '0')}`,
      type: 'SUPPLIER',
      nameAr: name.ar,
      nameEn: name.en,
      email: `sales${index}@${name.en.split(' ')[0]?.toLowerCase() ?? 'supplier'}.example`,
      phone: generatePhone(random),
      addressJson: { city: city.ar, country: 'SA' },
      taxNumber: generateVatNumber(random),
      crn: `10${String(random.int(10_000_000, 99_999_999))}`,
      creditLimit: '0.00',
      paymentTerms: random.pick([15, 30, 45, 60]),
      classification: random.weighted<CounterpartyClass>([
        { value: 'A', weight: 25 },
        { value: 'B', weight: 40 },
        { value: 'C', weight: 35 },
      ]),
      currency: FUNCTIONAL_CURRENCY,
    });
  }

  await prisma.counterparty.createMany({ data: rows });

  const created = await prisma.counterparty.findMany({
    where: { tenantId },
    select: { id: true, type: true },
  });

  const customerIds = created.filter((row) => row.type === 'CUSTOMER').map((row) => row.id);
  const supplierIds = created.filter((row) => row.type === 'SUPPLIER').map((row) => row.id);

  log('Counterparties created', `${customerIds.length} customers, ${supplierIds.length} suppliers`);
  return { customerIds, supplierIds };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fixed assets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A small asset register, and the depreciation actually run over part of it.
 *
 * Deliberately not a uniform set. The register is the input to the depreciation screen, and a
 * screen is only worth looking at if it can show the states it exists to distinguish — so this
 * produces an asset whose schedule is fully caught up, one deliberately left with no schedule
 * at all (absent from a run rather than late, which a run result alone cannot say), one on
 * declining balance so the switch to straight line is visible in the figures, and one disposed
 * so it can be seen being skipped.
 *
 * The depreciation is then posted through the real service rather than written by hand, for the
 * same reason every other document here is: the dataset cannot contain a state the application
 * would refuse to produce.
 */
async function createFixedAssets(
  context: RequestContext,
  accounts: AccountIndex,
  branchIds: readonly string[],
): Promise<void> {
  const existing = await prisma.fixedAsset.count({ where: { tenantId: context.tenantId } });
  if (existing > 0) return;

  const branchId = branchIds[0];
  if (branchId === undefined) return;

  const expense = accounts.byCode.get('5-3-10-001');
  const groups = [
    { asset: '1-2-01-001', accumulated: '1-2-02-001', label: 'أثاث ومعدات' },
    { asset: '1-2-01-002', accumulated: '1-2-02-002', label: 'أجهزة حاسب' },
    { asset: '1-2-01-003', accumulated: '1-2-02-003', label: 'سيارات' },
  ];

  if (expense === undefined) return;

  interface AssetSpec {
    readonly name: string;
    readonly group: number;
    readonly cost: string;
    readonly salvage: string;
    readonly months: number;
    readonly method: 'STRAIGHT_LINE' | 'DECLINING_BALANCE';
    readonly acquired: string;
    readonly schedule: boolean;
    readonly disposed?: string;
  }

  const specs: AssetSpec[] = [
    { name: 'أثاث المقر الرئيسي', group: 0, cost: '240000.00', salvage: '24000.00', months: 120, method: 'STRAIGHT_LINE', acquired: `${FISCAL_YEAR}-01-15`, schedule: true },
    { name: 'خوادم مركز البيانات', group: 1, cost: '180000.00', salvage: '18000.00', months: 48, method: 'DECLINING_BALANCE', acquired: `${FISCAL_YEAR}-01-20`, schedule: true },
    { name: 'أجهزة حاسب الفروع', group: 1, cost: '96000.00', salvage: '6000.00', months: 36, method: 'STRAIGHT_LINE', acquired: `${FISCAL_YEAR}-02-01`, schedule: true },
    { name: 'شاحنة توزيع', group: 2, cost: '320000.00', salvage: '80000.00', months: 84, method: 'DECLINING_BALANCE', acquired: `${FISCAL_YEAR}-01-10`, schedule: true },
    // No schedule on purpose: this is what "absent from the run" looks like on the screen.
    { name: 'مكيفات المستودع', group: 0, cost: '64000.00', salvage: '4000.00', months: 60, method: 'STRAIGHT_LINE', acquired: `${FISCAL_YEAR}-03-01`, schedule: false },
    // Disposed, so the run has something to leave out.
    { name: 'سيارة إدارية مستبعدة', group: 2, cost: '140000.00', salvage: '20000.00', months: 72, method: 'STRAIGHT_LINE', acquired: `${FISCAL_YEAR}-01-05`, schedule: true, disposed: `${FISCAL_YEAR}-05-31` },
  ];

  let created = 0;

  for (const [index, spec] of specs.entries()) {
    const group = groups[spec.group];
    const assetAccount = group === undefined ? undefined : accounts.byCode.get(group.asset);
    const accumulatedAccount =
      group === undefined ? undefined : accounts.byCode.get(group.accumulated);
    if (assetAccount === undefined || accumulatedAccount === undefined) continue;

    const asset = await prisma.fixedAsset.create({
      data: {
        tenantId: context.tenantId,
        assetNumber: `FA-${String(index + 1).padStart(4, '0')}`,
        nameAr: spec.name,
        nameEn: spec.name,
        branchId,
        acquisitionDate: new Date(spec.acquired),
        acquisitionCost: spec.cost,
        salvageValue: spec.salvage,
        usefulLifeMonths: spec.months,
        method: spec.method,
        decliningFactor: spec.method === 'DECLINING_BALANCE' ? '2' : '2',
        // Migration 008 requires netBookValue to equal cost − accumulated.
        netBookValue: spec.cost,
        assetAccountId: assetAccount,
        accumulatedAccountId: accumulatedAccount,
        expenseAccountId: expense,
        ...(spec.disposed !== undefined ? { disposedAt: new Date(spec.disposed) } : {}),
      },
      select: { id: true },
    });

    created += 1;

    if (spec.schedule) {
      // A disposed asset is refused a schedule, which is correct — so it is generated first
      // and the disposal applied after, which is also the real order of events.
      if (spec.disposed !== undefined) {
        await prisma.fixedAsset.update({ where: { id: asset.id }, data: { disposedAt: null } });
      }

      const result = await generateSchedule({
        tenantId: context.tenantId,
        assetId: asset.id,
        audit: auditFrom(withNewCorrelation(context)),
      });

      if (!result.ok) throw new Error(`Schedule generation failed: ${result.error.messageEn}`);

      if (spec.disposed !== undefined) {
        await prisma.fixedAsset.update({
          where: { id: asset.id },
          data: { disposedAt: new Date(spec.disposed) },
        });
      }
    }
  }

  log('Fixed assets complete', `${created} assets registered`);

  // Post the first four months, leaving the rest of the year due — so the screen opens with
  // both a history to read and something to run.
  const asOf = DateOnly.create(`${FISCAL_YEAR}-04-30`);
  if (!asOf.ok) return;

  const run = await runDepreciation({
    tenantId: context.tenantId,
    asOf: asOf.value,
    userId: context.userId,
    audit: auditFrom(withNewCorrelation(context)),
  });

  if (!run.ok) throw new Error(`Depreciation run failed: ${run.error.messageEn}`);

  log(
    'Depreciation posted',
    `${run.value.postedCount} charges, ${run.value.totalAmount} SAR, ${run.value.skipped.length} asset(s) skipped`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Human resources
// ─────────────────────────────────────────────────────────────────────────────

async function createHumanResources(tenantId: string, branchIds: readonly string[]): Promise<void> {
  const departmentIdByCode = new Map<string, string>();

  for (const department of DEPARTMENTS) {
    const created = await prisma.department.create({
      data: { tenantId, code: department.code, nameAr: department.ar, nameEn: department.en },
      select: { id: true },
    });
    departmentIdByCode.set(department.code, created.id);
  }

  const rows = [];

  for (let index = 1; index <= TARGET.employees; index += 1) {
    const job = random.pick(JOB_TITLES);
    const departmentId = departmentIdByCode.get(job.departmentCode);
    const branchId = random.pick(branchIds);
    if (departmentId === undefined || branchId === undefined) continue;

    const isFemale = random.chance(0.3);
    const first = random.pick(isFemale ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES);
    const family = random.pick(FAMILY_NAMES);
    const basicSalary = Number.parseFloat(random.decimal(job.minSalary, job.maxSalary, 2));

    rows.push({
      tenantId,
      employeeNumber: `EMP-${String(index).padStart(4, '0')}`,
      fullNameAr: `${first.ar} ${family.ar}`,
      fullNameEn: `${first.en} ${family.en}`,
      departmentId,
      branchId,
      jobTitleAr: job.ar,
      jobTitleEn: job.en,
      // Personal identifiers are encrypted at rest; the plaintext exists only
      // for the moment it takes to encrypt it.
      nationalIdEnc: encryptField(generateNationalId(random)),
      ibanEnc: encryptField(generateIban(random)),
      email: `emp${index}@united-horizon.example`,
      phone: generatePhone(random),
      basicSalary: basicSalary.toFixed(4),
      allowancesJson: ALLOWANCE_TYPES.map((allowance) => ({
        code: allowance.code,
        nameAr: allowance.ar,
        nameEn: allowance.en,
        amount: (basicSalary * allowance.ratio).toFixed(2),
        isPercentage: false,
        taxable: false,
      })),
      deductionsJson: DEDUCTION_TYPES.filter(
        (deduction) => deduction.code === 'GOSI' || random.chance(0.2),
      ).map((deduction) => ({
        code: deduction.code,
        nameAr: deduction.ar,
        nameEn: deduction.en,
        amount: (basicSalary * deduction.ratio).toFixed(2),
        isPercentage: false,
      })),
      hireDate: random.date(new Date(Date.UTC(2018, 0, 1)), new Date(Date.UTC(2025, 11, 31))),
      isActive: random.chance(0.94),
    });
  }

  await prisma.employee.createMany({ data: rows });
  log('Human resources created', `${rows.length} employees across ${DEPARTMENTS.length} departments`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trading activity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tracks what the generator believes is on hand, so it never asks the system to
 * sell stock that does not exist.
 *
 * The application would refuse such a sale — correctly — and the generator would
 * then be testing its own bookkeeping rather than generating data. Quantities are
 * whole numbers throughout, which keeps this mirror exact.
 */
class StockTracker {
  private readonly onHand = new Map<string, number>();

  private static key(productId: string, warehouseId: string): string {
    return `${productId}|${warehouseId}`;
  }

  add(productId: string, warehouseId: string, quantity: number): void {
    const key = StockTracker.key(productId, warehouseId);
    this.onHand.set(key, (this.onHand.get(key) ?? 0) + quantity);
  }

  remove(productId: string, warehouseId: string, quantity: number): void {
    this.add(productId, warehouseId, -quantity);
  }

  available(productId: string, warehouseId: string): number {
    return this.onHand.get(StockTracker.key(productId, warehouseId)) ?? 0;
  }

  /** Products with at least `minimum` units in the given warehouse. */
  stockedIn(warehouseId: string, minimum = 1): { productId: string; quantity: number }[] {
    const result: { productId: string; quantity: number }[] = [];
    for (const [key, quantity] of this.onHand) {
      if (quantity < minimum) continue;
      const [productId, keyWarehouse] = key.split('|');
      if (keyWarehouse !== warehouseId || productId === undefined) continue;
      result.push({ productId, quantity });
    }
    return result;
  }
}

function buildSystemContext(tenantId: string, userId: string): RequestContext {
  return {
    userId,
    username: 'admin',
    tenantId,
    branchId: null,
    permissions: new PermissionSet([], true),
    isSuperAdmin: true,
    sessionId: 'seed',
    ipAddress: '127.0.0.1',
    userAgent: 'data-generator',
    locale: 'ar',
    correlationId: crypto.randomUUID(),
  };
}

/** A fresh correlation id per generated document keeps audit trails separable. */
function withNewCorrelation(context: RequestContext): RequestContext {
  return { ...context, correlationId: crypto.randomUUID() };
}

async function postOpeningBalances(
  context: RequestContext,
  accounts: AccountIndex,
  branchId: string,
): Promise<void> {
  const capital = accounts.mappingByKey.get('OPENING_BALANCE_EQUITY');
  const cash = accounts.mappingByKey.get('CASH');
  const bank = accounts.mappingByKey.get('BANK');

  if (capital === undefined || cash === undefined || bank === undefined) {
    throw new Error('Opening balance accounts are not mapped.');
  }

  await withTransaction(async (tx) => {
    const draft = new JournalEntryDraft({
      tenantId: context.tenantId,
      type: 'OPENING',
      date: DateOnly.create('2026-01-01').ok
        ? (DateOnly.create('2026-01-01') as { ok: true; value: DateOnly }).value
        : DateOnly.today(),
      descriptionAr: 'قيد الأرصدة الافتتاحية للسنة المالية 2026',
      descriptionEn: 'Opening balances for fiscal year 2026',
      branchId,
      referenceType: 'OPENING_BALANCE',
      currency: FUNCTIONAL_CURRENCY,
      exchangeRate: '1',
      functionalCurrency: FUNCTIONAL_CURRENCY,
    });

    // Sized to the trading volume the generator goes on to produce. A company
    // that will carry ~100M of inventory and settle ~80M of purchases cannot be
    // funded with 15M of capital — the ledger would still balance, but the demo
    // would show a solvent business running a large negative cash position,
    // which reads as a bug even though the arithmetic is sound.
    draft.debit(cash, Money.of('25000000.00', FUNCTIONAL_CURRENCY), {
      description: 'رصيد افتتاحي - الصندوق',
    });
    draft.debit(bank, Money.of('125000000.00', FUNCTIONAL_CURRENCY), {
      description: 'رصيد افتتاحي - البنك',
    });
    draft.credit(capital, Money.of('150000000.00', FUNCTIONAL_CURRENCY), {
      description: 'رأس المال المدفوع',
    });

    const validated = draft.validate();
    if (!validated.ok) throw new Error(validated.error.messageEn);

    const posted = await persistJournalEntry(tx, validated.value, {
      audit: auditFrom(context),
      createdById: context.userId,
      postImmediately: true,
    });

    if (!posted.ok) throw new Error(posted.error.messageEn);
  });

  log('Opening balances posted', 'SAR 150,000,000 capital');
}

function auditFrom(context: RequestContext) {
  return {
    tenantId: context.tenantId,
    userId: context.userId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    sessionId: context.sessionId,
    correlationId: context.correlationId,
  };
}

interface TradingInputs {
  readonly org: Organisation;
  readonly catalogue: Catalogue;
  readonly stock: StockTracker;
  readonly users: Record<string, string>;
}

async function generatePurchaseInvoices(
  context: RequestContext,
  inputs: TradingInputs & { supplierIds: string[] },
): Promise<void> {
  let posted = 0;
  let failed = 0;

  for (let index = 0; index < TARGET.purchaseInvoices; index += 1) {
    const branchId = random.pick(inputs.org.branchIds);
    const warehouses = inputs.org.warehousesByBranch.get(branchId) ?? [];
    const warehouseId = warehouses.length > 0 ? random.pick(warehouses) : undefined;
    if (warehouseId === undefined) continue;

    // Purchases are concentrated in the first two thirds of the period, so there
    // is stock on hand before the sales that will consume it.
    const issueDate = random.businessDate(
      PERIOD_START,
      new Date(PERIOD_START.getTime() + (PERIOD_END.getTime() - PERIOD_START.getTime()) * 0.7),
    );

    const supplierId = random.pick(inputs.supplierIds);
    const lineCount = random.int(2, 6);
    const chosen = random.sample(inputs.catalogue.stockProducts, lineCount);

    const lines = chosen.map((product) => {
      const quantity = random.weighted([
        { value: random.int(20, 80), weight: 60 },
        { value: random.int(100, 400), weight: 30 },
        { value: random.int(500, 1200), weight: 10 },
      ]);
      // Buying price drifts around the catalogue cost, as a real supplier's would.
      const unitPrice = (
        Number.parseFloat(product.costPrice) *
        (0.92 + random.next() * 0.16)
      ).toFixed(4);

      return {
        product,
        quantity,
        unitPrice,
        discount: random.chance(0.25)
          ? (Number.parseFloat(unitPrice) * quantity * random.next() * 0.05).toFixed(4)
          : '0',
      };
    });

    const result = await createAndPostDocument(context, {
      type: 'PURCHASE_INVOICE',
      counterpartyId: supplierId,
      branchId,
      warehouseId,
      issueDate,
      lines,
      currency: FUNCTIONAL_CURRENCY,
    });

    if (result === null) {
      failed += 1;
      continue;
    }

    posted += 1;
    for (const line of lines) {
      inputs.stock.add(line.product.id, warehouseId, line.quantity);
    }

    if (posted % 25 === 0) log('Purchase invoices', `${posted}/${TARGET.purchaseInvoices} posted`);
  }

  log('Purchase invoices complete', `${posted} posted${failed > 0 ? `, ${failed} skipped` : ''}`);
}

async function generateSalesInvoices(
  context: RequestContext,
  inputs: TradingInputs & { customerIds: string[] },
): Promise<void> {
  let posted = 0;
  let skipped = 0;

  // A minority of customers generate most of the revenue — the shape every real
  // sales ledger has, and the one that makes an ABC analysis meaningful.
  const keyAccounts = random.sample(inputs.customerIds, Math.ceil(inputs.customerIds.length * 0.2));

  for (let index = 0; index < TARGET.salesInvoices; index += 1) {
    const branchId = random.pick(inputs.org.branchIds);
    const warehouses = inputs.org.warehousesByBranch.get(branchId) ?? [];
    const warehouseId = warehouses.length > 0 ? random.pick(warehouses) : undefined;
    if (warehouseId === undefined) continue;

    const stocked = inputs.stock.stockedIn(warehouseId, 5);
    if (stocked.length === 0) {
      skipped += 1;
      continue;
    }

    const customerId = random.chance(0.7)
      ? random.pick(keyAccounts)
      : random.pick(inputs.customerIds);

    const issueDate = random.businessDate(
      new Date(PERIOD_START.getTime() + (PERIOD_END.getTime() - PERIOD_START.getTime()) * 0.15),
      PERIOD_END,
    );

    const lineCount = Math.min(random.int(1, 5), stocked.length);
    const picks = random.sample(stocked, lineCount);

    const productById = new Map(inputs.catalogue.products.map((product) => [product.id, product]));

    const lines = picks
      .map((pick) => {
        const product = productById.get(pick.productId);
        if (product === undefined) return null;

        // Never sell more than a quarter of what is on hand in one go, so later
        // invoices still have something to sell.
        const maximum = Math.max(1, Math.floor(pick.quantity * 0.25));
        const quantity = random.int(1, Math.min(maximum, 60));

        const unitPrice = (
          Number.parseFloat(product.salePrice) *
          (0.95 + random.next() * 0.12)
        ).toFixed(4);

        return {
          product,
          quantity,
          unitPrice,
          discount: random.chance(0.3)
            ? (Number.parseFloat(unitPrice) * quantity * random.next() * 0.08).toFixed(4)
            : '0',
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);

    if (lines.length === 0) {
      skipped += 1;
      continue;
    }

    // Occasionally add a service line, which posts revenue without touching stock.
    const services = inputs.catalogue.products.filter((product) => !product.isStockItem);
    if (random.chance(0.15) && services.length > 0) {
      const service = random.pick(services);
      lines.push({
        product: service,
        quantity: 1,
        unitPrice: service.salePrice,
        discount: '0',
      });
    }

    const result = await createAndPostDocument(context, {
      type: 'SALES_INVOICE',
      counterpartyId: customerId,
      branchId,
      warehouseId,
      issueDate,
      lines,
      currency: FUNCTIONAL_CURRENCY,
    });

    if (result === null) {
      skipped += 1;
      continue;
    }

    posted += 1;
    for (const line of lines) {
      if (line.product.isStockItem) {
        inputs.stock.remove(line.product.id, warehouseId, line.quantity);
      }
    }

    if (posted % 50 === 0) log('Sales invoices', `${posted}/${TARGET.salesInvoices} posted`);
  }

  log('Sales invoices complete', `${posted} posted${skipped > 0 ? `, ${skipped} skipped` : ''}`);
}

interface DocumentLineInput {
  readonly product: ProductRecord;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly discount: string;
}

/**
 * Creates a draft document and posts it through the real use case.
 *
 * Returns null when posting is refused — which happens legitimately (a warehouse
 * ran dry between the tracker's estimate and the actual position) and should
 * reduce the generated count rather than abort the run.
 */
async function createAndPostDocument(
  context: RequestContext,
  input: {
    type: 'SALES_INVOICE' | 'PURCHASE_INVOICE';
    counterpartyId: string;
    branchId: string;
    warehouseId: string;
    issueDate: Date;
    lines: readonly DocumentLineInput[];
    currency: string;
  },
): Promise<string | null> {
  const calculated = calculateInvoice(
    input.lines.map((line) => ({
      productId: line.product.id,
      quantity: Quantity.of(String(line.quantity)),
      unitPrice: Money.of(line.unitPrice, input.currency),
      discount: Money.of(line.discount, input.currency),
      taxRate: line.product.taxRate,
      descriptionAr: line.product.nameAr,
    })),
    { currency: input.currency },
  );

  if (!calculated.ok) return null;

  const counterparty = await prisma.counterparty.findUnique({
    where: { id: input.counterpartyId },
    select: { paymentTerms: true },
  });

  const issueDateOnly = DateOnly.fromDate(input.issueDate);
  const dueDate = issueDateOnly.addDays(counterparty?.paymentTerms ?? 30);

  const documentContext = withNewCorrelation(context);

  const documentId = await withTransaction(async (tx) => {
    const documentNumber = await allocateDocumentNumber(
      tx,
      context.tenantId,
      input.type === 'SALES_INVOICE' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE',
      issueDateOnly.year,
    );

    const document = await tx.document.create({
      data: {
        tenantId: context.tenantId,
        documentNumber,
        type: input.type,
        status: 'DRAFT',
        counterpartyId: input.counterpartyId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        issueDate: input.issueDate,
        dueDate: dueDate.toDate(),
        currency: input.currency,
        exchangeRate: '1',
        subtotal: calculated.value.subtotal.toString(),
        discountTotal: calculated.value.discountTotal.toString(),
        taxTotal: calculated.value.taxTotal.toString(),
        total: calculated.value.total.toString(),
        createdById: context.userId,
      },
      select: { id: true },
    });

    await tx.documentLine.createMany({
      data: calculated.value.lines.map((line) => ({
        tenantId: context.tenantId,
        documentId: document.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        descriptionAr: line.descriptionAr,
        quantity: line.quantity.toString(),
        unitPrice: line.unitPrice.toString(),
        discount: line.discount.toString(),
        taxRate: line.taxRate,
        taxAmount: line.taxAmount.toString(),
        lineTotal: line.lineTotal.toString(),
      })),
    });

    return document.id;
  });

  const posted =
    input.type === 'SALES_INVOICE'
      ? await postSalesInvoice(documentContext, { documentId })
      : await postPurchaseInvoice(documentContext, { documentId });

  if (!posted.ok) {
    // Leave the draft in place: a document that could not be posted is exactly
    // the kind of record a real system accumulates, and it exercises the UI's
    // draft handling.
    return null;
  }

  return documentId;
}

async function generateTransfersAndAdjustments(
  context: RequestContext,
  inputs: { org: Organisation; catalogue: Catalogue; stock: StockTracker; accounts: AccountIndex },
): Promise<void> {
  const movementsSoFar = await prisma.inventoryMovement.count();
  // Each transfer writes two movements. Budget generously and stop on the count
  // rather than on the iteration index: a transfer can legitimately be skipped
  // (no warehouse pair with stock), and a fixed loop would then undershoot.
  const needed = Math.max(0, TARGET.inventoryMovements - movementsSoFar);
  const maxAttempts = Math.ceil(needed / 2) * 6 + 20;

  let transfers = 0;

  for (let index = 0; index < maxAttempts; index += 1) {
    if (transfers * 2 >= needed) break;
    const branchId = random.pick(inputs.org.branchIds);
    const warehouses = inputs.org.warehousesByBranch.get(branchId) ?? [];
    if (warehouses.length < 2) continue;

    const [fromWarehouseId, toWarehouseId] = random.sample(warehouses, 2);
    if (fromWarehouseId === undefined || toWarehouseId === undefined) continue;

    const stocked = inputs.stock.stockedIn(fromWarehouseId, 10);
    if (stocked.length === 0) continue;

    const pick = random.pick(stocked);
    const quantity = random.int(1, Math.max(1, Math.floor(pick.quantity * 0.3)));

    const product = inputs.catalogue.products.find((item) => item.id === pick.productId);
    if (product === undefined) continue;

    const warehouseNames = await prisma.warehouse.findMany({
      where: { id: { in: [fromWarehouseId, toWarehouseId] } },
      select: { id: true, nameAr: true, nameEn: true },
    });
    const source = warehouseNames.find((warehouse) => warehouse.id === fromWarehouseId);

    const date = DateOnly.fromDate(random.businessDate(PERIOD_START, PERIOD_END));

    const result = await withTransaction(async (tx) =>
      transferStock(tx, {
        tenantId: context.tenantId,
        branchId,
        productId: pick.productId,
        date,
        createdById: context.userId,
        fromWarehouseId,
        toWarehouseId,
        quantity: Quantity.of(String(quantity)),
        costingMethod: 'WEIGHTED_AVERAGE',
        allowNegativeStock: false,
        currency: FUNCTIONAL_CURRENCY,
        productNameAr: product.nameAr,
        productNameEn: product.sku,
        fromWarehouseNameAr: source?.nameAr ?? '',
        fromWarehouseNameEn: source?.nameEn ?? '',
        notes: 'تحويل مخزني بين المستودعات',
      }),
    );

    if (!result.ok) continue;

    inputs.stock.remove(pick.productId, fromWarehouseId, quantity);
    inputs.stock.add(pick.productId, toWarehouseId, quantity);
    transfers += 1;
  }

  log('Stock transfers complete', `${transfers} transfers (${transfers * 2} movements)`);
}

async function generatePayments(context: RequestContext, org: Organisation): Promise<void> {
  const openDocuments = await prisma.document.findMany({
    where: { isPosted: true, status: { in: ['POSTED', 'PARTIAL_PAID'] } },
    select: {
      id: true,
      type: true,
      counterpartyId: true,
      branchId: true,
      total: true,
      paidAmount: true,
      issueDate: true,
      currency: true,
    },
    orderBy: { issueDate: 'asc' },
  });

  let receipts = 0;
  let payments = 0;

  for (const document of openDocuments) {
    // Roughly two thirds of invoices have been settled at least partly — which
    // leaves a realistic ageing profile rather than a ledger that is all paid or
    // all overdue.
    if (!random.chance(0.66)) continue;

    const outstanding = Number.parseFloat(document.total.toFixed(4)) - Number.parseFloat(document.paidAmount.toFixed(4));
    if (outstanding <= 0) continue;

    const isFullSettlement = random.chance(0.7);
    const amount = isFullSettlement
      ? outstanding.toFixed(2)
      : (outstanding * (0.25 + random.next() * 0.5)).toFixed(2);

    if (Number.parseFloat(amount) <= 0) continue;

    const method = random.weighted<PaymentMethod>([
      { value: 'BANK', weight: 55 },
      { value: 'CASH', weight: 25 },
      { value: 'CHECK', weight: 12 },
      { value: 'CARD', weight: 8 },
    ]);

    const accountId = method === 'CASH' ? org.cashAccountId : org.bankAccountId;
    if (accountId === '') continue;

    const paymentDate = DateOnly.fromDate(document.issueDate).addDays(random.int(1, 75));
    // Never settle a document in the future.
    const boundedDate = paymentDate.toDate() > PERIOD_END ? DateOnly.fromDate(PERIOD_END) : paymentDate;

    const isReceipt = document.type === 'SALES_INVOICE';

    const result = await recordPayment(withNewCorrelation(context), {
      type: isReceipt ? 'RECEIPT' : 'PAYMENT',
      counterpartyId: document.counterpartyId,
      branchId: document.branchId,
      paymentDate: boundedDate.toString(),
      amount,
      currency: document.currency,
      method,
      accountId,
      ...(method === 'CHECK'
        ? {
            checkNumber: String(random.int(100_000, 999_999)),
            checkDate: boundedDate.toString(),
          }
        : {}),
      allocations: [{ documentId: document.id, amount }],
      notes: isReceipt ? 'تحصيل من العميل' : 'سداد للمورد',
    });

    if (!result.ok) continue;

    if (isReceipt) receipts += 1;
    else payments += 1;
  }

  log('Payments complete', `${receipts} receipts, ${payments} payment vouchers`);
}

async function generateGeneralJournals(
  context: RequestContext,
  accounts: AccountIndex,
  branchIds: readonly string[],
): Promise<void> {
  const existing = await prisma.journal.count({ where: { status: 'POSTED' } });
  const needed = Math.max(0, TARGET.journals - existing);

  const bankAccount = accounts.mappingByKey.get('BANK');
  const cashAccount = accounts.mappingByKey.get('CASH');
  if (bankAccount === undefined || cashAccount === undefined) return;

  const expenseAccounts = GENERAL_EXPENSE_CODES.map((code) => accounts.byCode.get(code)).filter(
    (id): id is string => id !== undefined,
  );

  let created = 0;

  for (let index = 0; index < needed; index += 1) {
    const description = random.pick(JOURNAL_DESCRIPTIONS);
    const expenseAccount = random.pick(expenseAccounts);
    const branchId = random.pick(branchIds);
    const amount = random.decimal(1_500, 85_000, 2);
    const date = DateOnly.fromDate(random.businessDate(PERIOD_START, PERIOD_END));
    const fundingAccount = random.chance(0.75) ? bankAccount : cashAccount;

    const result = await withTransaction(async (tx) => {
      const draft = new JournalEntryDraft({
        tenantId: context.tenantId,
        type: 'GENERAL',
        date,
        descriptionAr: description.ar,
        descriptionEn: description.en,
        branchId,
        currency: FUNCTIONAL_CURRENCY,
        exchangeRate: '1',
        functionalCurrency: FUNCTIONAL_CURRENCY,
      });

      draft.debit(expenseAccount, Money.of(amount, FUNCTIONAL_CURRENCY), {
        description: description.ar,
      });
      draft.credit(fundingAccount, Money.of(amount, FUNCTIONAL_CURRENCY), {
        description: description.ar,
      });

      const validated = draft.validate();
      if (!validated.ok) return validated;

      return persistJournalEntry(tx, validated.value, {
        audit: auditFrom(withNewCorrelation(context)),
        createdById: context.userId,
        postImmediately: true,
      });
    });

    if (result.ok) created += 1;
  }

  log('General journals complete', `${created} entries added`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Proves the generated dataset is internally consistent.
 *
 * These are not statistics for the console — they are assertions. A generator
 * that quietly produces an unbalanced ledger is worse than no generator at all,
 * because every subsequent test is then measured against a broken baseline.
 */
async function verify(tenantId: string): Promise<{ passed: boolean; lines: string[] }> {
  const lines: string[] = [];
  let passed = true;

  const check = (label: string, ok: boolean, detail: string): void => {
    lines.push(`${ok ? '✓' : '✗'} ${label.padEnd(42)} ${detail}`);
    if (!ok) passed = false;
  };

  // 1. Every posted journal balances, and the ledger as a whole balances.
  const ledger = await prisma.$queryRaw<{ totalDebit: string; totalCredit: string; entries: bigint }[]>`
    SELECT COALESCE(SUM(l."debit"), 0)::text  AS "totalDebit",
           COALESCE(SUM(l."credit"), 0)::text AS "totalCredit",
           COUNT(DISTINCT l."journalId")::bigint AS entries
      FROM "journal_lines" l
      JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
     WHERE l."tenantId" = ${tenantId}::uuid
       AND j."status" = 'POSTED'
  `;

  const totalDebit = Money.of(ledger[0]?.totalDebit ?? '0', FUNCTIONAL_CURRENCY);
  const totalCredit = Money.of(ledger[0]?.totalCredit ?? '0', FUNCTIONAL_CURRENCY);

  check(
    'Ledger balances (debit = credit)',
    totalDebit.equals(totalCredit),
    `${totalDebit.toFixed(2)} = ${totalCredit.toFixed(2)}`,
  );

  const unbalanced = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM (
      SELECT l."journalId"
        FROM "journal_lines" l
        JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
       WHERE l."tenantId" = ${tenantId}::uuid AND j."status" = 'POSTED'
       GROUP BY l."journalId"
      HAVING SUM(l."debit") <> SUM(l."credit")
    ) AS bad
  `;

  check(
    'Every individual entry balances',
    Number(unbalanced[0]?.count ?? 0n) === 0,
    `${Number(unbalanced[0]?.count ?? 0n)} unbalanced entries`,
  );

  // 2. Stock levels agree with the movements that produced them.
  const stockDrift = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT s."productId", s."warehouseId", s."quantityOnHand",
               COALESCE(SUM(
                 CASE WHEN m."type" IN ('IN', 'RETURN') THEN m."quantity"
                      WHEN m."type" IN ('OUT', 'TRANSFER') THEN -m."quantity"
                      ELSE 0 END
               ), 0) AS derived
          FROM "stock_levels" s
          LEFT JOIN "inventory_movements" m
                 ON m."productId" = s."productId"
                AND m."warehouseId" = s."warehouseId"
                AND m."tenantId" = s."tenantId"
         WHERE s."tenantId" = ${tenantId}::uuid
         GROUP BY s."productId", s."warehouseId", s."quantityOnHand"
      ) AS reconciliation
     WHERE "quantityOnHand" <> derived
  `;

  check(
    'Stock levels reconcile to movements',
    Number(stockDrift[0]?.count ?? 0n) === 0,
    `${Number(stockDrift[0]?.count ?? 0n)} discrepancies`,
  );

  // 3. No negative stock anywhere.
  const negative = await prisma.stockLevel.count({
    where: { tenantId, quantityOnHand: { lt: 0 } },
  });
  check('No negative stock positions', negative === 0, `${negative} negative positions`);

  // 4. Inventory valuation is internally consistent.
  const valuationDrift = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
      FROM "stock_levels" s
     WHERE s."tenantId" = ${tenantId}::uuid
       AND ABS(s."totalValue" - (s."quantityOnHand" * s."averageCost")) > 0.05
  `;
  check(
    'Inventory value = quantity x avg cost',
    Number(valuationDrift[0]?.count ?? 0n) === 0,
    `${Number(valuationDrift[0]?.count ?? 0n)} drifting rows`,
  );

  // 5. Document paid amounts agree with their allocations.
  const paymentDrift = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT d."id", d."paidAmount",
               COALESCE(SUM(a."amount"), 0) AS allocated
          FROM "documents" d
          LEFT JOIN "payment_allocations" a ON a."documentId" = d."id"
         WHERE d."tenantId" = ${tenantId}::uuid
         GROUP BY d."id", d."paidAmount"
      ) AS reconciliation
     WHERE "paidAmount" <> allocated
  `;
  check(
    'Paid amounts match allocations',
    Number(paymentDrift[0]?.count ?? 0n) === 0,
    `${Number(paymentDrift[0]?.count ?? 0n)} mismatches`,
  );

  // 6. Volume targets.
  const [products, customers, suppliers, employees, branches, warehouses, journals, salesInvoices, purchaseInvoices, movements, auditRows, zatca] =
    await Promise.all([
      prisma.product.count({ where: { tenantId } }),
      prisma.counterparty.count({ where: { tenantId, type: 'CUSTOMER' } }),
      prisma.counterparty.count({ where: { tenantId, type: 'SUPPLIER' } }),
      prisma.employee.count({ where: { tenantId } }),
      prisma.branch.count({ where: { tenantId } }),
      prisma.warehouse.count({ where: { tenantId } }),
      prisma.journal.count({ where: { tenantId, status: 'POSTED' } }),
      prisma.document.count({ where: { tenantId, type: 'SALES_INVOICE', isPosted: true } }),
      prisma.document.count({ where: { tenantId, type: 'PURCHASE_INVOICE', isPosted: true } }),
      prisma.inventoryMovement.count({ where: { tenantId } }),
      prisma.auditLog.count({ where: { tenantId } }),
      prisma.zatcaInvoice.count(),
    ]);

  check('Products', products === TARGET.products, `${products} / ${TARGET.products}`);
  check('Customers', customers === TARGET.customers, `${customers} / ${TARGET.customers}`);
  check('Suppliers', suppliers === TARGET.suppliers, `${suppliers} / ${TARGET.suppliers}`);
  check('Employees', employees === TARGET.employees, `${employees} / ${TARGET.employees}`);
  check('Branches', branches === 5, `${branches} / 5`);
  check('Warehouses', warehouses === 10, `${warehouses} / 10`);
  check('Posted journal entries', journals >= TARGET.journals, `${journals} / ${TARGET.journals}`);
  check('Sales invoices posted', salesInvoices >= TARGET.salesInvoices * 0.9, `${salesInvoices} / ${TARGET.salesInvoices}`);
  check('Purchase invoices posted', purchaseInvoices >= TARGET.purchaseInvoices * 0.9, `${purchaseInvoices} / ${TARGET.purchaseInvoices}`);
  check('Inventory movements', movements >= TARGET.inventoryMovements * 0.9, `${movements} / ${TARGET.inventoryMovements}`);
  check('ZATCA e-invoices generated', zatca === salesInvoices, `${zatca} for ${salesInvoices} sales invoices`);
  check('Audit trail populated', auditRows > 0, `${auditRows} entries`);
  lines.push('');
  lines.push('  Sign in at /login with any of:');
  lines.push('    admin / admin-2 / accountant / sales / warehouse / cashier / hr / auditor');
  lines.push(`    password: ${DEMO_PASSWORD}`);

  return { passed, lines };
}

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('\n  Data generation failed:\n', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
