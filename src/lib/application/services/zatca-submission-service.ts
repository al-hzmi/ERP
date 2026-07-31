import type { Prisma, ZatcaSubmissionStatus } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { parseQrPayload, QrTag } from '@/lib/domain/zatca/zatca-crypto';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';
import {
  checkCompliance,
  clearInvoice,
  reportInvoice,
  type ZatcaResponse,
} from '@/lib/infrastructure/zatca/zatca-client';
import { loadSigningCredentials } from './zatca-config-service';

/**
 * Submitting an e-invoice to ZATCA, and reading back what happened.
 *
 * ## The network call is outside the transaction
 *
 * Three steps, deliberately not one: read the credentials and the invoice in a transaction,
 * call ZATCA outside any transaction, then write the outcome in a second transaction. Holding a
 * database transaction open across a twenty-second HTTP call to a government gateway would pin
 * a connection and a snapshot for the duration, and a slow morning at ZATCA becomes a database
 * outage here.
 *
 * The cost of that split is that a crash between the call and the write loses the outcome. The
 * invoice stays `PENDING` and gets resubmitted, which ZATCA tolerates — it is idempotent on the
 * invoice UUID. Losing a *connection pool* is not equally recoverable.
 */

export interface ZatcaInvoiceView {
  readonly id: string;
  readonly documentId: string;
  readonly documentNumber: string;
  readonly invoiceUuid: string;
  readonly icv: bigint;
  readonly status: ZatcaSubmissionStatus;
  readonly invoiceTypeCode: string;
  readonly invoiceHash: string;
  readonly previousHash: string;
  readonly qrCode: string;
  readonly xml: string;
  readonly issuedAtUtc: Date;
  readonly submittedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly attemptCount: number;
  readonly warningCount: number;
  readonly isSigned: boolean;
  readonly responseJson: Prisma.JsonValue | null;
}

/** The e-invoice envelope behind one posted document, for the preview panel. */
export async function getZatcaInvoiceForDocument(
  tenantId: string,
  documentId: string,
): Promise<ZatcaInvoiceView | null> {
  return withTenantRead(async (tx) => {
    const invoice = await tx.zatcaInvoice.findFirst({
      where: { tenantId, documentId },
      include: { document: { select: { documentNumber: true } } },
    });

    if (invoice === null) return null;

    return {
      id: invoice.id,
      documentId: invoice.documentId,
      documentNumber: invoice.document.documentNumber,
      invoiceUuid: invoice.invoiceUuid,
      icv: invoice.icv,
      status: invoice.status,
      invoiceTypeCode: invoice.invoiceTypeCode,
      invoiceHash: invoice.invoiceHash,
      previousHash: invoice.previousHash,
      qrCode: invoice.qrCode,
      xml: invoice.xml,
      issuedAtUtc: invoice.issuedAtUtc,
      submittedAt: invoice.submittedAt,
      lastAttemptAt: invoice.lastAttemptAt,
      attemptCount: invoice.attemptCount,
      warningCount: invoice.warningCount,
      isSigned: invoice.signature !== null,
      responseJson: invoice.responseJson,
    };
  });
}

export interface QrBreakdown {
  readonly tag: number;
  readonly labelAr: string;
  /** Text for tags 1–6; a byte count for the binary tags, which have no readable form. */
  readonly value: string;
}

const QR_LABELS: Record<number, string> = {
  [QrTag.SellerName]: 'اسم البائع',
  [QrTag.SellerVatNumber]: 'الرقم الضريبي للبائع',
  [QrTag.Timestamp]: 'تاريخ ووقت الإصدار',
  [QrTag.InvoiceTotal]: 'الإجمالي شامل الضريبة',
  [QrTag.VatTotal]: 'إجمالي ضريبة القيمة المضافة',
  [QrTag.XmlHash]: 'بصمة الفاتورة (SHA-256)',
  [QrTag.Signature]: 'التوقيع الإلكتروني (ECDSA)',
  [QrTag.PublicKey]: 'المفتاح العام للشهادة',
  [QrTag.CertificateSignature]: 'توقيع الجهة المُصدِرة للشهادة',
};

