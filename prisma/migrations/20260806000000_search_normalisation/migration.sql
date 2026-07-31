-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 012 — Search normalisation.
--
-- No tables. One function, and the expression indexes that make it usable.
--
-- ## The problem, measured
--
-- Against the seeded demo company, every one of these returned nothing:
--
--   ١٠٣٨      → 0 rows   (the product is BTC-1038)
--   BTC1038   → 0 rows   (the separator is a house style nobody types)
--   الصفوه    → 0 rows   (16 counterparties are spelled الصفوة)
--   الافق     → 0 rows   (12 are spelled الأفق)
--
-- The first is self-inflicted: `formatMoney` and `formatQuantity` render digits in
-- Arabic-Indic, so the application prints codes that its own search cannot find. Someone
-- reading `BTC-١٠٣٨` off a report and typing it into the search box got an empty list.
--
-- ## Why a function and not generated columns
--
-- Generated columns would need one per searchable field across five tables — eleven columns,
-- eleven backfills, and a schema Prisma cannot express (it has no `GENERATED ALWAYS AS`), so
-- they would sit outside `schema.prisma` like the two tsvector columns migration 2 added.
--
-- An IMMUTABLE function plus expression indexes gets the same index usage with none of that:
-- `CREATE INDEX ... ON products (erp_normalize_search("sku"))` is a real index that the
-- planner uses whenever the query says `erp_normalize_search("sku")`. The function has to be
-- genuinely immutable for that to be allowed, which it is — it is a fixed chain of
-- `translate` and `regexp_replace` with no clock, no locale, no lookup.
--
-- ## This function has a twin in TypeScript
--
-- `src/lib/search/normalize.ts` applies the same rules, because the *term* is normalised in
-- the application and the *column* is normalised here. Two implementations of one rule set
-- drift, so `tests/integration/search-normalisation.test.ts` runs a table of cases through
-- both and asserts they agree character for character. Editing one without the other fails.
-- ─────────────────────────────────────────────────────────────────────────────

