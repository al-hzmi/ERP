import { X509Certificate, createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';

/**
 * The cryptographic half of ZATCA Phase 2.
 *
 * Pure functions over strings and buffers: no database, no network, no clock it does not take
 * as an argument. Everything here is deterministic given its inputs, which is what makes it
 * testable against ZATCA's published vectors — and the reason the signing key is passed in
 * rather than read from anywhere.
 *
 * ## What the regulation actually asks for
 *
 * An e-invoice is signed with an ECDSA P-256 key whose public half sits in a certificate
 * (the CSID) that ZATCA issues to one device belonging to one taxpayer. The signature does not
 * cover the invoice directly. It covers a `<ds:SignedInfo>` element which in turn *names* two
 * digests: the canonical invoice, and a block of signed properties that pins the certificate
 * and the signing time. That indirection is the whole point — it is what stops someone
 * re-pointing a valid signature at a different certificate.
 *
 * So the order of operations is fixed and cannot be rearranged:
 *
 *   1. digest the invoice XML *before* the signature is inserted into it,
 *   2. build the signed properties and digest those,
 *   3. build `SignedInfo` naming both digests, canonicalise it, and sign *that*,
 *   4. insert the resulting extension back into the invoice.
 *
 * Step 1 is the one that gets written wrong. If the invoice is digested after the extension is
 * in place, the digest covers the signature that covers the digest, and no verifier on earth
 * will accept it.
 *
 * ## What cannot be verified from here
 *
 * A CSID is issued only after onboarding a real taxpayer with a real CSR. Everything below
 * produces structurally correct artefacts and round-trips against itself, but "ZATCA accepts
 * it" is a claim only ZATCA's compliance endpoint can settle. Nothing in this file should be
 * read as that claim having been made.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Digests
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 of a UTF-8 string, as lowercase hex. Hex is how the hash chain is stored. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The same digest as Base64, which is how ZATCA wants it on the wire.
 *
 * Hex in the column, Base64 at the boundary. Storing hex keeps `VARCHAR(64)` meaningful (a
 * SHA-256 is exactly 64 hex characters, so a truncated one is a constraint violation rather
 * than a silently short string) and keeps the chain readable in psql. Converting at the edge
 * costs nothing and means there is exactly one representation in the database.
 */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

export function base64ToHex(value: string): string {
  return Buffer.from(value, 'base64').toString('hex');
}

/**
 * The certificate digest ZATCA expects in the signed properties.
 *
 * This is not `SHA-256(certificate bytes)`. ZATCA's reference implementation hashes the
 * *Base64 text* of the certificate, hex-encodes that digest, and then Base64-encodes the hex
 * string — so the value is Base64 of 64 ASCII characters, not Base64 of 32 bytes. It is a
 * quirk, it is what the validator checks, and computing the sensible thing instead produces a
 * document that fails with an unhelpful error.
 */
export function certificateDigest(certificateBase64: string): string {
  const normalised = stripPemArmour(certificateBase64);
  const hex = createHash('sha256').update(normalised, 'utf8').digest('hex');
  return Buffer.from(hex, 'utf8').toString('base64');
}

/** Removes PEM headers, footers and line breaks, leaving the bare Base64 body. */
export function stripPemArmour(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Signing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DER, not IEEE P1363.
 *
 * XMLDSig nominally specifies the fixed-width `r || s` concatenation for ECDSA. ZATCA's
 * reference implementation is built on BouncyCastle and emits DER, and the validator is the
 * reference implementation. This constant exists so that if that ever changes it is a one-line
 * change with a comment attached, rather than a hunt through the signing code.
 */
const DSA_ENCODING = 'der' as const;

export class ZatcaCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZatcaCryptoError';
  }
}

/**
 * Signs a canonical `SignedInfo` with an EC P-256 private key.
 *
 * The key is accepted as PEM (`-----BEGIN EC PRIVATE KEY-----` or PKCS#8) or as bare Base64
 * DER, because taxpayers paste whatever their onboarding tool produced and refusing one of the
 * two forms achieves nothing except a support ticket.
 */
