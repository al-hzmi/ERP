import { createHash } from 'node:crypto';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import type { Money } from '@/lib/domain/shared/money';
import type { Quantity } from '@/lib/domain/shared/quantity';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { TransactionClient } from '@/lib/infrastructure/db/prisma';

/**
 * ZATCA (Fatoora) Phase 2 e-invoicing.
 *
 * Produces the three artefacts the regulation requires for every invoice:
 *   - a UBL 2.1 XML document,
 *   - a SHA-256 hash chained to the previous invoice's hash,
 *   - a Base64 TLV QR payload.
 *
 * What is deliberately NOT here: the ECDSA signature (QR tags 7–9) and the
 * clearance call. Both require a Cryptographic Stamp Identifier issued by ZATCA
 * to a specific taxpayer after onboarding, which cannot be fabricated. The
 * envelope is built so that signing is an addition at onboarding time rather
 * than a rewrite: `previousHash`, `invoiceHash` and the canonical XML are all
 * already correct and already chained.
 */

/** TLV tags defined by the ZATCA QR specification. */
const QrTag = {
  SellerName: 1,
  SellerVatNumber: 2,
  Timestamp: 3,
  InvoiceTotal: 4,
  VatTotal: 5,
  XmlHash: 6,
} as const;

type QrTagValue = (typeof QrTag)[keyof typeof QrTag];

/** The genesis hash: SHA-256 of "0", per the ZATCA hash-chain specification. */
const GENESIS_PREVIOUS_HASH =
  '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9';

export interface ZatcaLineInput {
  readonly nameAr: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly taxRate: string;
  readonly lineTotal: Money;
}

export interface GenerateZatcaInvoiceInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentNumber: string;
  readonly issueDate: Date;
  readonly sellerNameAr: string;
  readonly sellerVatNumber: string | null;
  readonly buyerNameAr: string;
  readonly buyerVatNumber: string | null;
  readonly totalWithVat: Money;
  readonly vatTotal: Money;
  readonly currency: string;
  readonly lines: readonly ZatcaLineInput[];
}

export interface ZatcaInvoiceResult {
  readonly invoiceUuid: string;
  readonly invoiceHash: string;
  readonly previousHash: string;
  readonly qrCode: string;
  readonly xml: string;
  readonly invoiceTypeCode: 'STANDARD' | 'SIMPLIFIED';
}

/**
 * Builds and stores the e-invoice envelope for a posted sales invoice.
 *
 * The hash chain is read under a row lock ordered by issue time, so two invoices
 * posted concurrently cannot both chain to the same predecessor and fork the
 * chain — which would invalidate every invoice after the fork.
 */
export async function generateZatcaInvoice(
  tx: TransactionClient,
  input: GenerateZatcaInvoiceInput,
): Promise<Result<ZatcaInvoiceResult, DomainError>> {
  if (input.sellerVatNumber === null || input.sellerVatNumber === '') {
    return err(
      DomainErrors.validation(
        'لا يمكن إصدار فاتورة إلكترونية بدون الرقم الضريبي للمنشأة. يرجى تحديثه في إعدادات النظام.',
        'An e-invoice cannot be issued without the seller VAT number. Please set it in system settings.',
        'vatNumber',
      ),
    );
  }

  const invoiceUuid = crypto.randomUUID();
  const issuedAtUtc = new Date();

  // B2B invoices carrying a buyer VAT number go through clearance (STANDARD);
  // consumer sales are reported afterwards (SIMPLIFIED).
  const invoiceTypeCode: 'STANDARD' | 'SIMPLIFIED' =
    input.buyerVatNumber !== null && input.buyerVatNumber !== '' ? 'STANDARD' : 'SIMPLIFIED';

  const previousHash = await readPreviousHash(tx, input.tenantId);

  const xml = buildUblXml({
    ...input,
    invoiceUuid,
    issuedAtUtc,
    previousHash,
    invoiceTypeCode,
    sellerVatNumber: input.sellerVatNumber,
  });

  const invoiceHash = createHash('sha256').update(canonicalise(xml), 'utf8').digest('hex');

  const qrCode = buildQrPayload({
    sellerName: input.sellerNameAr,
    sellerVatNumber: input.sellerVatNumber,
    timestamp: issuedAtUtc,
    invoiceTotal: input.totalWithVat,
    vatTotal: input.vatTotal,
    invoiceHash,
  });

  await tx.zatcaInvoice.create({
    data: {
      documentId: input.documentId,
      invoiceUuid,
      previousHash,
      invoiceHash,
      qrCode,
      xml,
      invoiceTypeCode,
      issuedAtUtc,
    },
  });

  return ok({ invoiceUuid, invoiceHash, previousHash, qrCode, xml, invoiceTypeCode });
}

/**
 * The most recent invoice hash for this tenant, or the genesis value.
 *
 * `FOR UPDATE` on the predecessor row serialises concurrent invoice generation
 * so the chain stays linear.
 */
async function readPreviousHash(tx: TransactionClient, tenantId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ invoiceHash: string }[]>`
    SELECT z."invoiceHash"
      FROM "zatca_invoices" z
      JOIN "documents" d ON d."id" = z."documentId"
     WHERE d."tenantId" = ${tenantId}::uuid
     ORDER BY z."issuedAtUtc" DESC, z."id" DESC
     LIMIT 1
       FOR UPDATE OF z
  `;

  return rows[0]?.invoiceHash ?? GENESIS_PREVIOUS_HASH;
}

