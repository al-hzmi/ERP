/**
 * The domain's failure vocabulary.
 *
 * Every business rule that can refuse an operation has a stable code and a
 * message in both Arabic and English. The API layer serialises these directly:
 * the user sees a sentence written by the domain expert who wrote the rule, and
 * never a stack trace, an ORM message or a constraint name.
 */

export type ErrorCode =
  // ── Validation ───────────────────────────────────────────────────────────
  | 'VALIDATION_FAILED'
  | 'REQUIRED_FIELD_MISSING'
  | 'INVALID_FORMAT'
  | 'VALUE_OUT_OF_RANGE'
  | 'INVALID_DATE'
  // ── Access control ───────────────────────────────────────────────────────
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'SOD_VIOLATION'
  | 'APPROVAL_REQUIRED'
  | 'TENANT_MISMATCH'
  // ── Lifecycle ────────────────────────────────────────────────────────────
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_STATE_TRANSITION'
  | 'DOCUMENT_ALREADY_POSTED'
  | 'DOCUMENT_VOIDED'
  | 'CONCURRENT_MODIFICATION'
  // ── Accounting ───────────────────────────────────────────────────────────
  | 'UNBALANCED_ENTRY'
  | 'EMPTY_DOCUMENT'
  | 'ACCOUNT_NOT_POSTABLE'
  | 'ACCOUNT_INACTIVE'
  | 'FISCAL_PERIOD_CLOSED'
  | 'CURRENCY_MISMATCH'
  | 'EXCHANGE_RATE_REQUIRED'
  | 'ACCOUNT_MAPPING_MISSING'
  // ── Inventory ────────────────────────────────────────────────────────────
  | 'INSUFFICIENT_STOCK'
  | 'EXPIRED_BATCH'
  | 'SAME_WAREHOUSE_TRANSFER'
  | 'NON_STOCK_ITEM'
  | 'BATCH_REQUIRED'
  | 'SERIAL_REQUIRED'
  // ── Treasury ─────────────────────────────────────────────────────────────
  | 'OVERPAYMENT_NOT_ALLOWED'
  | 'CREDIT_LIMIT_EXCEEDED'
  | 'PAYMENT_ALREADY_ALLOCATED'
  // ── Infrastructure ───────────────────────────────────────────────────────
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

/** HTTP status each code maps to. Kept beside the codes so the two never drift. */
const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  REQUIRED_FIELD_MISSING: 422,
  INVALID_FORMAT: 422,
  VALUE_OUT_OF_RANGE: 422,
  INVALID_DATE: 422,

  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  SOD_VIOLATION: 403,
  APPROVAL_REQUIRED: 403,
  TENANT_MISMATCH: 403,

  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  INVALID_STATE_TRANSITION: 409,
  DOCUMENT_ALREADY_POSTED: 409,
  DOCUMENT_VOIDED: 409,
  CONCURRENT_MODIFICATION: 409,

  UNBALANCED_ENTRY: 422,
  EMPTY_DOCUMENT: 422,
  ACCOUNT_NOT_POSTABLE: 422,
  ACCOUNT_INACTIVE: 422,
  FISCAL_PERIOD_CLOSED: 409,
  CURRENCY_MISMATCH: 422,
  EXCHANGE_RATE_REQUIRED: 422,
  ACCOUNT_MAPPING_MISSING: 500,

  INSUFFICIENT_STOCK: 409,
  EXPIRED_BATCH: 409,
  SAME_WAREHOUSE_TRANSFER: 422,
  NON_STOCK_ITEM: 422,
  BATCH_REQUIRED: 422,
  SERIAL_REQUIRED: 422,

  OVERPAYMENT_NOT_ALLOWED: 409,
  CREDIT_LIMIT_EXCEEDED: 409,
  PAYMENT_ALREADY_ALLOCATED: 409,

  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/** Structured, non-sensitive context attached to an error for the client. */
export type ErrorDetails = Record<string, string | number | boolean | null>;

/**
 * A business rule refusal.
 *
 * Not an `Error` subclass by design — these are returned as values inside a
 * `Result`, and making them throwable invites `throw` where a return belongs.
 */
export class DomainError {
  readonly name = 'DomainError';

