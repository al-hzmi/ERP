import { describe, expect, it } from 'vitest';
import { buildQrPayload, parseQrPayload } from '@/lib/domain/zatca/zatca-crypto';
import { Money } from '@/lib/domain/shared/money';
import { unwrap } from '@/lib/domain/shared/result';
import {
  AccountCode,
  DateOnly,
  DocumentNumber,
  Sku,
  VatNumber,
} from '@/lib/domain/shared/value-objects';
import { JournalEntryDraft } from '@/lib/domain/accounting/journal-entry';

describe('ZATCA QR payload', () => {
  const input = {
    sellerName: 'شركة الأفق المتحدة للتجارة',
    sellerVatNumber: '300000000000003',
    timestamp: new Date('2026-03-15T09:30:00.000Z'),
    invoiceTotal: '1150.00',
    vatTotal: '150.00',
  };

  it('round-trips through TLV encoding', () => {
    const fields = parseQrPayload(buildQrPayload(input));

    expect(fields).toHaveLength(5);
    expect(fields[0]?.text).toBe(input.sellerName);
    expect(fields[1]?.text).toBe('300000000000003');
    expect(fields[3]?.text).toBe('1150.00');
    expect(fields[4]?.text).toBe('150.00');
  });

  it('writes the timestamp without milliseconds', () => {
    // `toISOString()` emits `.000Z`, and the ZATCA validator rejects it. A one-character
    // difference that costs a whole submission round trip to discover.
    const fields = parseQrPayload(buildQrPayload(input));
    expect(fields[2]?.text).toBe('2026-03-15T09:30:00Z');
  });

  it('encodes the length in BYTES, not characters', () => {
    // The Arabic seller name is 26 characters but 47 UTF-8 bytes. Writing the
    // character count into the length byte is the single most common reason a
    // QR code fails ZATCA validation while looking perfectly fine.
    const buffer = Buffer.from(buildQrPayload(input), 'base64');
    const declaredLength = buffer.readUInt8(1);
    expect(declaredLength).toBe(Buffer.byteLength(input.sellerName, 'utf8'));
    expect(declaredLength).not.toBe(input.sellerName.length);
  });

  it('carries the invoice hash as Base64, not hex', () => {
    // Tag 6 is the Base64 of the 32 digest bytes — 44 characters. Putting the 64-character
    // hex string in instead is accepted by every JSON parser and rejected by ZATCA.
    const hex = 'a'.repeat(64);
    const fields = parseQrPayload(buildQrPayload({ ...input, invoiceHashHex: hex }));
    expect(fields).toHaveLength(6);
    expect(fields[5]?.tag).toBe(6);
    expect(fields[5]?.text).toBe(Buffer.from(hex, 'hex').toString('base64'));
    expect(fields[5]?.text).not.toBe(hex);
  });

  it('truncates an over-long field on a character boundary', () => {
    // A single TLV length byte caps a field at 255 bytes. Cutting mid-character
    // would emit invalid UTF-8.
    const long = { ...input, sellerName: 'م'.repeat(400) };
    const fields = parseQrPayload(buildQrPayload(long));
    const name = fields[0]?.text ?? '';
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255);
    expect(name).not.toContain('\uFFFD');
  });

  it('omits tags 7 to 9 entirely when the invoice is unsigned', () => {
    // An empty tag 7 is a claim that the invoice is signed. Absent is the truthful encoding.
    const fields = parseQrPayload(buildQrPayload({ ...input, invoiceHashHex: 'b'.repeat(64) }));
    expect(fields.map((field) => field.tag)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('produces valid Base64', () => {
    const payload = buildQrPayload(input);
    expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});

describe('AccountCode', () => {
  it('accepts hierarchical codes and derives the parent', () => {
    const code = unwrap(AccountCode.create('1201-001'));
    expect(code.value).toBe('1201-001');
    expect(code.parentCode).toBe('1201');
    expect(code.depth).toBe(2);
  });

  it('reports no parent at the root', () => {
    expect(unwrap(AccountCode.create('1')).parentCode).toBeNull();
  });

  it('rejects malformed codes', () => {
    expect(AccountCode.create('').ok).toBe(false);
    expect(AccountCode.create('ABC').ok).toBe(false);
    expect(AccountCode.create('1201_001').ok).toBe(false);
  });
});

describe('Sku', () => {
  it('normalises to upper case and splits the parts', () => {
    const sku = unwrap(Sku.create('btc-1001'));
    expect(sku.value).toBe('BTC-1001');
    expect(sku.categoryPrefix).toBe('BTC');
    expect(sku.serial).toBe('1001');
  });

  it('rejects a SKU without the category prefix', () => {
    expect(Sku.create('1001').ok).toBe(false);
  });
});

describe('DocumentNumber', () => {
  it('parses its parts', () => {
    const number = unwrap(DocumentNumber.create('INV-2026-00001'));
    expect(number.prefix).toBe('INV');
    expect(number.year).toBe(2026);
    expect(number.sequence).toBe(1);
  });

  it('rejects a malformed number', () => {
    expect(DocumentNumber.create('INV/2026/1').ok).toBe(false);
  });
});

describe('VatNumber', () => {
  it('accepts a well-formed ZATCA number', () => {
    expect(VatNumber.create('300000000000003').ok).toBe(true);
  });

  it('rejects one that does not start and end with 3', () => {
    expect(VatNumber.create('100000000000001').ok).toBe(false);
  });

  it('rejects one of the wrong length', () => {
    expect(VatNumber.create('30000000003').ok).toBe(false);
  });
});

describe('DateOnly', () => {
  it('parses an ISO date', () => {
    const date = unwrap(DateOnly.create('2026-03-15'));
    expect(date.year).toBe(2026);
    expect(date.month).toBe(3);
    expect(date.day).toBe(15);
    expect(date.toString()).toBe('2026-03-15');
  });

  it('rejects 30 February', () => {
    const result = DateOnly.create('2026-02-30');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_DATE');
  });

  it('accepts 29 February in a leap year and rejects it otherwise', () => {
    expect(DateOnly.create('2028-02-29').ok).toBe(true);
    expect(DateOnly.create('2026-02-29').ok).toBe(false);
  });

  it('rejects a date implausibly far in the future', () => {
    expect(DateOnly.create('2999-01-01').ok).toBe(false);
  });

  it('rejects a malformed string', () => {
    expect(DateOnly.create('15/03/2026').ok).toBe(false);
    expect(DateOnly.create('2026-3-5').ok).toBe(false);
  });

  it('adds days across a month boundary', () => {
    expect(unwrap(DateOnly.create('2026-01-30')).addDays(5).toString()).toBe('2026-02-04');
  });

  it('clamps when adding months into a shorter month', () => {
    // 31 January + 1 month is 28 February, not 3 March.
    expect(unwrap(DateOnly.create('2026-01-31')).addMonths(1).toString()).toBe('2026-02-28');
    expect(unwrap(DateOnly.create('2028-01-31')).addMonths(1).toString()).toBe('2028-02-29');
  });

  it('compares chronologically', () => {
    const earlier = unwrap(DateOnly.create('2026-01-01'));
    const later = unwrap(DateOnly.create('2026-12-31'));
    expect(earlier.isBefore(later)).toBe(true);
    expect(later.isAfter(earlier)).toBe(true);
    expect(earlier.equals(earlier)).toBe(true);
  });

  it('has no timezone, so a business date cannot drift', () => {
    // Constructed from an instant late in the UTC day; the calendar date must
    // still be that day, whatever the server's local zone happens to be.
    const date = DateOnly.fromDate(new Date('2026-03-15T23:59:00.000Z'));
    expect(date.toString()).toBe('2026-03-15');
  });
});

describe('JournalEntryDraft', () => {
  const base = {
    tenantId: 'tenant-1',
    type: 'GENERAL' as const,
    date: unwrap(DateOnly.create('2026-03-15')),
    descriptionAr: 'قيد اختبار',
    currency: 'SAR',
    exchangeRate: '1',
    functionalCurrency: 'SAR',
  };

  it('refuses an entry with no lines', () => {
    const result = new JournalEntryDraft(base).validate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EMPTY_DOCUMENT');
  });

  it('refuses a one-sided entry', () => {
    const draft = new JournalEntryDraft(base);
    draft.debit('acct-1', Money.of('100', 'SAR'));
    const result = draft.validate();
    expect(result.ok).toBe(false);
  });

  it('refuses an entry out of balance by one halala', () => {
    const draft = new JournalEntryDraft(base);
    draft.debit('acct-1', Money.of('100.00', 'SAR'));
    draft.credit('acct-2', Money.of('99.99', 'SAR'));

    const result = draft.validate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNBALANCED_ENTRY');
  });

  it('accepts a balanced entry', () => {
    const draft = new JournalEntryDraft(base);
    draft.debit('acct-1', Money.of('100', 'SAR'));
    draft.credit('acct-2', Money.of('100', 'SAR'));
    expect(draft.validate().ok).toBe(true);
  });

  it('ignores zero-value lines rather than persisting noise', () => {
    const draft = new JournalEntryDraft(base);
    draft.debit('acct-1', Money.of('100', 'SAR'));
    draft.debit('acct-3', Money.zero('SAR'));
    draft.credit('acct-2', Money.of('100', 'SAR'));
    expect(draft.lineCount).toBe(2);
  });

  it('normalises a negative debit into a credit', () => {
    const draft = new JournalEntryDraft(base);
    draft.debit('acct-1', Money.of('-100', 'SAR'));
    draft.debit('acct-2', Money.of('100', 'SAR'));

    const entry = unwrap(draft.validate());
    expect(entry.lines.find((line) => line.accountId === 'acct-1')?.credit.toFixed(2)).toBe('100.00');
  });

  it('compacts repeated postings to the same account', () => {
    const draft = new JournalEntryDraft(base);
    draft.debit('acct-1', Money.of('60', 'SAR'));
    draft.debit('acct-1', Money.of('40', 'SAR'));
    draft.credit('acct-2', Money.of('100', 'SAR'));

    draft.compact();
    const entry = unwrap(draft.validate());

    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.find((line) => line.accountId === 'acct-1')?.debit.toFixed(2)).toBe('100.00');
  });

  it('nets an account that received both a debit and a credit', () => {
    const draft = new JournalEntryDraft(base);
    draft.debit('acct-1', Money.of('150', 'SAR'));
    draft.credit('acct-1', Money.of('50', 'SAR'));
    draft.credit('acct-2', Money.of('100', 'SAR'));

    draft.compact();
    const entry = unwrap(draft.validate());

    const netted = entry.lines.find((line) => line.accountId === 'acct-1');
    expect(netted?.debit.toFixed(2)).toBe('100.00');
    expect(netted?.credit.isZero).toBe(true);
  });

  it('produces a reversal that mirrors every line', () => {
    const draft = new JournalEntryDraft(base);
    draft.debit('acct-1', Money.of('100', 'SAR'));
    draft.credit('acct-2', Money.of('100', 'SAR'));

    const reversal = draft.reverse(
      unwrap(DateOnly.create('2026-04-01')),
      'عكس القيد',
    );
    const entry = unwrap(reversal.validate());

    expect(entry.lines.find((line) => line.accountId === 'acct-1')?.credit.toFixed(2)).toBe('100.00');
    expect(entry.lines.find((line) => line.accountId === 'acct-2')?.debit.toFixed(2)).toBe('100.00');
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
  });
});