/**
 * Decodes a stored QR payload for display.
 *
 * Tags 7–9 are raw DER, so rendering them as text produces mojibake. They are shown as a byte
 * count instead — which is the useful fact anyway: it says the tag is present and non-empty.
 */
export function describeQrPayload(qrCode: string): QrBreakdown[] {
  return parseQrPayload(qrCode).map((field) => ({
    tag: field.tag,
    labelAr: QR_LABELS[field.tag] ?? `وسم ${field.tag}`,
    value: field.tag <= QrTag.XmlHash ? field.text : `${field.bytes.length} بايت (بيانات ثنائية)`,
  }));
}

export interface SubmitInput {
  readonly tenantId: string;
  readonly audit: AuditContext;
  readonly zatcaInvoiceId: string;
}

export interface SubmitResult {
  readonly status: ZatcaSubmissionStatus;
  readonly messageAr: string;
  readonly warningCount: number;
}

/** Sends one invoice to ZATCA — clearance for STANDARD, reporting for SIMPLIFIED. */
export async function submitZatcaInvoice(
  input: SubmitInput,
): Promise<Result<SubmitResult, DomainError>> {
  const prepared = await withTransaction(async (tx) => {
    const invoice = await tx.zatcaInvoice.findFirst({
      where: { id: input.zatcaInvoiceId, tenantId: input.tenantId },
    });

    if (invoice === null) {
      return err(DomainErrors.notFound('الفاتورة الإلكترونية', 'E-invoice', input.zatcaInvoiceId));
    }

    // Resubmitting an accepted invoice is not a retry, it is a duplicate. ZATCA deduplicates on
    // the UUID, but sending it at all means the operator believes it was not accepted — so the
    // refusal here is the honest answer rather than a silent no-op.
    if (invoice.status !== 'PENDING' && invoice.status !== 'FAILED') {
      return err(
        DomainErrors.invalidTransition(
          invoice.status,
          'SUBMITTED',
          'الفاتورة الإلكترونية — فقد قُبلت لدى الهيئة بالفعل',
          'the e-invoice, which ZATCA has already accepted',
        ),
      );
    }

    if (invoice.signature === null) {
      return err(
        DomainErrors.validation(
          'لا يمكن إرسال فاتورة غير موقَّعة إلكترونياً. يجب تركيب شهادة CSID وتفعيل الفوترة الإلكترونية أولاً، ثم إعادة إصدار الفاتورة.',
          'An unsigned invoice cannot be submitted; install a CSID and re-issue.',
          'signature',
        ),
      );
    }

    const credentials = await loadSigningCredentials(tx, input.tenantId);
    if (credentials === null || credentials.secret === null) {
      return err(
        DomainErrors.validation(
          'بيانات الاعتماد لدى الهيئة غير مكتملة — يلزم المفتاح السري (CSID Secret) لإرسال الفواتير.',
          'The CSID secret is required to submit invoices.',
          'csidSecret',
        ),
      );
    }

    // `secret` is narrowed here rather than at the call site, so the wire credentials cannot be
    // assembled without one.
    return ok({ invoice, credentials: { ...credentials, secret: credentials.secret } });
  });

  if (!prepared.ok) return prepared;

  const { invoice, credentials } = prepared.value;

  const payload = {
    invoiceUuid: invoice.invoiceUuid,
    invoiceHashHex: invoice.invoiceHash,
    invoiceBase64: Buffer.from(invoice.xml, 'utf8').toString('base64'),
  };

  const wire = {
    environment: credentials.environment,
    certificateBase64: credentials.certificate,
    secret: credentials.secret,
  };

  // Outside any transaction. See the note at the top of the file.
  const response: ZatcaResponse =
    credentials.environment === 'SANDBOX'
      ? await checkCompliance(wire, payload)
      : invoice.invoiceTypeCode === 'STANDARD'
        ? await clearInvoice(wire, payload)
        : await reportInvoice(wire, payload);

  const status = statusFor(response.outcome, invoice.invoiceTypeCode);

  return withTransaction(async (tx) => {
    const now = new Date();

    await tx.zatcaInvoice.update({
      where: { id: invoice.id },
      data: {
        status,
        // `responseJson` is never null once an attempt has been made — a CHECK constraint
        // enforces that, because a status of CLEARED with no body is a claim nobody can audit.
        responseJson: (response.body ?? { note: 'empty response body' }) as Prisma.InputJsonValue,
        warningCount: response.warningCount,
        lastAttemptAt: now,
        attemptCount: { increment: 1 },
        submittedAt: status === 'PENDING' || status === 'FAILED' ? invoice.submittedAt : now,
        clearanceStatus: response.outcome,
      },
    });

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'zatcaInvoice', entityId: invoice.id },
      {
        metadata: {
          icv: invoice.icv.toString(),
          invoiceTypeCode: invoice.invoiceTypeCode,
          environment: credentials.environment,
          outcome: response.outcome,
          httpStatus: response.httpStatus,
          warningCount: response.warningCount,
          errorCount: response.errorCount,
        },
      },
    );

    return ok({ status, messageAr: response.messageAr, warningCount: response.warningCount });
  });
}