export function signSignedInfo(privateKey: string, canonicalSignedInfo: string): string {
  const key = loadPrivateKey(privateKey);

  if (key.asymmetricKeyType !== 'ec') {
    throw new ZatcaCryptoError(
      `The ZATCA signing key must be an EC key on the P-256 curve; got "${key.asymmetricKeyType ?? 'unknown'}".`,
    );
  }

  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== undefined && curve !== 'prime256v1' && curve !== 'secp256r1') {
    throw new ZatcaCryptoError(
      `The ZATCA signing key must be on P-256 (prime256v1); got "${curve}".`,
    );
  }

  // `sign('sha256', data, key)` digests `data` and signs the digest — identical to signing a
  // pre-computed SHA-256, and it removes the chance of double-hashing by accident.
  return cryptoSign('sha256', Buffer.from(canonicalSignedInfo, 'utf8'), {
    key,
    dsaEncoding: DSA_ENCODING,
  }).toString('base64');
}

function loadPrivateKey(material: string): ReturnType<typeof createPrivateKey> {
  const trimmed = material.trim();

  if (trimmed.includes('-----BEGIN')) {
    try {
      return createPrivateKey(trimmed);
    } catch (error) {
      throw new ZatcaCryptoError(
        `The stored signing key is not a readable PEM private key: ${(error as Error).message}`,
      );
    }
  }

  // Bare Base64 — try PKCS#8 first, then SEC1, which is what `openssl ecparam -genkey` emits.
  for (const label of ['PRIVATE KEY', 'EC PRIVATE KEY']) {
    try {
      return createPrivateKey(
        `-----BEGIN ${label}-----\n${wrapBase64(stripPemArmour(trimmed))}\n-----END ${label}-----\n`,
      );
    } catch {
      // Try the next envelope.
    }
  }

  throw new ZatcaCryptoError(
    'The stored signing key could not be parsed as PKCS#8 or SEC1 EC private key material.',
  );
}

function wrapBase64(value: string): string {
  return (value.match(/.{1,64}/g) ?? []).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Certificate parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface CertificateParts {
  /** SubjectPublicKeyInfo, DER. QR tag 8 carries these bytes verbatim. */
  readonly publicKeyDer: Buffer;
  /** The CA's signature over the certificate. QR tag 9. */
  readonly issuerSignature: Buffer;
  /** X.500 issuer name, as the signed properties spell it. */
  readonly issuerName: string;
  /** Serial number in decimal — the signed properties use decimal, not the hex Node prints. */
  readonly serialNumber: string;
  /** The Base64 body, armour and whitespace removed. */
  readonly base64: string;
  /** ZATCA's quirky certificate digest, ready for the signed properties. */
  readonly digest: string;
}

/**
 * Pulls out the four things the signature needs from a CSID.
 *
 * Node's `X509Certificate` exposes the public key and the issuer but not the issuer's
 * signature, so that one is read by walking the DER: a certificate is
 * `SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING }`, and the third
 * element is the only thing we need. A five-line walk beats a dependency here — the structure
 * is fixed by X.509 and will not change.
 */
export function parseCertificate(certificate: string): CertificateParts {
  const base64 = stripPemArmour(certificate);
  if (base64 === '') {
    throw new ZatcaCryptoError('The CSID certificate is empty.');
  }

  const der = Buffer.from(base64, 'base64');

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(der);
  } catch (error) {
    throw new ZatcaCryptoError(
      `The CSID certificate is not a readable X.509 certificate: ${(error as Error).message}`,
    );
  }

  return {
    publicKeyDer: x509.publicKey.export({ type: 'spki', format: 'der' }),
    issuerSignature: readCertificateSignature(der),
    // Node renders the issuer over several lines, newest component first. The signed
    // properties want one line in that same order, comma-separated.
    issuerName: x509.issuer.split('\n').filter(Boolean).join(', '),
    serialNumber: BigInt(`0x${x509.serialNumber}`).toString(10),
    base64,
    digest: certificateDigest(base64),
  };
}

