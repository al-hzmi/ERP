import { DomainErrors, type DomainError } from './errors';
import { err, ok, type Result } from './result';

/**
 * Small, self-validating types for the identifiers that flow through the system.
 *
 * A `string` that has passed through `AccountCode.create` is provably a valid
 * account code. Keeping the check in the type's constructor means it happens
 * once, at the boundary, instead of being re-implemented at every call site and
 * forgotten at one of them.
 */

const ACCOUNT_CODE_PATTERN = /^[0-9]{1,6}(-[0-9]{1,4}){0,3}$/;
const SKU_PATTERN = /^[A-Z]{2,5}-[0-9]{3,6}$/;
const DOCUMENT_NUMBER_PATTERN = /^[A-Z]{2,4}-\d{4}-\d{4,8}$/;
/** ZATCA: 15 digits, first and last are 3, positions 11-13 encode the entity type. */
const VAT_NUMBER_PATTERN = /^3\d{13}3$/;

/** Hierarchical GL account code, e.g. `1201-001`. */
export class AccountCode {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static create(input: string): Result<AccountCode, DomainError> {
    const trimmed = input.trim();
    if (trimmed === '') {
      return err(DomainErrors.requiredField('رمز الحساب', 'account code', 'code'));
    }
    if (!ACCOUNT_CODE_PATTERN.test(trimmed)) {
      return err(
        DomainErrors.invalidFormat('رمز الحساب', 'account code', '1201-001', 'code'),
      );
    }
    return ok(new AccountCode(trimmed));
  }

  /** Segments of the code, parent-first: `1201-001` -> `['1201', '001']`. */
  get segments(): string[] {
    return this.value.split('-');
  }

  /** The code of the account directly above this one, or null at the root. */
  get parentCode(): string | null {
    const segments = this.segments;
    if (segments.length <= 1) return null;
    return segments.slice(0, -1).join('-');
  }

  get depth(): number {
    return this.segments.length;
  }

  toString(): string {
    return this.value;
  }
}

/** Stock keeping unit, e.g. `BTC-1001`. */
export class Sku {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static create(input: string): Result<Sku, DomainError> {
    const normalised = input.trim().toUpperCase();
    if (normalised === '') {
      return err(DomainErrors.requiredField('رمز الصنف', 'SKU', 'sku'));
    }
    if (!SKU_PATTERN.test(normalised)) {
      return err(DomainErrors.invalidFormat('رمز الصنف', 'SKU', 'BTC-1001', 'sku'));
    }
    return ok(new Sku(normalised));
  }

  /** The category prefix — `BTC` in `BTC-1001`. */
  get categoryPrefix(): string {
    return this.value.split('-')[0] ?? '';
  }

  /** The numeric portion, which is what users actually type when searching. */
  get serial(): string {
    return this.value.split('-')[1] ?? '';
  }

  toString(): string {
    return this.value;
  }
}

/** Sequential document number, e.g. `INV-2026-00001`. */
export class DocumentNumber {
  private constructor(
    readonly value: string,
    readonly prefix: string,
    readonly year: number,
    readonly sequence: number,
  ) {
    Object.freeze(this);
  }

  static create(input: string): Result<DocumentNumber, DomainError> {
    const normalised = input.trim().toUpperCase();
    if (!DOCUMENT_NUMBER_PATTERN.test(normalised)) {
      return err(
        DomainErrors.invalidFormat(
          'رقم المستند',
          'document number',
          'INV-2026-00001',
          'documentNumber',
        ),
      );
    }
    const [prefix, year, sequence] = normalised.split('-');
    return ok(
      new DocumentNumber(
        normalised,
        prefix ?? '',
        Number.parseInt(year ?? '0', 10),
        Number.parseInt(sequence ?? '0', 10),
      ),
    );
  }

  toString(): string {
    return this.value;
  }
}

/** ZATCA VAT registration number. */
export class VatNumber {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static create(input: string): Result<VatNumber, DomainError> {
    const digits = input.replace(/\s/g, '');
    if (!VAT_NUMBER_PATTERN.test(digits)) {
      return err(
        DomainErrors.invalidFormat(
          'الرقم الضريبي',
          'VAT number',
          '15 رقماً تبدأ وتنتهي بالرقم 3',
          'taxNumber',
        ),
      );
    }
    return ok(new VatNumber(digits));
  }

  toString(): string {
    return this.value;
  }
}

/**
 * A calendar date with no time and no zone.
 *
 * An invoice is dated "12 March", not "12 March 00:00 Riyadh" — encoding a zone
 * into a business date is how a document lands in the wrong fiscal period when
 * the server moves. This type stores the three components and nothing else.
 */
export class DateOnly {
  private constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
  ) {
    Object.freeze(this);
  }

  static create(input: string | Date): Result<DateOnly, DomainError> {
    if (input instanceof Date) {
      if (Number.isNaN(input.getTime())) {
        return err(DomainErrors.invalidDate(String(input), 'date'));
      }
      return ok(
        new DateOnly(input.getUTCFullYear(), input.getUTCMonth() + 1, input.getUTCDate()),
      );
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
    if (match === null) {
      return err(DomainErrors.invalidFormat('التاريخ', 'date', 'YYYY-MM-DD', 'date'));
    }

    const year = Number.parseInt(match[1] ?? '0', 10);
    const month = Number.parseInt(match[2] ?? '0', 10);
    const day = Number.parseInt(match[3] ?? '0', 10);

    if (!DateOnly.isRealDate(year, month, day)) {
      return err(DomainErrors.invalidDate(input, 'date'));
    }

    // A transaction dated in the far future is a typo, not a plan.
    const currentYear = new Date().getUTCFullYear();
    if (year < 1900 || year > currentYear + 5) {
      return err(
        DomainErrors.outOfRange('السنة', 'year', '1900', String(currentYear + 5), 'date'),
      );
    }

    return ok(new DateOnly(year, month, day));
  }

  /** Rejects 30 February and friends by round-tripping through the calendar. */
  private static isRealDate(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return (
      candidate.getUTCFullYear() === year &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day
    );
  }

  static today(): DateOnly {
    const now = new Date();
    return new DateOnly(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  }

  static fromDate(date: Date): DateOnly {
    return new DateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  /** Midnight UTC — the canonical instant for a PostgreSQL `DATE` column. */
  toDate(): Date {
    return new Date(Date.UTC(this.year, this.month - 1, this.day));
  }

  toString(): string {
    const month = String(this.month).padStart(2, '0');
    const day = String(this.day).padStart(2, '0');
    return `${this.year}-${month}-${day}`;
  }

  addDays(days: number): DateOnly {
    const shifted = new Date(this.toDate().getTime() + days * 86_400_000);
    return DateOnly.fromDate(shifted);
  }

  /** Adds calendar months, clamping to the end of a shorter month (31 Jan + 1m = 28/29 Feb). */
  addMonths(months: number): DateOnly {
    const totalMonths = this.year * 12 + (this.month - 1) + months;
    const year = Math.floor(totalMonths / 12);
    const month = (totalMonths % 12) + 1;
    const daysInTarget = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return new DateOnly(year, month, Math.min(this.day, daysInTarget));
  }

  compare(other: DateOnly): -1 | 0 | 1 {
    const left = this.toString();
    const right = other.toString();
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  isBefore(other: DateOnly): boolean {
    return this.compare(other) === -1;
  }

  isAfter(other: DateOnly): boolean {
    return this.compare(other) === 1;
  }

  equals(other: DateOnly): boolean {
    return this.compare(other) === 0;
  }

  toJSON(): string {
    return this.toString();
  }
}
