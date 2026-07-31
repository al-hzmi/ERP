import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import type { Money } from '@/lib/domain/shared/money';
import type { Quantity } from '@/lib/domain/shared/quantity';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import {
  buildQrPayload as buildQrTlv,
  canonicalise,
  escapeXml,
  formatZatcaTimestamp,
  sha256Hex,
  signInvoice,
  ZatcaCryptoError,
} from '@/lib/domain/zatca/zatca-crypto';
import type { TransactionClient } from '@/lib/infrastructure/db/prisma';
import { allocateInvoiceCounterValue } from './numbering-service';
import { loadSigningCredentials } from './zatca-config-service';

/**
 * ZATCA (Fatoora) Phase 2 e-invoicing.
 *
 * Produces the artefacts the regulation requires for every invoice:
 *   - a UBL 2.1 XML document,
 *   - a monotonic invoice counter (ICV),
 *   - a SHA-256 hash chained to the previous invoice's hash (PIH),
 *   - an ECDSA P-256 signature in a XAdES envelope, when the tenant is onboarded,
 *   - a Base64 TLV QR payload carrying tags 1–6, or 1–9 once signed.
 *
 * ## Signing is conditional, and that is the design
 *
 * The signature needs a CSID that ZATCA issues to one device belonging to one taxpayer, after
 * onboarding. A system in its first week does not have one. Refusing to post an invoice until
 * it does would stop the business from trading, so an un-onboarded tenant gets a correct
 * *unsigned* envelope — right XML, right chain, right counter, six-tag QR — and the invoice is
 * marked `PENDING`. When the CSID arrives, signing begins with no change to anything else.
 *
 * The one thing that is never done is pretending. An unsigned invoice does not get a nine-tag
 * QR with empty values, and its status is not `REPORTED`.
 *
 * ## The order of hashing
 *
 * The chain hash is taken over the *unsigned* canonical XML. The signature is then built over
 * that digest and inserted into the document afterwards. Digesting the assembled document
 * instead would hash the signature that covers the hash, and no verifier would accept it. See
 * `zatca-crypto.ts` for the full sequence.
 */

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
  readonly icv: bigint;
  /** False when the tenant has not onboarded — the invoice is valid, just not yet stamped. */
  readonly signed: boolean;
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

  // Allocated before the XML is built, because the counter is *in* the XML and therefore in
  // the digest the signature covers.
  const icv = await allocateInvoiceCounterValue(tx, input.tenantId);

  const unsignedXml = buildUblXml({
    ...input,
    invoiceUuid,
    issuedAtUtc,
    previousHash,
    invoiceTypeCode,
    sellerVatNumber: input.sellerVatNumber,
    icv,
  });

  const canonicalXml = canonicalise(unsignedXml);
  const invoiceHash = sha256Hex(canonicalXml);

  const credentials = await loadSigningCredentials(tx, input.tenantId);

  let signed: {
    signatureValue: string;
    publicKey: string;
    certSignature: string;
    xml: string;
    qrCode: string;
  } | null = null;

  if (credentials !== null) {
    try {
      const stamp = signInvoice({
        canonicalXml,
        privateKey: credentials.privateKey,
        certificate: credentials.certificate,
        signingTime: issuedAtUtc,
      });

      const qrCode = buildQrTlv({
        sellerName: input.sellerNameAr,
        sellerVatNumber: input.sellerVatNumber,
        timestamp: issuedAtUtc,
        invoiceTotal: input.totalWithVat.toFixed(2),
        vatTotal: input.vatTotal.toFixed(2),
        invoiceHashHex: invoiceHash,
        signatureBase64: stamp.signatureValue,
        publicKeyDer: stamp.publicKeyDer,
        certificateSignature: stamp.certificateSignature,
      });

      signed = {
        signatureValue: stamp.signatureValue,
        publicKey: stamp.publicKeyDer.toString('base64'),
        certSignature: stamp.certificateSignature.toString('base64'),
        xml: assembleSignedXml(unsignedXml, stamp.extensionXml, qrCode),
        qrCode,
      };
    } catch (error) {
      // A stored key that will not load must not take down the sale. The invoice posts
      // unsigned and `PENDING`, and the failure is surfaced as a domain error rather than a
      // stack trace so the operator learns their credentials are broken.
      if (!(error instanceof ZatcaCryptoError)) throw error;

      return err(
        DomainErrors.validation(
          `تعذَّر توقيع الفاتورة إلكترونياً: ${error.message} — يُرجى مراجعة شهادة CSID والمفتاح الخاص في إعدادات الفوترة الإلكترونية.`,
          `The invoice could not be signed: ${error.message}`,
          'zatcaConfig',
        ),
      );
    }
  }

  const qrCode =
    signed?.qrCode ??
    buildQrTlv({
      sellerName: input.sellerNameAr,
      sellerVatNumber: input.sellerVatNumber,
      timestamp: issuedAtUtc,
      invoiceTotal: input.totalWithVat.toFixed(2),
      vatTotal: input.vatTotal.toFixed(2),
      invoiceHashHex: invoiceHash,
    });

  const xml = signed?.xml ?? assembleSignedXml(unsignedXml, '', qrCode);

  await tx.zatcaInvoice.create({
    data: {
      tenantId: input.tenantId,
      documentId: input.documentId,
      invoiceUuid,
      previousHash,
      invoiceHash,
      qrCode,
      xml,
      invoiceTypeCode,
      issuedAtUtc,
      icv,
      signature: signed?.signatureValue ?? null,
      publicKey: signed?.publicKey ?? null,
      certSignature: signed?.certSignature ?? null,
    },
  });

  return ok({
    invoiceUuid,
    invoiceHash,
    previousHash,
    qrCode,
    xml,
    invoiceTypeCode,
    icv,
    signed: signed !== null,
  });
}