/**
 * Maps an API outcome to a stored status.
 *
 * `UNREACHABLE` stays `PENDING`, not `FAILED`: nothing about the invoice is wrong, and marking
 * it failed would tell an operator to go and fix a document that needs no fixing.
 */
function statusFor(outcome: ZatcaResponse['outcome'], typeCode: string): ZatcaSubmissionStatus {
  switch (outcome) {
    case 'ACCEPTED':
      return typeCode === 'STANDARD' ? 'CLEARED' : 'REPORTED';
    case 'ACCEPTED_WITH_WARNINGS':
      return 'ACCEPTED_WITH_WARNINGS';
    case 'REJECTED':
      return 'FAILED';
    case 'UNREACHABLE':
      return 'PENDING';
  }
}

export interface ZatcaComplianceSummary {
  readonly total: number;
  readonly pending: number;
  readonly reported: number;
  readonly cleared: number;
  readonly withWarnings: number;
  readonly failed: number;
  readonly unsigned: number;
  /** The highest counter issued — a gap below it is what ZATCA looks for. */
  readonly latestIcv: bigint;
}

/** Headline numbers for the settings screen. */
export async function getComplianceSummary(tenantId: string): Promise<ZatcaComplianceSummary> {
  return withTenantRead(async (tx) => {
    const [rows] = await tx.$queryRaw<
      {
        total: bigint;
        pending: bigint;
        reported: bigint;
        cleared: bigint;
        warnings: bigint;
        failed: bigint;
        unsigned: bigint;
        latest: bigint | null;
      }[]
    >`
      SELECT count(*)                                                          AS total,
             count(*) FILTER (WHERE "status" = 'PENDING')                      AS pending,
             count(*) FILTER (WHERE "status" = 'REPORTED')                     AS reported,
             count(*) FILTER (WHERE "status" = 'CLEARED')                      AS cleared,
             count(*) FILTER (WHERE "status" = 'ACCEPTED_WITH_WARNINGS')       AS warnings,
             count(*) FILTER (WHERE "status" = 'FAILED')                       AS failed,
             count(*) FILTER (WHERE "signature" IS NULL)                       AS unsigned,
             max("icv")                                                        AS latest
        FROM "zatca_invoices"
       WHERE "tenantId" = ${tenantId}::uuid
    `;

    return {
      total: Number(rows?.total ?? 0n),
      pending: Number(rows?.pending ?? 0n),
      reported: Number(rows?.reported ?? 0n),
      cleared: Number(rows?.cleared ?? 0n),
      withWarnings: Number(rows?.warnings ?? 0n),
      failed: Number(rows?.failed ?? 0n),
      unsigned: Number(rows?.unsigned ?? 0n),
      latestIcv: rows?.latest ?? 0n,
    };
  });
}
