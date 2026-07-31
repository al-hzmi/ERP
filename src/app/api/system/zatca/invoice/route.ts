import { apiHandler } from '@/lib/api/handler';
import {
  describeQrPayload,
  getZatcaInvoiceForDocument,
} from '@/lib/application/services/zatca-submission-service';
import type { ZatcaPanelInvoice } from '@/components/sales/zatca-panel';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err, ok } from '@/lib/domain/shared/result';

/**
 * The e-invoice envelope behind one document.
 *
 * Fetched on demand rather than rendered with the register. A UBL document is a few kilobytes,
 * and shipping twenty-five of them with a page nobody has asked to inspect would multiply the
 * payload for a panel that is opened perhaps once a week.
 *
 * `sales.invoice:read` — this returns the invoice's own XML and nothing else. It carries no
 * credential material: the signature is a public artefact, and the private key never leaves the
 * signing path.
 */
export const GET = apiHandler<ZatcaPanelInvoice>(async (context, request) => {
  const documentId = new URL(request.url).searchParams.get('documentId');

  if (documentId === null || !/^[0-9a-f-]{36}$/i.test(documentId)) {
    return err(DomainErrors.validation('معرِّف المستند غير صحيح.', 'Invalid document id.'));
  }

  const permitted = context.permissions.require('sales.invoice', 'read');
  if (!permitted.ok) return permitted;

  const invoice = await getZatcaInvoiceForDocument(context.tenantId, documentId);

  if (invoice === null) {
    return err(
      DomainErrors.notFound('الفاتورة الإلكترونية لهذا المستند', 'E-invoice', documentId),
    );
  }

  return ok({
    id: invoice.id,
    documentNumber: invoice.documentNumber,
    invoiceUuid: invoice.invoiceUuid,
    icv: invoice.icv.toString(),
    status: invoice.status,
    invoiceTypeCode: invoice.invoiceTypeCode,
    invoiceHash: invoice.invoiceHash,
    previousHash: invoice.previousHash,
    qrCode: invoice.qrCode,
    xml: invoice.xml,
    isSigned: invoice.isSigned,
    issuedAtUtc: invoice.issuedAtUtc.toISOString(),
    submittedAt: invoice.submittedAt?.toISOString() ?? null,
    attemptCount: invoice.attemptCount,
    warningCount: invoice.warningCount,
    qrFields: describeQrPayload(invoice.qrCode),
    responseJson: invoice.responseJson,
  });
});
