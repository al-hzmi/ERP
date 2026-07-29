-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "AccountNature" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "FiscalStatus" AS ENUM ('OPEN', 'CLOSED', 'LOCKED');

-- CreateEnum
CREATE TYPE "JournalType" AS ENUM ('GENERAL', 'SALES', 'PURCHASE', 'CASH', 'INVENTORY', 'PAYROLL', 'ADJUSTMENT', 'DEPRECIATION', 'OPENING', 'CLOSING');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('SALES_INVOICE', 'PURCHASE_INVOICE', 'SALES_CREDIT_NOTE', 'PURCHASE_DEBIT_NOTE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'PARTIAL_PAID', 'FULLY_PAID', 'VOID', 'RETURNED');

-- CreateEnum
CREATE TYPE "CounterpartyType" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH');

-- CreateEnum
CREATE TYPE "CounterpartyClass" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('IN', 'OUT', 'TRANSFER', 'ADJUSTMENT', 'RETURN');

-- CreateEnum
CREATE TYPE "CostingMethod" AS ENUM ('FIFO', 'WEIGHTED_AVERAGE');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('RECEIPT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK', 'CHECK', 'CARD');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('DRAFT', 'POSTED', 'VOID');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'POST', 'VOID', 'APPROVE', 'REJECT', 'REVERSE', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'EXPORT', 'ACCESS_DENIED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DepreciationMethod" AS ENUM ('STRAIGHT_LINE', 'DECLINING_BALANCE');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "functionalCurrency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "vatNumber" VARCHAR(15),
    "crn" VARCHAR(20),
    "addressJson" JSONB NOT NULL DEFAULT '{}',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Riyadh',
    "costingMethod" "CostingMethod" NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
    "allowOverpayment" BOOLEAN NOT NULL DEFAULT false,
    "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false,
    "enforceSoD" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "email" VARCHAR(256) NOT NULL,
    "passwordHash" VARCHAR(72) NOT NULL,
    "fullNameAr" VARCHAR(256) NOT NULL,
    "fullNameEn" VARCHAR(256) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "defaultBranchId" UUID,
    "locale" VARCHAR(8) NOT NULL DEFAULT 'ar',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Riyadh',
    "calendarPref" VARCHAR(16) NOT NULL DEFAULT 'both',
    "numeralSystem" VARCHAR(16) NOT NULL DEFAULT 'western',
    "lastLoginAt" TIMESTAMPTZ(6),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "passwordChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "replacedById" UUID,
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "nameAr" VARCHAR(128) NOT NULL,
    "description" VARCHAR(512),
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "resource" VARCHAR(64) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "field" VARCHAR(64),
    "description" VARCHAR(512),

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "branchId" UUID,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID,
    "action" "AuditAction" NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(64) NOT NULL,
    "fieldName" VARCHAR(64),
    "oldValue" TEXT,
    "newValue" TEXT,
    "metadata" JSONB,
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "sessionId" VARCHAR(64),
    "correlationId" UUID,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "eventType" VARCHAR(96) NOT NULL,
    "aggregateType" VARCHAR(64) NOT NULL,
    "aggregateId" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "correlationId" UUID,
    "causationId" UUID,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deadLettered" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "year" INTEGER NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 5,
    "nextValue" BIGINT NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "severity" VARCHAR(16) NOT NULL DEFAULT 'info',
    "titleAr" VARCHAR(256) NOT NULL,
    "titleEn" VARCHAR(256) NOT NULL,
    "bodyAr" TEXT,
    "bodyEn" TEXT,
    "link" VARCHAR(512),
    "readAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "city" VARCHAR(128),
    "addressJson" JSONB NOT NULL DEFAULT '{}',
    "phone" VARCHAR(32),
    "defaultWarehouseId" UUID,
    "bankAccountsJson" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "location" VARCHAR(256),
    "isQuarantine" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "parentId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "budget" DECIMAL(19,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currencies" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" CHAR(3) NOT NULL,
    "nameAr" VARCHAR(64) NOT NULL,
    "nameEn" VARCHAR(64) NOT NULL,
    "symbol" VARCHAR(8) NOT NULL,
    "minorUnits" INTEGER NOT NULL DEFAULT 2,
    "isFunctional" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fromCurrencyId" UUID NOT NULL,
    "toCurrencyId" UUID NOT NULL,
    "fromCurrency" CHAR(3) NOT NULL,
    "toCurrency" CHAR(3) NOT NULL,
    "rate" DECIMAL(19,6) NOT NULL,
    "validOn" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "type" "AccountType" NOT NULL,
    "nature" "AccountNature" NOT NULL,
    "parentId" UUID,
    "level" INTEGER NOT NULL DEFAULT 0,
    "path" VARCHAR(512) NOT NULL,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "isControl" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3),
    "balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mappings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID,
    "categoryId" UUID,

    CONSTRAINT "account_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_years" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FiscalStatus" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" UUID NOT NULL,
    "fiscalYearId" UUID NOT NULL,
    "periodNumber" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FiscalStatus" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "entryNumber" VARCHAR(32) NOT NULL,
    "type" "JournalType" NOT NULL,
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "date" DATE NOT NULL,
    "branchId" UUID,
    "fiscalPeriodId" UUID,
    "descriptionAr" VARCHAR(512) NOT NULL,
    "descriptionEn" VARCHAR(512),
    "referenceType" VARCHAR(32),
    "referenceId" VARCHAR(64),
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "exchangeRate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "totalDebit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "reversesJournalId" UUID,
    "isReversed" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID NOT NULL,
    "postedById" UUID,
    "postedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id","date")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "journalDate" DATE NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "accountId" UUID NOT NULL,
    "debit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "foreignDebit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "foreignCredit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "description" VARCHAR(512),
    "costCenterId" UUID,
    "projectId" UUID,
    "counterpartyId" UUID,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id","journalDate")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "nameAr" VARCHAR(128) NOT NULL,
    "nameEn" VARCHAR(128) NOT NULL,
    "parentId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "nameAr" VARCHAR(128) NOT NULL,
    "nameEn" VARCHAR(128) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "nameAr" VARCHAR(64) NOT NULL,
    "nameEn" VARCHAR(64) NOT NULL,
    "baseFactor" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sku" VARCHAR(32) NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "description" VARCHAR(1024),
    "categoryId" UUID NOT NULL,
    "brandId" UUID,
    "unitOfMeasureId" UUID NOT NULL,
    "salePrice" DECIMAL(19,4) NOT NULL,
    "costPrice" DECIMAL(19,4) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "costingMethod" "CostingMethod",
    "trackExpiry" BOOLEAN NOT NULL DEFAULT false,
    "trackSerial" BOOLEAN NOT NULL DEFAULT false,
    "trackBatch" BOOLEAN NOT NULL DEFAULT false,
    "isStockItem" BOOLEAN NOT NULL DEFAULT true,
    "reorderPoint" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "barcode" VARCHAR(64),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counterparties" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "type" "CounterpartyType" NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "email" VARCHAR(256),
    "phone" VARCHAR(32),
    "addressJson" JSONB NOT NULL DEFAULT '{}',
    "taxNumber" VARCHAR(15),
    "crn" VARCHAR(20),
    "creditLimit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "paymentTerms" INTEGER NOT NULL DEFAULT 30,
    "classification" "CounterpartyClass" NOT NULL DEFAULT 'C',
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "counterparties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "documentNumber" VARCHAR(32) NOT NULL,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "counterpartyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "warehouseId" UUID,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "exchangeRate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "notes" VARCHAR(1024),
    "referenceType" VARCHAR(32),
    "referenceId" VARCHAR(64),
    "isPosted" BOOLEAN NOT NULL DEFAULT false,
    "postedAt" TIMESTAMPTZ(6),
    "voidedAt" TIMESTAMPTZ(6),
    "voidReason" VARCHAR(512),
    "createdById" UUID NOT NULL,
    "postedById" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productId" UUID NOT NULL,
    "descriptionAr" VARCHAR(512),
    "quantity" DECIMAL(19,4) NOT NULL,
    "unitPrice" DECIMAL(19,4) NOT NULL,
    "discount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "taxAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "cogsAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "batchNumber" VARCHAR(64),
    "serialNumber" VARCHAR(64),
    "expiryDate" DATE,

    CONSTRAINT "document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zatca_invoices" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "invoiceUuid" UUID NOT NULL,
    "previousHash" VARCHAR(64) NOT NULL,
    "invoiceHash" VARCHAR(64) NOT NULL,
    "qrCode" TEXT NOT NULL,
    "xml" TEXT NOT NULL,
    "invoiceTypeCode" VARCHAR(16) NOT NULL,
    "issuedAtUtc" TIMESTAMPTZ(6) NOT NULL,
    "submittedAt" TIMESTAMPTZ(6),
    "clearanceStatus" VARCHAR(32),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zatca_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "movementNumber" VARCHAR(32) NOT NULL,
    "type" "MovementType" NOT NULL,
    "movementDate" DATE NOT NULL,
    "productId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unitCost" DECIMAL(19,4) NOT NULL,
    "totalCost" DECIMAL(19,4) NOT NULL,
    "balanceAfter" DECIMAL(19,4) NOT NULL,
    "referenceType" VARCHAR(32),
    "referenceId" VARCHAR(64),
    "batchNumber" VARCHAR(64),
    "serialNumber" VARCHAR(64),
    "expiryDate" DATE,
    "fromWarehouseId" UUID,
    "toWarehouseId" UUID,
    "transferGroupId" UUID,
    "notes" VARCHAR(512),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id","movementDate")
);