/** The `signatureValue` BIT STRING — the third element of the outermost SEQUENCE. */
function readCertificateSignature(der: Buffer): Buffer {
  const outer = readDerElement(der, 0);
  if (outer.tag !== 0x30) {
    throw new ZatcaCryptoError('The certificate does not begin with a DER SEQUENCE.');
  }

  let offset = outer.contentStart;
  const end = outer.contentStart + outer.contentLength;

  // tbsCertificate, then signatureAlgorithm.
  for (let skipped = 0; skipped < 2; skipped += 1) {
    if (offset >= end) {
      throw new ZatcaCryptoError('The certificate SEQUENCE ended before the signature.');
    }
    const element = readDerElement(der, offset);
    offset = element.contentStart + element.contentLength;
  }

  if (offset >= end) {
    throw new ZatcaCryptoError('The certificate carries no signature value.');
  }

  const signature = readDerElement(der, offset);
  if (signature.tag !== 0x03) {
    throw new ZatcaCryptoError('The certificate signature is not a DER BIT STRING.');
  }

  // A BIT STRING's first content byte counts the unused trailing bits. For a signature it is
  // always zero, but skipping it unconditionally is what makes the bytes the signature itself.
  return der.subarray(signature.contentStart + 1, signature.contentStart + signature.contentLength);
}

interface DerElement {
  readonly tag: number;
  readonly contentStart: number;
  readonly contentLength: number;
}

function readDerElement(buffer: Buffer, offset: number): DerElement {
  if (offset + 2 > buffer.length) {
    throw new ZatcaCryptoError('Truncated DER: no room for a tag and a length.');
  }

  const tag = buffer.readUInt8(offset);
  const first = buffer.readUInt8(offset + 1);

  if (first < 0x80) {
    return { tag, contentStart: offset + 2, contentLength: first };
  }

  const lengthBytes = first & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4) {
    // Indefinite length is not legal in DER; more than four length bytes means a certificate
    // over 4 GB, which is not a certificate.
    throw new ZatcaCryptoError(`Unsupported DER length encoding (0x${first.toString(16)}).`);
  }
  if (offset + 2 + lengthBytes > buffer.length) {
    throw new ZatcaCryptoError('Truncated DER: the length field runs past the buffer.');
  }

  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    length = length * 256 + buffer.readUInt8(offset + 2 + index);
  }

  return { tag, contentStart: offset + 2 + lengthBytes, contentLength: length };
}

// ─────────────────────────────────────────────────────────────────────────────
//  TLV / QR
// ─────────────────────────────────────────────────────────────────────────────

/** TLV tags defined by the ZATCA QR specification. */
export const QrTag = {
  SellerName: 1,
  SellerVatNumber: 2,
  Timestamp: 3,
  InvoiceTotal: 4,
  VatTotal: 5,
  XmlHash: 6,
  Signature: 7,
  PublicKey: 8,
  CertificateSignature: 9,
} as const;

export type QrTagValue = (typeof QrTag)[keyof typeof QrTag];

export interface TlvField {
  readonly tag: QrTagValue;
  readonly value: Buffer;
}

/**
 * `[tag][length][value]`, concatenated, Base64.
 *
 * The length is the *byte* length, not the character count. An Arabic seller name is roughly
 * two bytes per character, and counting characters is the single most common reason a QR code
 * fails ZATCA validation while looking perfectly correct to the eye.
 *
 * Tags 7 to 9 are raw binary — a DER signature, a DER public key, a CA signature — which is
 * why this takes buffers rather than strings. Base64-encoding those before putting them in the
 * TLV, then Base64-encoding the TLV, double-encodes them: another failure that renders fine.
 */
export function buildTlv(fields: readonly TlvField[]): Buffer {
  const chunks: Buffer[] = [];

  for (const field of fields) {
    const value = field.value.length > 255 ? truncateUtf8Bytes(field.value, 255) : field.value;
    chunks.push(Buffer.from([field.tag, value.length]), value);
  }

  return Buffer.concat(chunks);
}

/**
 * Cuts a buffer to at most `maxBytes` without splitting a UTF-8 sequence.
 *
 * Only tags 1 and 2 can realistically overflow, and both are text. Walking back off a
 * continuation byte keeps the truncated name readable instead of ending in a replacement
 * character.
 */