-- `translate` rather than a chain of `replace`: one pass, and the mapping reads as the table
-- it is. The two arguments must stay the same length — every source character needs its
-- replacement — which is why the digits are spelled out twice rather than given as ranges.
CREATE OR REPLACE FUNCTION erp_normalize_search(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
    SELECT lower(
      regexp_replace(
        translate(
          input,
          -- Arabic-Indic digits (U+0660) and Eastern Arabic-Indic digits (U+06F0).
          '٠١٢٣٤٥٦٧٨٩' || '۰۱۲۳۴۵۶۷۸۹' ||
          -- Hamza carriers → bare alif.
          'أإآٱ' ||
          -- Ta marbuta → ha; alif maqsura → ya; hamza on waw/ya → carrier.
          'ةىؤئ' ||
          -- Farsi keyboard forms that land in Arabic text and look identical.
          'کی',
          '0123456789' || '0123456789' ||
          'اااا' ||
          'هيوي' ||
          'كي'
        ),
        -- Harakat, tanwin, shadda, sukun, and the tatweel that only stretches a glyph.
        -- Applied after `translate` so a hamza carrying a fatha folds like a bare one.
        '[ً-ْٰـ]', '', 'g'
      )
    );
$$;

COMMENT ON FUNCTION erp_normalize_search(TEXT) IS
    'Folds Arabic-Indic digits, hamza carriers, ta marbuta and alif maqsura so that a term '
    'typed the way a user types it matches the way the data was entered. Twin of '
    'src/lib/search/normalize.ts — the two are asserted equal in the integration suite.';

-- The code form: normalised, then everything that is not a letter or digit removed, so
-- `BTC1038` and `btc-1038` both reach `BTC-1038`.
--
-- Kept separate from the above on purpose: stripping punctuation out of a *name* would join
-- words that are meant to stay apart, and `شركة الصفوة` would stop matching either half.
CREATE OR REPLACE FUNCTION erp_compact_code(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
    SELECT regexp_replace(erp_normalize_search(input), '[^[:alnum:]]+', '', 'g');
$$;

COMMENT ON FUNCTION erp_compact_code(TEXT) IS
    'erp_normalize_search with separators removed, for matching codes whose punctuation is a '
    'house style the user does not type.';

-- ── Expression indexes ───────────────────────────────────────────────────────
--
-- `gin_trgm_ops`, matching what migration 2 installed for the raw columns: the searches are
-- `ILIKE '%term%'`, and a leading wildcard is a sequential scan without a trigram index.
--
-- Only the columns the search service actually reads. An index on a column nothing queries is
-- write cost for no read benefit, and this schema already carries enough of them.

CREATE INDEX IF NOT EXISTS "products_sku_normalised_trgm_idx"
    ON "products" USING gin (erp_compact_code("sku") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "products_nameAr_normalised_trgm_idx"
    ON "products" USING gin (erp_normalize_search("nameAr") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "products_nameEn_normalised_trgm_idx"
    ON "products" USING gin (erp_normalize_search("nameEn") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "counterparties_code_normalised_trgm_idx"
    ON "counterparties" USING gin (erp_compact_code("code") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "counterparties_nameAr_normalised_trgm_idx"
    ON "counterparties" USING gin (erp_normalize_search("nameAr") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "counterparties_nameEn_normalised_trgm_idx"
    ON "counterparties" USING gin (erp_normalize_search("nameEn") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "accounts_code_normalised_trgm_idx"
    ON "accounts" USING gin (erp_compact_code("code") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "accounts_nameAr_normalised_trgm_idx"
    ON "accounts" USING gin (erp_normalize_search("nameAr") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "documents_number_normalised_trgm_idx"
    ON "documents" USING gin (erp_compact_code("documentNumber") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "employees_number_normalised_trgm_idx"
    ON "employees" USING gin (erp_compact_code("employeeNumber") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "employees_nameAr_normalised_trgm_idx"
    ON "employees" USING gin (erp_normalize_search("fullNameAr") gin_trgm_ops);

-- ── Proof ────────────────────────────────────────────────────────────────────
--
-- The four queries this migration exists for, asserted at deploy time against whatever data
-- is present. They are written to pass on an empty database — the point is that the
-- *normalised forms agree*, not that any particular row exists.

DO $$
DECLARE
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    -- Arabic-Indic digits fold to Western ones.
    IF erp_normalize_search('BTC-١٠٣٨') <> 'btc-1038' THEN
        v_failures := v_failures || ('Arabic-Indic digits: got ' || erp_normalize_search('BTC-١٠٣٨'));
    END IF;

    -- Separators drop out of the code form.
    IF erp_compact_code('BTC-1038') <> 'btc1038' THEN
        v_failures := v_failures || ('compact code: got ' || erp_compact_code('BTC-1038'));
    END IF;

    -- Ta marbuta and hamza fold, so the two spellings meet.
    IF erp_normalize_search('الصفوة') <> erp_normalize_search('الصفوه') THEN
        v_failures := v_failures || 'ta marbuta does not fold';
    END IF;

    IF erp_normalize_search('الأفق') <> erp_normalize_search('الافق') THEN
        v_failures := v_failures || 'hamza does not fold';
    END IF;

    -- A diacritic must not change the result.
    IF erp_normalize_search('مُحَمَّد') <> erp_normalize_search('محمد') THEN
        v_failures := v_failures || 'diacritics are not stripped';
    END IF;

    -- And the function must really be immutable, or the indexes above are not allowed.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'erp_normalize_search' AND provolatile = 'i'
    ) THEN
        v_failures := v_failures || 'erp_normalize_search is not IMMUTABLE';
    END IF;

    IF array_length(v_failures, 1) > 0 THEN
        RAISE EXCEPTION 'Search normalisation is wrong — %', array_to_string(v_failures, '; ');
    END IF;
END;
$$;