-- CreateTable
CREATE TABLE "stock_levels" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "quantityOnHand" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "quantityReserved" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "averageCost" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "lastMovementAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_layers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "sourceMovementId" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "originalQuantity" DECIMAL(19,4) NOT NULL,
    "remainingQuantity" DECIMAL(19,4) NOT NULL,
    "unitCost" DECIMAL(19,4) NOT NULL,
    "batchNumber" VARCHAR(64),
    "expiryDate" DATE,

    CONSTRAINT "cost_layers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "voucherNumber" VARCHAR(32) NOT NULL,
    "type" "PaymentType" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "counterpartyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "paymentDate" DATE NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "unallocatedAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "exchangeRate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "method" "PaymentMethod" NOT NULL,
    "accountId" UUID NOT NULL,
    "checkNumber" VARCHAR(64),
    "checkDate" DATE,
    "bankReference" VARCHAR(128),
    "notes" VARCHAR(512),
    "postedAt" TIMESTAMPTZ(6),
    "voidedAt" TIMESTAMPTZ(6),
    "createdById" UUID NOT NULL,
    "postedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "statementRef" VARCHAR(64) NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "openingBalance" DECIMAL(19,4) NOT NULL,
    "closingBalance" DECIMAL(19,4) NOT NULL,
    "isReconciled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "bankStatementId" UUID NOT NULL,
    "valueDate" DATE NOT NULL,
    "description" VARCHAR(512) NOT NULL,
    "reference" VARCHAR(128),
    "debit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "matchedPaymentId" UUID,
    "matchedAt" TIMESTAMPTZ(6),
    "matchScore" INTEGER,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "nameAr" VARCHAR(128) NOT NULL,
    "nameEn" VARCHAR(128) NOT NULL,
    "parentId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeNumber" VARCHAR(32) NOT NULL,
    "fullNameAr" VARCHAR(256) NOT NULL,
    "fullNameEn" VARCHAR(256) NOT NULL,
    "departmentId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "jobTitleAr" VARCHAR(128) NOT NULL,
    "jobTitleEn" VARCHAR(128) NOT NULL,
    "nationalIdEnc" VARCHAR(512),
    "ibanEnc" VARCHAR(512),
    "email" VARCHAR(256),
    "phone" VARCHAR(32),
    "basicSalary" DECIMAL(19,4) NOT NULL,
    "allowancesJson" JSONB NOT NULL DEFAULT '[]',
    "deductionsJson" JSONB NOT NULL DEFAULT '[]',
    "hireDate" DATE NOT NULL,
    "terminationDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runNumber" VARCHAR(32) NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "totalGross" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMPTZ(6),
    "journalId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "basicSalary" DECIMAL(19,4) NOT NULL,
    "allowances" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "gross" DECIMAL(19,4) NOT NULL,
    "net" DECIMAL(19,4) NOT NULL,
    "breakdownJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "documentType" VARCHAR(32) NOT NULL,
    "minAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "roleId" UUID NOT NULL,
    "excludeInitiator" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "entityType" VARCHAR(32) NOT NULL,
    "entityId" VARCHAR(64) NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_actions" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "userId" UUID NOT NULL,
    "decision" "ApprovalStatus" NOT NULL,
    "comment" VARCHAR(512),
    "actedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_assets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assetNumber" VARCHAR(32) NOT NULL,
    "nameAr" VARCHAR(256) NOT NULL,
    "nameEn" VARCHAR(256) NOT NULL,
    "branchId" UUID NOT NULL,
    "acquisitionDate" DATE NOT NULL,
    "acquisitionCost" DECIMAL(19,4) NOT NULL,
    "salvageValue" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "method" "DepreciationMethod" NOT NULL DEFAULT 'STRAIGHT_LINE',
    "decliningFactor" DECIMAL(5,2) NOT NULL DEFAULT 2,
    "accumulatedDepreciation" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "netBookValue" DECIMAL(19,4) NOT NULL,
    "assetAccountId" UUID NOT NULL,
    "accumulatedAccountId" UUID NOT NULL,
    "expenseAccountId" UUID NOT NULL,
    "disposedAt" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_schedules" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "periodDate" DATE NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "accumulated" DECIMAL(19,4) NOT NULL,
    "netBookValue" DECIMAL(19,4) NOT NULL,
    "isPosted" BOOLEAN NOT NULL DEFAULT false,
    "journalId" UUID,

    CONSTRAINT "depreciation_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");