function truncateUtf8Bytes(value: Buffer, maxBytes: number): Buffer {
  let end = maxBytes;
  // Continuation bytes are 0b10xxxxxx. Step back until the next byte starts a character.
  while (end > 0 && (value.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1;
  }
  return value.subarray(0, end);
}

export interface QrInput {
  readonly sellerName: string;
  readonly sellerVatNumber: string;
  readonly timestamp: Date;
  /** Invoice total including VAT, two decimals. */
  readonly invoiceTotal: string;
  readonly vatTotal: string;
  /** The invoice digest as hex — converted to Base64 here, which is what tag 6 carries. */
  readonly invoiceHashHex?: string;
  /** Base64 `SignatureValue`. Decoded before it goes into tag 7. */
  readonly signatureBase64?: string;
  readonly publicKeyDer?: Buffer;
  readonly certificateSignature?: Buffer;
}

/**
 * The QR payload.
 *
 * Tags 1–5 are mandatory on every invoice. Tag 6 appears once the XML exists. Tags 7–9 appear
 * only when the invoice has actually been signed, which means only when the tenant has been
 * onboarded — an unsigned invoice gets a five- or six-tag code rather than a nine-tag code
 * with empty values, because an empty tag 7 is a claim that the invoice is signed.
 */
export function buildQrPayload(input: QrInput): string {
  const fields: TlvField[] = [
    { tag: QrTag.SellerName, value: Buffer.from(input.sellerName, 'utf8') },
    { tag: QrTag.SellerVatNumber, value: Buffer.from(input.sellerVatNumber, 'utf8') },
    { tag: QrTag.Timestamp, value: Buffer.from(formatZatcaTimestamp(input.timestamp), 'utf8') },
    { tag: QrTag.InvoiceTotal, value: Buffer.from(input.invoiceTotal, 'utf8') },
    { tag: QrTag.VatTotal, value: Buffer.from(input.vatTotal, 'utf8') },
  ];

  if (input.invoiceHashHex !== undefined && input.invoiceHashHex !== '') {
    fields.push({
      tag: QrTag.XmlHash,
      value: Buffer.from(hexToBase64(input.invoiceHashHex), 'utf8'),
    });
  }

  if (input.signatureBase64 !== undefined && input.signatureBase64 !== '') {
    fields.push({ tag: QrTag.Signature, value: Buffer.from(input.signatureBase64, 'base64') });
  }

  if (input.publicKeyDer !== undefined && input.publicKeyDer.length > 0) {
    fields.push({ tag: QrTag.PublicKey, value: input.publicKeyDer });
  }

  if (input.certificateSignature !== undefined && input.certificateSignature.length > 0) {
    fields.push({ tag: QrTag.CertificateSignature, value: input.certificateSignature });
  }

  return buildTlv(fields).toString('base64');
}

export interface ParsedTlvField {
  readonly tag: number;
  readonly bytes: Buffer;
  /** The bytes as UTF-8. Meaningful for tags 1–6, noise for 7–9. */
  readonly text: string;
}

/** Decodes a TLV payload — used by the preview screen and by the tests. */
export function parseQrPayload(base64: string): ParsedTlvField[] {
  const buffer = Buffer.from(base64, 'base64');
  const fields: ParsedTlvField[] = [];

  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const tag = buffer.readUInt8(offset);
    const length = buffer.readUInt8(offset + 1);
    const start = offset + 2;
    const end = start + length;
    if (end > buffer.length) break;
    const bytes = buffer.subarray(start, end);
    fields.push({ tag, bytes, text: bytes.toString('utf8') });
    offset = end;
  }

  return fields;
}

/**
 * ZATCA's timestamp format: ISO 8601 in UTC, to the second, with `Z`.
 *
 * `toISOString()` includes milliseconds, and the validator rejects them. This is a one-line
 * difference that costs an entire submission round trip to discover.
 */
export function formatZatcaTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  XAdES envelope
// ─────────────────────────────────────────────────────────────────────────────

export interface SignedPropertiesInput {
  readonly signingTime: Date;
  readonly certificateDigest: string;
  readonly issuerName: string;
  readonly serialNumber: string;
}

/**
 * The XAdES `SignedProperties` block.
 *
 * Its exact bytes are what gets digested, so the indentation below is load-bearing: change the
 * whitespace and the digest changes, and the signature stops verifying. That is why it is a
 * template literal here rather than something assembled by a formatter.
 */
