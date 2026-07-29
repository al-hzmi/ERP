-- ═════════════════════════════════════════════════════════════════════════════
--  Migration 003 — Contra accounts
--
--  Migration 002 asserted that an account's nature always follows its type:
--  assets and expenses are debits, everything else is a credit. That is true of
--  every ordinary account and false of an entire category of real ones.
--
--  Accumulated depreciation is an asset that carries a credit balance. Sales
--  returns and discounts allowed are revenue accounts that carry debit balances.
--  They are not liabilities or expenses — presenting them as such would move them
--  to the wrong side of the financial statements and misstate both gross revenue
--  and gross fixed assets.
--
--  The fix is to name the exception rather than to remove the rule: an account
--  may invert its natural side only when it is explicitly flagged as contra.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "accounts" ADD COLUMN "isContra" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "accounts"."isContra" IS
  'Account carries the opposite nature to its type (e.g. accumulated depreciation, sales returns).';

ALTER TABLE "accounts" DROP CONSTRAINT "accounts_nature_matches_type";

ALTER TABLE "accounts"
    ADD CONSTRAINT "accounts_nature_matches_type" CHECK (
        -- Ordinary accounts: nature is dictated by type.
        (NOT "isContra" AND (
            ("type" IN ('ASSET', 'EXPENSE')                 AND "nature" = 'DEBIT') OR
            ("type" IN ('LIABILITY', 'EQUITY', 'REVENUE')   AND "nature" = 'CREDIT')
        ))
        OR
        -- Contra accounts: nature is exactly inverted, never arbitrary.
        ("isContra" AND (
            ("type" IN ('ASSET', 'EXPENSE')                 AND "nature" = 'CREDIT') OR
            ("type" IN ('LIABILITY', 'EQUITY', 'REVENUE')   AND "nature" = 'DEBIT')
        ))
    );

-- Contra accounts are ordinary postable leaves; they are simply presented as a
-- deduction from their sibling. Indexing them separately keeps the statement
-- builder's "gross vs net" queries off a sequential scan.
CREATE INDEX "accounts_contra_idx" ON "accounts" ("tenantId", "type") WHERE "isContra";