-- CreateIndex
CREATE INDEX "tenants_isActive_idx" ON "tenants"("isActive");

-- CreateIndex
CREATE INDEX "users_tenantId_isActive_idx" ON "users"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_username_key" ON "users"("tenantId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_revokedAt_idx" ON "refresh_tokens"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_name_key" ON "roles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "permissions_resource_idx" ON "permissions"("resource");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_resource_action_field_key" ON "permissions"("resource", "action", "field");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_entityType_entityId_idx" ON "audit_logs"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_userId_timestamp_idx" ON "audit_logs"("tenantId", "userId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_timestamp_idx" ON "audit_logs"("tenantId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_correlationId_idx" ON "audit_logs"("correlationId");

-- CreateIndex
CREATE INDEX "outbox_events_processedAt_occurredAt_idx" ON "outbox_events"("processedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "outbox_events_tenantId_aggregateType_aggregateId_idx" ON "outbox_events"("tenantId", "aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "outbox_events_eventType_idx" ON "outbox_events"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_tenantId_key_year_key" ON "number_sequences"("tenantId", "key", "year");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "branches_tenantId_isActive_idx" ON "branches"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenantId_code_key" ON "branches"("tenantId", "code");

-- CreateIndex
CREATE INDEX "warehouses_tenantId_branchId_isActive_idx" ON "warehouses"("tenantId", "branchId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenantId_code_key" ON "warehouses"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_tenantId_code_key" ON "cost_centers"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "projects_tenantId_code_key" ON "projects"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "currencies_tenantId_code_key" ON "currencies"("tenantId", "code");

-- CreateIndex
CREATE INDEX "exchange_rates_tenantId_validOn_idx" ON "exchange_rates"("tenantId", "validOn");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_tenantId_fromCurrency_toCurrency_validOn_key" ON "exchange_rates"("tenantId", "fromCurrency", "toCurrency", "validOn");

-- CreateIndex
CREATE INDEX "accounts_tenantId_type_isActive_idx" ON "accounts"("tenantId", "type", "isActive");

-- CreateIndex
CREATE INDEX "accounts_tenantId_parentId_idx" ON "accounts"("tenantId", "parentId");

-- CreateIndex
CREATE INDEX "accounts_tenantId_path_idx" ON "accounts"("tenantId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenantId_code_key" ON "accounts"("tenantId", "code");

-- CreateIndex
CREATE INDEX "account_mappings_tenantId_key_idx" ON "account_mappings"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "account_mappings_tenantId_key_branchId_categoryId_key" ON "account_mappings"("tenantId", "key", "branchId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_years_tenantId_year_key" ON "fiscal_years"("tenantId", "year");

-- CreateIndex
CREATE INDEX "fiscal_periods_startDate_endDate_idx" ON "fiscal_periods"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_fiscalYearId_periodNumber_key" ON "fiscal_periods"("fiscalYearId", "periodNumber");

-- CreateIndex
CREATE INDEX "journals_tenantId_date_idx" ON "journals"("tenantId", "date");

-- CreateIndex
CREATE INDEX "journals_tenantId_status_date_idx" ON "journals"("tenantId", "status", "date");

-- CreateIndex
CREATE INDEX "journals_tenantId_referenceType_referenceId_idx" ON "journals"("tenantId", "referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "journals_tenantId_type_date_idx" ON "journals"("tenantId", "type", "date");

-- CreateIndex
CREATE UNIQUE INDEX "journals_tenantId_entryNumber_date_key" ON "journals"("tenantId", "entryNumber", "date");

-- CreateIndex
CREATE INDEX "journal_lines_journalId_idx" ON "journal_lines"("journalId");

-- CreateIndex
CREATE INDEX "journal_lines_tenantId_accountId_journalDate_idx" ON "journal_lines"("tenantId", "accountId", "journalDate");

-- CreateIndex
CREATE INDEX "journal_lines_tenantId_counterpartyId_journalDate_idx" ON "journal_lines"("tenantId", "counterpartyId", "journalDate");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenantId_code_key" ON "categories"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenantId_nameEn_key" ON "brands"("tenantId", "nameEn");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_tenantId_code_key" ON "units_of_measure"("tenantId", "code");

-- CreateIndex
CREATE INDEX "products_tenantId_categoryId_isActive_idx" ON "products"("tenantId", "categoryId", "isActive");

-- CreateIndex
CREATE INDEX "products_tenantId_isActive_idx" ON "products"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_sku_key" ON "products"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "counterparties_tenantId_type_isActive_idx" ON "counterparties"("tenantId", "type", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "counterparties_tenantId_code_key" ON "counterparties"("tenantId", "code");

-- CreateIndex
CREATE INDEX "documents_tenantId_type_status_issueDate_idx" ON "documents"("tenantId", "type", "status", "issueDate");

-- CreateIndex
CREATE INDEX "documents_tenantId_counterpartyId_issueDate_idx" ON "documents"("tenantId", "counterpartyId", "issueDate");

-- CreateIndex
CREATE INDEX "documents_tenantId_issueDate_idx" ON "documents"("tenantId", "issueDate");

-- CreateIndex
CREATE INDEX "documents_tenantId_branchId_issueDate_idx" ON "documents"("tenantId", "branchId", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenantId_documentNumber_key" ON "documents"("tenantId", "documentNumber");

-- CreateIndex
CREATE INDEX "document_lines_tenantId_productId_idx" ON "document_lines"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "document_lines_documentId_lineNumber_key" ON "document_lines"("documentId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "zatca_invoices_documentId_key" ON "zatca_invoices"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "zatca_invoices_invoiceUuid_key" ON "zatca_invoices"("invoiceUuid");

-- CreateIndex
CREATE INDEX "zatca_invoices_issuedAtUtc_idx" ON "zatca_invoices"("issuedAtUtc");

-- CreateIndex
CREATE INDEX "inventory_movements_tenantId_productId_warehouseId_movement_idx" ON "inventory_movements"("tenantId", "productId", "warehouseId", "movementDate");

-- CreateIndex
CREATE INDEX "inventory_movements_tenantId_referenceType_referenceId_idx" ON "inventory_movements"("tenantId", "referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "inventory_movements_tenantId_movementDate_idx" ON "inventory_movements"("tenantId", "movementDate");

-- CreateIndex
CREATE INDEX "inventory_movements_transferGroupId_idx" ON "inventory_movements"("transferGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_tenantId_movementNumber_movementDate_key" ON "inventory_movements"("tenantId", "movementNumber", "movementDate");

-- CreateIndex
CREATE INDEX "stock_levels_tenantId_warehouseId_idx" ON "stock_levels"("tenantId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_levels_tenantId_productId_warehouseId_key" ON "stock_levels"("tenantId", "productId", "warehouseId");

-- CreateIndex
CREATE INDEX "cost_layers_tenantId_productId_warehouseId_receivedAt_idx" ON "cost_layers"("tenantId", "productId", "warehouseId", "receivedAt");

-- CreateIndex
CREATE INDEX "cost_layers_tenantId_expiryDate_idx" ON "cost_layers"("tenantId", "expiryDate");

-- CreateIndex
CREATE INDEX "payments_tenantId_counterpartyId_paymentDate_idx" ON "payments"("tenantId", "counterpartyId", "paymentDate");

-- CreateIndex
CREATE INDEX "payments_tenantId_status_paymentDate_idx" ON "payments"("tenantId", "status", "paymentDate");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_voucherNumber_key" ON "payments"("tenantId", "voucherNumber");

-- CreateIndex
CREATE INDEX "payment_allocations_tenantId_documentId_idx" ON "payment_allocations"("tenantId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_paymentId_documentId_key" ON "payment_allocations"("paymentId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statements_tenantId_accountId_statementRef_key" ON "bank_statements"("tenantId", "accountId", "statementRef");

-- CreateIndex
CREATE INDEX "bank_statement_lines_bankStatementId_valueDate_idx" ON "bank_statement_lines"("bankStatementId", "valueDate");

-- CreateIndex
CREATE INDEX "bank_statement_lines_matchedPaymentId_idx" ON "bank_statement_lines"("matchedPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenantId_code_key" ON "departments"("tenantId", "code");

-- CreateIndex
CREATE INDEX "employees_tenantId_departmentId_isActive_idx" ON "employees"("tenantId", "departmentId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenantId_employeeNumber_key" ON "employees"("tenantId", "employeeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenantId_year_month_key" ON "payroll_runs"("tenantId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_payrollRunId_employeeId_key" ON "payroll_lines"("payrollRunId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "approval_policies_tenantId_documentType_minAmount_key" ON "approval_policies"("tenantId", "documentType", "minAmount");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_policyId_stepNumber_key" ON "approval_steps"("policyId", "stepNumber");

-- CreateIndex
CREATE INDEX "approval_requests_tenantId_status_idx" ON "approval_requests"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_tenantId_entityType_entityId_key" ON "approval_requests"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "approval_actions_requestId_stepNumber_idx" ON "approval_actions"("requestId", "stepNumber");

-- CreateIndex
CREATE INDEX "fixed_assets_tenantId_isActive_idx" ON "fixed_assets"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_tenantId_assetNumber_key" ON "fixed_assets"("tenantId", "assetNumber");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_schedules_assetId_periodDate_key" ON "depreciation_schedules"("assetId", "periodDate");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_defaultBranchId_fkey" FOREIGN KEY ("defaultBranchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_defaultWarehouseId_fkey" FOREIGN KEY ("defaultWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "cost_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_fromCurrencyId_fkey" FOREIGN KEY ("fromCurrencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_toCurrencyId_fkey" FOREIGN KEY ("toCurrencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "fiscal_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journals" ADD CONSTRAINT "journals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journals" ADD CONSTRAINT "journals_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journals" ADD CONSTRAINT "journals_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journals" ADD CONSTRAINT "journals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journals" ADD CONSTRAINT "journals_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journalId_journalDate_fkey" FOREIGN KEY ("journalId", "journalDate") REFERENCES "journals"("id", "date") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "cost_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zatca_invoices" ADD CONSTRAINT "zatca_invoices_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_layers" ADD CONSTRAINT "cost_layers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_layers" ADD CONSTRAINT "cost_layers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_layers" ADD CONSTRAINT "cost_layers_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bankStatementId_fkey" FOREIGN KEY ("bankStatementId") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matchedPaymentId_fkey" FOREIGN KEY ("matchedPaymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "approval_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "approval_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_assetAccountId_fkey" FOREIGN KEY ("assetAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulatedAccountId_fkey" FOREIGN KEY ("accumulatedAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_schedules" ADD CONSTRAINT "depreciation_schedules_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "fixed_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