/**
 * Encodes the QR payload as Base64 TLV.
 *
 * TLV means each field is `[tag byte][length byte][value bytes]`. The length is
 * the byte length of the UTF-8 encoding, not the character count — an Arabic
 * seller name is roughly two bytes per character, and getting this wrong is the
 * single most common reason a QR code fails ZATCA validation while looking
 * perfectly fine to the eye.
 */
export function buildQrPayload(input: {
  sellerName: string;
  sellerVatNumber: string;
  timestamp: Date;
  invoiceTotal: Money;
  vatTotal: Money;
  invoiceHash?: string;
}): string {
  const fields: [QrTagValue, string][] = [
    [QrTag.SellerName, input.sellerName],
    [QrTag.SellerVatNumber, input.sellerVatNumber],
    [QrTag.Timestamp, input.timestamp.toISOString()],
    [QrTag.InvoiceTotal, input.invoiceTotal.toFixed(2)],
    [QrTag.VatTotal, input.vatTotal.toFixed(2)],
  ];

  if (input.invoiceHash !== undefined) {
    fields.push([QrTag.XmlHash, input.invoiceHash]);
  }

  const chunks: Buffer[] = [];

  for (const [tag, value] of fields) {
    const valueBytes = Buffer.from(value, 'utf8');
    if (valueBytes.length > 255) {
      // A single TLV length byte caps a field at 255 bytes; truncating on a byte
      // boundary would split a multi-byte character and corrupt the payload.
      const truncated = truncateUtf8(value, 255);
      const truncatedBytes = Buffer.from(truncated, 'utf8');
      chunks.push(Buffer.from([tag, truncatedBytes.length]), truncatedBytes);
      continue;
    }
    chunks.push(Buffer.from([tag, valueBytes.length]), valueBytes);
  }

  return Buffer.concat(chunks).toString('base64');
}

/** Decodes a TLV payload — used by the verification endpoint and by the tests. */
export function parseQrPayload(base64: string): { tag: number; value: string }[] {
  const buffer = Buffer.from(base64, 'base64');
  const fields: { tag: number; value: string }[] = [];

  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const tag = buffer.readUInt8(offset);
    const length = buffer.readUInt8(offset + 1);
    const start = offset + 2;
    const end = start + length;
    if (end > buffer.length) break;
    fields.push({ tag, value: buffer.subarray(start, end).toString('utf8') });
    offset = end;
  }

  return fields;
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

interface UblInput extends GenerateZatcaInvoiceInput {
  readonly invoiceUuid: string;
  readonly issuedAtUtc: Date;
  readonly previousHash: string;
  readonly invoiceTypeCode: 'STANDARD' | 'SIMPLIFIED';
  readonly sellerVatNumber: string;
}

/**
 * Renders the UBL 2.1 invoice.
 *
 * Every interpolated value is XML-escaped. An Arabic product name containing an
 * ampersand is ordinary data, and it must not be able to break the document — or
 * to inject elements into it.
 */
function buildUblXml(input: UblInput): string {
  const issueDate = input.issueDate.toISOString().slice(0, 10);
  const issueTime = input.issuedAtUtc.toISOString().slice(11, 19);
  const netTotal = input.totalWithVat.subtract(input.vatTotal);

  const lines = input.lines
    .map((line, index) => {
      const lineNet = line.lineTotal.divide(
        `1.${line.taxRate.replace('.', '').padStart(4, '0')}`,
      );
      return `    <cac:InvoiceLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${escapeXml(line.quantity.toDisplayString())}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(input.currency)}">${escapeXml(lineNet.toFixed(2))}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${escapeXml(input.currency)}">${escapeXml(line.lineTotal.subtract(lineNet).toFixed(2))}</cbc:TaxAmount>
        <cbc:RoundingAmount currencyID="${escapeXml(input.currency)}">${escapeXml(line.lineTotal.toFixed(2))}</cbc:RoundingAmount>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${escapeXml(line.nameAr)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>S</cbc:ID>
          <cbc:Percent>${escapeXml(line.taxRate)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${escapeXml(input.currency)}">${escapeXml(line.unitPrice.toFixed(2))}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`;
    })
    .join('\n');

  const buyerParty =
    input.buyerVatNumber !== null && input.buyerVatNumber !== ''
      ? `      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(input.buyerVatNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>\n`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(input.documentNumber)}</cbc:ID>
  <cbc:UUID>${escapeXml(input.invoiceUuid)}</cbc:UUID>
  <cbc:IssueDate>${escapeXml(issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${escapeXml(issueTime)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${input.invoiceTypeCode === 'STANDARD' ? '0100000' : '0200000'}">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${escapeXml(input.currency)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeXml(
        Buffer.from(input.previousHash, 'hex').toString('base64'),
      )}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(input.sellerVatNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(input.sellerNameAr)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
${buyerParty}      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(input.buyerNameAr)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(input.currency)}">${escapeXml(input.vatTotal.toFixed(2))}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(input.currency)}">${escapeXml(netTotal.toFixed(2))}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(input.currency)}">${escapeXml(netTotal.toFixed(2))}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(input.currency)}">${escapeXml(input.totalWithVat.toFixed(2))}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${escapeXml(input.currency)}">${escapeXml(input.totalWithVat.toFixed(2))}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines}
</Invoice>`;
}

/**
 * Minimal canonicalisation before hashing.
 *
 * ZATCA hashes a C14N-canonicalised document with the signature elements
 * removed. Ours contains no signature yet, so normalising line endings and
 * trailing whitespace is sufficient and, critically, deterministic — the same
 * invoice always hashes to the same value.
 */
function canonicalise(xml: string): string {
  return xml
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