  constructor(
    readonly code: ErrorCode,
    readonly messageAr: string,
    readonly messageEn: string,
    readonly details?: ErrorDetails,
    /** The field a form should highlight, when the failure is field-specific. */
    readonly field?: string,
  ) {
    Object.freeze(this);
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  message(locale: 'ar' | 'en'): string {
    return locale === 'ar' ? this.messageAr : this.messageEn;
  }

  /** The exact shape the API contract promises for a failure. */
  toJSON(): {
    code: ErrorCode;
    message: string;
    messageAr: string;
    messageEn: string;
    field?: string;
    details?: ErrorDetails;
  } {
    return {
      code: this.code,
      message: this.messageAr,
      messageAr: this.messageAr,
      messageEn: this.messageEn,
      ...(this.field !== undefined ? { field: this.field } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/**
 * Named constructors for every refusal the domain can issue.
 *
 * Centralising the wording here means a rule's message is written once, reviewed
 * once, and reads identically wherever it surfaces — API, form, or audit log.
 */
export const DomainErrors = {
  validation(messageAr: string, messageEn: string, field?: string, details?: ErrorDetails) {
    return new DomainError('VALIDATION_FAILED', messageAr, messageEn, details, field);
  },

  requiredField(fieldAr: string, fieldEn: string, field: string) {
    return new DomainError(
      'REQUIRED_FIELD_MISSING',
      `الحقل "${fieldAr}" مطلوب.`,
      `The field "${fieldEn}" is required.`,
      undefined,
      field,
    );
  },

  invalidFormat(fieldAr: string, fieldEn: string, expected: string, field: string) {
    return new DomainError(
      'INVALID_FORMAT',
      `صيغة الحقل "${fieldAr}" غير صحيحة. الصيغة المتوقعة: ${expected}`,
      `The field "${fieldEn}" has an invalid format. Expected: ${expected}`,
      { expected },
      field,
    );
  },

  outOfRange(fieldAr: string, fieldEn: string, min: string, max: string, field: string) {
    return new DomainError(
      'VALUE_OUT_OF_RANGE',
      `قيمة الحقل "${fieldAr}" يجب أن تكون بين ${min} و ${max}.`,
      `The field "${fieldEn}" must be between ${min} and ${max}.`,
      { min, max },
      field,
    );
  },

  invalidDate(value: string, field: string) {
    return new DomainError(
      'INVALID_DATE',
      `التاريخ "${value}" غير صالح.`,
      `The date "${value}" is not valid.`,
      { value },
      field,
    );
  },

  unauthenticated() {
    return new DomainError(
      'UNAUTHENTICATED',
      'يجب تسجيل الدخول للمتابعة.',
      'You must sign in to continue.',
    );
  },

  permissionDenied(actionAr: string, actionEn: string, resourceAr: string, resourceEn: string) {
    return new DomainError(
      'PERMISSION_DENIED',
      `ليس لديك صلاحية "${actionAr}" على "${resourceAr}".`,
      `You do not have permission to ${actionEn} ${resourceEn}.`,
      { action: actionEn, resource: resourceEn },
    );
  },

  sodViolation(conflictAr: string, conflictEn: string) {
    return new DomainError(
      'SOD_VIOLATION',
      `هذه العملية تتطلب موافقة مستخدم آخر: ${conflictAr}`,
      `This operation requires a different user: ${conflictEn}`,
      { conflict: conflictEn },
    );
  },

  approvalRequired(documentNumber: string) {
    return new DomainError(
      'APPROVAL_REQUIRED',
      `المستند ${documentNumber} يتطلب اعتماداً قبل الترحيل.`,
      `Document ${documentNumber} requires approval before it can be posted.`,
      { documentNumber },
    );
  },

  tenantMismatch() {
    return new DomainError(
      'TENANT_MISMATCH',
      'لا يمكن الوصول إلى بيانات منشأة أخرى.',
      'Cross-tenant access is not permitted.',
    );
  },

  notFound(entityAr: string, entityEn: string, identifier: string) {
    return new DomainError(
      'NOT_FOUND',
      `${entityAr} "${identifier}" غير موجود.`,
      `${entityEn} "${identifier}" was not found.`,
      { identifier },
    );
  },

  alreadyExists(entityAr: string, entityEn: string, identifier: string, field?: string) {
    return new DomainError(
      'ALREADY_EXISTS',
      `${entityAr} بالرقم "${identifier}" مستخدم بالفعل.`,
      `${entityEn} "${identifier}" is already in use.`,
      { identifier },
      field,
    );
  },

  invalidTransition(fromState: string, toState: string, entityAr: string, entityEn: string) {
    return new DomainError(
      'INVALID_STATE_TRANSITION',
      `لا يمكن تغيير حالة ${entityAr} من "${fromState}" إلى "${toState}".`,
      `Cannot move ${entityEn} from "${fromState}" to "${toState}".`,
      { fromState, toState },
    );
  },

  documentAlreadyPosted(documentNumber: string) {
    return new DomainError(
      'DOCUMENT_ALREADY_POSTED',
      `المستند ${documentNumber} مُرحّل ولا يمكن تعديله أو حذفه. أنشئ إشعاراً دائناً/مديناً للتصحيح.`,
      `Document ${documentNumber} is posted and cannot be modified or deleted. Issue a credit or debit note to correct it.`,
      { documentNumber },
    );
  },

  documentVoided(documentNumber: string) {
    return new DomainError(
      'DOCUMENT_VOIDED',
      `المستند ${documentNumber} ملغى ولا يمكن استخدامه.`,
      `Document ${documentNumber} is void and cannot be used.`,
      { documentNumber },
    );
  },

  concurrentModification(entityAr: string, entityEn: string) {
    return new DomainError(
      'CONCURRENT_MODIFICATION',
      `تم تعديل ${entityAr} بواسطة مستخدم آخر. يرجى إعادة التحميل والمحاولة مرة أخرى.`,
      `${entityEn} was modified by another user. Please reload and try again.`,
    );
  },

  unbalancedEntry(totalDebit: string, totalCredit: string) {
    const difference = 'الفرق';
    return new DomainError(
      'UNBALANCED_ENTRY',
      `القيد غير متوازن: إجمالي المدين ${totalDebit} لا يساوي إجمالي الدائن ${totalCredit}. ${difference} يجب أن يكون صفراً.`,
      `The entry is out of balance: total debit ${totalDebit} does not equal total credit ${totalCredit}.`,
      { totalDebit, totalCredit },
    );
  },

  emptyDocument(entityAr: string, entityEn: string) {
    return new DomainError(
      'EMPTY_DOCUMENT',
      `لا يمكن حفظ ${entityAr} بدون بنود.`,
      `${entityEn} cannot be saved without any lines.`,
    );
  },

  accountNotPostable(code: string, nameAr: string, nameEn: string) {
    return new DomainError(
      'ACCOUNT_NOT_POSTABLE',
      `الحساب ${code} - ${nameAr} حساب تجميعي ولا يمكن الترحيل إليه مباشرة.`,
      `Account ${code} - ${nameEn} is a summary account and cannot be posted to directly.`,
      { code },
    );
  },

  accountInactive(code: string, nameAr: string, nameEn: string) {
    return new DomainError(
      'ACCOUNT_INACTIVE',
      `الحساب ${code} - ${nameAr} غير نشط.`,
      `Account ${code} - ${nameEn} is inactive.`,
      { code },
    );
  },

  fiscalPeriodClosed(date: string) {
    return new DomainError(
      'FISCAL_PERIOD_CLOSED',
      `الفترة المحاسبية للتاريخ ${date} مقفلة ولا يمكن الترحيل إليها.`,
      `The fiscal period covering ${date} is closed; no entries may be posted to it.`,
      { date },
    );
  },

  currencyMismatch(expected: string, received: string) {
    return new DomainError(
      'CURRENCY_MISMATCH',
      `عملة العملية (${received}) لا تطابق العملة المتوقعة (${expected}).`,
      `The transaction currency (${received}) does not match the expected currency (${expected}).`,
      { expected, received },
    );
  },

  exchangeRateRequired(currency: string, functionalCurrency: string) {
    return new DomainError(
      'EXCHANGE_RATE_REQUIRED',
      `يجب إدخال سعر الصرف لتحويل ${currency} إلى ${functionalCurrency}.`,
      `An exchange rate is required to convert ${currency} to ${functionalCurrency}.`,
      { currency, functionalCurrency },
      'exchangeRate',
    );
  },

  accountMappingMissing(key: string) {
    return new DomainError(
      'ACCOUNT_MAPPING_MISSING',
      `لم يتم تعريف الحساب المرتبط بـ "${key}" في إعدادات النظام. يرجى مراجعة إعدادات الربط المحاسبي.`,
      `No GL account is mapped for "${key}". Please review the accounting configuration.`,
      { key },
    );
  },

  insufficientStock(
    requested: string,
    available: string,
    productAr: string,
    productEn: string,
    warehouseAr: string,
    warehouseEn: string,
  ) {
    return new DomainError(
      'INSUFFICIENT_STOCK',
      `الكمية المطلوبة (${requested}) من "${productAr}" تتجاوز الرصيد المتاح (${available}) في المستودع "${warehouseAr}".`,
      `The requested quantity (${requested}) of "${productEn}" exceeds the available balance (${available}) in warehouse "${warehouseEn}".`,
      { requested, available, product: productEn, warehouse: warehouseEn },
      'quantity',
    );
  },

  expiredBatch(batchNumber: string, expiryDate: string, productAr: string, productEn: string) {
    return new DomainError(
      'EXPIRED_BATCH',
      `الدفعة "${batchNumber}" من "${productAr}" منتهية الصلاحية بتاريخ ${expiryDate} ولا يمكن صرفها.`,
      `Batch "${batchNumber}" of "${productEn}" expired on ${expiryDate} and cannot be issued.`,
      { batchNumber, expiryDate },
      'batchNumber',
    );
  },

  sameWarehouseTransfer() {
    return new DomainError(
      'SAME_WAREHOUSE_TRANSFER',
      'لا يمكن التحويل لنفس المستودع. يرجى اختيار مستودع وجهة مختلف.',
      'Cannot transfer to the same warehouse. Please choose a different destination.',
      undefined,
      'toWarehouseId',
    );
  },

  nonStockItem(sku: string, nameAr: string, nameEn: string) {
    return new DomainError(
      'NON_STOCK_ITEM',
      `الصنف ${sku} - ${nameAr} خدمة ولا يخضع لحركة المخزون.`,
      `Item ${sku} - ${nameEn} is a service and is not stock-tracked.`,
      { sku },
    );
  },

  batchRequired(sku: string, nameAr: string, nameEn: string) {
    return new DomainError(
      'BATCH_REQUIRED',
      `الصنف ${sku} - ${nameAr} يتطلب تحديد رقم الدفعة.`,
      `Item ${sku} - ${nameEn} requires a batch number.`,
      { sku },
      'batchNumber',
    );
  },

  serialRequired(sku: string, nameAr: string, nameEn: string) {
    return new DomainError(
      'SERIAL_REQUIRED',
      `الصنف ${sku} - ${nameAr} يتطلب تحديد الرقم التسلسلي.`,
      `Item ${sku} - ${nameEn} requires a serial number.`,
      { sku },
      'serialNumber',
    );
  },

  overpaymentNotAllowed(amount: string, outstanding: string, documentNumber: string) {
    return new DomainError(
      'OVERPAYMENT_NOT_ALLOWED',
      `المبلغ ${amount} يتجاوز الرصيد المستحق ${outstanding} على المستند ${documentNumber}.`,
      `The amount ${amount} exceeds the outstanding balance of ${outstanding} on document ${documentNumber}.`,
      { amount, outstanding, documentNumber },
      'amount',
    );
  },

  creditLimitExceeded(
    counterpartyAr: string,
    counterpartyEn: string,
    limit: string,
    projected: string,
  ) {
    return new DomainError(
      'CREDIT_LIMIT_EXCEEDED',
      `هذه الفاتورة ترفع رصيد "${counterpartyAr}" إلى ${projected}، وهو يتجاوز الحد الائتماني ${limit}.`,
      `This invoice would raise the balance of "${counterpartyEn}" to ${projected}, exceeding the credit limit of ${limit}.`,
      { limit, projected },
    );
  },

  paymentAlreadyAllocated(voucherNumber: string) {
    return new DomainError(
      'PAYMENT_ALREADY_ALLOCATED',
      `السند ${voucherNumber} مخصص بالكامل بالفعل.`,
      `Voucher ${voucherNumber} is already fully allocated.`,
      { voucherNumber },
    );
  },

  rateLimited(retryAfterSeconds: number) {
    return new DomainError(
      'RATE_LIMITED',
      `تم تجاوز عدد الطلبات المسموح به. يرجى المحاولة بعد ${retryAfterSeconds} ثانية.`,
      `Too many requests. Please try again in ${retryAfterSeconds} seconds.`,
      { retryAfterSeconds },
    );
  },

  /**
   * The catch-all. The `reference` is a correlation id the user can quote to
   * support; the underlying cause stays in the server log where it belongs.
   */
  internal(reference: string) {
    return new DomainError(
      'INTERNAL_ERROR',
      `حدث خطأ غير متوقع. يرجى المحاولة لاحقاً وذكر الرقم المرجعي: ${reference}`,
      `An unexpected error occurred. Please try again later and quote reference: ${reference}`,
      { reference },
    );
  },
} as const;