/**
 * Inserts the signature extension and the QR node into the invoice.
 *
 * Both go in *after* the digest was taken, and both are excluded by the `SignedInfo`
 * transforms, so a verifier strips them back out and arrives at the same digest. The extension
 * goes first inside the root because UBL fixes that order; the QR reference joins the other
 * `AdditionalDocumentReference` elements.
 */
function assembleSignedXml(unsignedXml: string, extensionXml: string, qrBase64: string): string {
  const rootEnd = unsignedXml.indexOf('>', unsignedXml.indexOf('<Invoice'));
  if (rootEnd === -1) {
    throw new Error('The generated invoice has no <Invoice> root element.');
  }

  const qrNode = `  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeXml(qrBase64)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
`;

  const signatureNode =
    extensionXml === ''
      ? ''
      : `  <cac:Signature>
    <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
  </cac:Signature>
`;

  const head = unsignedXml.slice(0, rootEnd + 1);
  const tail = unsignedXml.slice(rootEnd + 1);

  const anchor = tail.indexOf('  <cac:AccountingSupplierParty>');
  if (anchor === -1) {
    throw new Error('The generated invoice has no supplier party to anchor the QR node against.');
  }

  // `extensionXml` is empty on an unsigned invoice, and concatenating a newline anyway would
  // leave a stray blank line under the root element.
  const extension = extensionXml === '' ? '' : `\n${extensionXml.replace(/\n$/, '')}`;

  return `${head}${extension}${tail.slice(0, anchor)}${qrNode}${signatureNode}${tail.slice(anchor)}`;
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

interface UblInput extends GenerateZatcaInvoiceInput {
  readonly invoiceUuid: string;
  readonly issuedAtUtc: Date;
  readonly previousHash: string;
  readonly invoiceTypeCode: 'STANDARD' | 'SIMPLIFIED';
  readonly sellerVatNumber: string;
  readonly icv: bigint;
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
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${input.icv.toString()}</cbc:UUID>
  </cac:AdditionalDocumentReference>
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