export function buildSignedProperties(input: SignedPropertiesInput): string {
  return `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${formatZatcaTimestamp(input.signingTime)}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${input.certificateDigest}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${escapeXml(input.issuerName)}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${escapeXml(input.serialNumber)}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;
}

export interface SignedInfoInput {
  /** Base64 digest of the canonical invoice, before the signature was inserted. */
  readonly invoiceDigest: string;
  /** Base64 digest of the `SignedProperties` block above. */
  readonly signedPropertiesDigest: string;
}

/**
 * `SignedInfo` — the element the signature actually covers.
 *
 * Two references: the invoice itself (with an XPath transform that removes the extension, the
 * QR node and the signature, so the digest is over the invoice as it was before signing), and
 * the signed properties.
 */
export function buildSignedInfo(input: SignedInfoInput): string {
  return `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
                                <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                                <ds:Reference Id="invoiceSignedData" URI="">
                                    <ds:Transforms>
                                        <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                            <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                        </ds:Transform>
                                        <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                            <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                        </ds:Transform>
                                        <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                            <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                        </ds:Transform>
                                        <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                    </ds:Transforms>
                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                    <ds:DigestValue>${input.invoiceDigest}</ds:DigestValue>
                                </ds:Reference>
                                <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                    <ds:DigestValue>${input.signedPropertiesDigest}</ds:DigestValue>
                                </ds:Reference>
                            </ds:SignedInfo>`;
}

export interface UblExtensionInput {
  readonly signedInfo: string;
  readonly signatureValue: string;
  readonly certificateBase64: string;
  readonly signedProperties: string;
}

/** The `<ext:UBLExtensions>` block that carries the whole signature into the invoice. */
export function buildUblExtension(input: UblExtensionInput): string {
  return `  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
      <ext:ExtensionContent>
        <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
          <sac:SignatureInformation>
            <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
            <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
            <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
                            ${input.signedInfo}
                            <ds:SignatureValue>${input.signatureValue}</ds:SignatureValue>
                            <ds:KeyInfo>
                                <ds:X509Data>
                                    <ds:X509Certificate>${input.certificateBase64}</ds:X509Certificate>
                                </ds:X509Data>
                            </ds:KeyInfo>
                            <ds:Object>
                                <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">
                                    ${input.signedProperties}
                                </xades:QualifyingProperties>
                            </ds:Object>
            </ds:Signature>
          </sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
`;
}

export interface SignInvoiceInput {
  /** The canonical, unsigned invoice XML. Digested exactly as given. */
  readonly canonicalXml: string;
  readonly privateKey: string;
  readonly certificate: string;
  readonly signingTime: Date;
}

export interface SignedInvoice {
  /** Base64 `SignatureValue`, and QR tag 7 once decoded. */
  readonly signatureValue: string;
  readonly publicKeyDer: Buffer;
  readonly certificateSignature: Buffer;
  /** The `<ext:UBLExtensions>` block, ready to insert after the root element. */
  readonly extensionXml: string;
  /** Hex digest of the unsigned invoice — the value that goes in the hash chain. */
  readonly invoiceHashHex: string;
}

/**
 * Signs an invoice.
 *
 * The digest is taken over `canonicalXml` as passed in, which must be the invoice *without*
 * the extension. Inserting the returned `extensionXml` afterwards leaves the digest correct,
 * because the `SignedInfo` transforms tell a verifier to strip that extension back out before
 * re-computing it.
 */
export function signInvoice(input: SignInvoiceInput): SignedInvoice {
  const parts = parseCertificate(input.certificate);

  const invoiceHashHex = sha256Hex(input.canonicalXml);
  const invoiceDigest = hexToBase64(invoiceHashHex);

  const signedProperties = buildSignedProperties({
    signingTime: input.signingTime,
    certificateDigest: parts.digest,
    issuerName: parts.issuerName,
    serialNumber: parts.serialNumber,
  });

  const signedPropertiesDigest = createHash('sha256')
    .update(signedProperties, 'utf8')
    .digest('base64');

  const signedInfo = buildSignedInfo({ invoiceDigest, signedPropertiesDigest });
  const signatureValue = signSignedInfo(input.privateKey, signedInfo);

  return {
    signatureValue,
    publicKeyDer: parts.publicKeyDer,
    certificateSignature: parts.issuerSignature,
    extensionXml: buildUblExtension({
      signedInfo,
      signatureValue,
      certificateBase64: parts.base64,
      signedProperties,
    }),
    invoiceHashHex,
  };
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Minimal canonicalisation before hashing.
 *
 * ZATCA specifies C14N 1.1, which needs a real XML parser to implement — namespace fixups,
 * attribute ordering, entity normalisation. What matters for *our* hash chain is that the same
 * invoice always produces the same bytes, and normalising line endings and trailing whitespace
 * achieves that. It is stated here rather than hidden: a deployment submitting to production
 * needs a C14N 1.1 implementation, and this is the seam where it goes.
 */
export function canonicalise(xml: string): string {
  return xml
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}
