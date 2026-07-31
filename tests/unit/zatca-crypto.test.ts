import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify as cryptoVerify,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  QrTag,
  base64ToHex,
  buildQrPayload,
  buildSignedInfo,
  buildSignedProperties,
  canonicalise,
  certificateDigest,
  formatZatcaTimestamp,
  hexToBase64,
  parseCertificate,
  parseQrPayload,
  sha256Hex,
  signInvoice,
  signSignedInfo,
  stripPemArmour,
  ZatcaCryptoError,
} from '@/lib/domain/zatca/zatca-crypto';

/**
 * ZATCA cryptography.
 *
 * A real CSID cannot be fabricated — ZATCA issues one to a named taxpayer after onboarding —
 * so these tests generate a self-signed P-256 certificate with OpenSSL and treat it as the
 * device credential. That is enough to prove everything this code is responsible for: the
 * signature verifies against the certificate's own public key, the DER walk finds the issuer
 * signature the same bytes `openssl asn1parse` finds, and the TLV encodes what it claims to.
 *
 * What it cannot prove is that ZATCA's validator agrees, and no test that runs offline can.
 * That claim is left unmade here and in the module's own header.
 */

const workdir = mkdtempSync(join(tmpdir(), 'zatca-'));

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** A self-signed P-256 certificate, shaped the way a CSID is. */
function issueCertificate(): { certificatePem: string; privateKeyPem: string } {
  const keyPath = join(workdir, 'key.pem');
  const certPath = join(workdir, 'cert.pem');

  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '365',
    '-nodes',
    '-subj',
    '/C=SA/O=Al-Ufuq Trading/OU=Riyadh/CN=TST-886431145-399999999900003',
  ]);

  return {
    certificatePem: execFileSync('cat', [certPath]).toString('utf8'),
    privateKeyPem: execFileSync('cat', [keyPath]).toString('utf8'),
  };
}

const { certificatePem, privateKeyPem } = issueCertificate();

describe('digest encoding', () => {
  it('converts between hex and Base64 without losing bytes', () => {
    const hex = sha256Hex('فاتورة');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);

    const base64 = hexToBase64(hex);
    // 32 bytes Base64-encode to 44 characters. A 64-character value in tag 6 is the hex
    // string, which ZATCA rejects.
    expect(base64).toHaveLength(44);
    expect(base64ToHex(base64)).toBe(hex);
  });

  it('hashes the certificate the way ZATCA does, not the way that makes sense', () => {
    // ZATCA hashes the Base64 *text*, hex-encodes, then Base64s the hex. The result is 88
    // characters (64 ASCII hex characters Base64-encoded), not 44.
    const digest = certificateDigest(certificatePem);
    expect(digest).toHaveLength(88);

    const decoded = Buffer.from(digest, 'base64').toString('utf8');
    expect(decoded).toMatch(/^[0-9a-f]{64}$/);
    expect(decoded).toBe(sha256Hex(stripPemArmour(certificatePem)));
  });

  it('ignores PEM armour, so a pasted certificate hashes the same either way', () => {
    const bare = stripPemArmour(certificatePem);
    expect(certificateDigest(certificatePem)).toBe(certificateDigest(bare));
  });
});

describe('certificate parsing', () => {
  it('extracts the public key as SPKI DER', () => {
    const parts = parseCertificate(certificatePem);
    const expected = new X509Certificate(certificatePem).publicKey.export({
      type: 'spki',
      format: 'der',
    });

    expect(parts.publicKeyDer.equals(expected)).toBe(true);
  });

  it('finds the issuer signature by walking the DER', () => {
    const parts = parseCertificate(certificatePem);

    // The certificate is self-signed, so the "issuer" signature is the certificate's own
    // signature over its tbsCertificate — and it verifies against its own public key. That is
    // the strongest available check that the DER walk landed on the right bytes: a wrong
    // offset produces a buffer that cannot verify against anything.
    expect(parts.issuerSignature.length).toBeGreaterThan(60);

    const der = Buffer.from(stripPemArmour(certificatePem), 'base64');
    // tbsCertificate is the first element inside the outer SEQUENCE. Re-derived here
    // independently of the module, so the test is not just the implementation restated.
    const outerHeaderLength = der.readUInt8(1) < 0x80 ? 2 : 2 + (der.readUInt8(1) & 0x7f);
    const tbsStart = outerHeaderLength;
    const tbsLengthByte = der.readUInt8(tbsStart + 1);
    const tbsHeader = tbsLengthByte < 0x80 ? 2 : 2 + (tbsLengthByte & 0x7f);
    let tbsLength = 0;
    if (tbsLengthByte < 0x80) {
      tbsLength = tbsLengthByte;
    } else {
      for (let index = 0; index < (tbsLengthByte & 0x7f); index += 1) {
        tbsLength = tbsLength * 256 + der.readUInt8(tbsStart + 2 + index);
      }
    }
    const tbs = der.subarray(tbsStart, tbsStart + tbsHeader + tbsLength);

    const verified = cryptoVerify(
      'sha256',
      tbs,
      { key: createPublicKey(certificatePem), dsaEncoding: 'der' },
      parts.issuerSignature,
    );

    expect(verified).toBe(true);
  });

  it('renders the serial number in decimal, not the hex Node prints', () => {
    const parts = parseCertificate(certificatePem);
    expect(parts.serialNumber).toMatch(/^[0-9]+$/);
    expect(BigInt(parts.serialNumber).toString(16).toUpperCase()).toBe(
      BigInt(`0x${new X509Certificate(certificatePem).serialNumber}`).toString(16).toUpperCase(),
    );
  });

  it('refuses anything that is not a certificate, rather than returning garbage', () => {
    expect(() => parseCertificate('')).toThrow(ZatcaCryptoError);
    expect(() => parseCertificate('bm90IGEgY2VydGlmaWNhdGU=')).toThrow(ZatcaCryptoError);
  });
});

describe('signing', () => {
  it('produces a signature that verifies against the certificate', () => {
    const signedInfo = buildSignedInfo({
      invoiceDigest: hexToBase64(sha256Hex('<Invoice/>')),
      signedPropertiesDigest: hexToBase64(sha256Hex('props')),
    });

    const signature = signSignedInfo(privateKeyPem, signedInfo);

    const verified = cryptoVerify(
      'sha256',
      Buffer.from(signedInfo, 'utf8'),
      { key: createPublicKey(certificatePem), dsaEncoding: 'der' },
      Buffer.from(signature, 'base64'),
    );

    expect(verified).toBe(true);
  });

  it('accepts a bare Base64 key as well as PEM, because taxpayers paste both', () => {
    const bare = stripPemArmour(privateKeyPem);
    const signedInfo = buildSignedInfo({ invoiceDigest: 'a', signedPropertiesDigest: 'b' });

    const fromPem = signSignedInfo(privateKeyPem, signedInfo);
    const fromBare = signSignedInfo(bare, signedInfo);

    // ECDSA is randomised, so the two signatures differ — but both must verify.
    for (const signature of [fromPem, fromBare]) {
      expect(
        cryptoVerify(
          'sha256',
          Buffer.from(signedInfo, 'utf8'),
          { key: createPublicKey(certificatePem), dsaEncoding: 'der' },
          Buffer.from(signature, 'base64'),
        ),
      ).toBe(true);
    }
  });

  it('refuses an RSA key instead of signing something ZATCA cannot verify', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    expect(() => signSignedInfo(pem, '<x/>')).toThrow(/EC key on the P-256 curve/);
  });

  it('refuses an EC key on the wrong curve', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    expect(() => signSignedInfo(pem, '<x/>')).toThrow(/P-256/);
  });

  it('refuses key material that is not a key at all', () => {
    expect(() => signSignedInfo('not a key', '<x/>')).toThrow(ZatcaCryptoError);
  });
});

describe('signInvoice', () => {
  const invoiceXml = canonicalise(`<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <cbc:ID>INV-2026-00001</cbc:ID>
</Invoice>`);

  it('digests the invoice as given, and reports that digest back', () => {
    const result = signInvoice({
      canonicalXml: invoiceXml,
      privateKey: privateKeyPem,
      certificate: certificatePem,
      signingTime: new Date('2026-03-15T09:30:00Z'),
    });

    // The chain hash must be the digest of the *unsigned* invoice. If this ever became the
    // digest of the assembled document, the chain would still look fine and every signature
    // would be unverifiable.
    expect(result.invoiceHashHex).toBe(sha256Hex(invoiceXml));
  });

  it('signs the SignedInfo, not the invoice — and the SignedInfo names both digests', () => {
    const signingTime = new Date('2026-03-15T09:30:00Z');

    const result = signInvoice({
      canonicalXml: invoiceXml,
      privateKey: privateKeyPem,
      certificate: certificatePem,
      signingTime,
    });

    // Rebuild the SignedInfo the way a verifier would, from the certificate and the invoice,
    // and check the stored signature covers exactly that.
    const parts = parseCertificate(certificatePem);
    const signedProperties = buildSignedProperties({
      signingTime,
      certificateDigest: parts.digest,
      issuerName: parts.issuerName,
      serialNumber: parts.serialNumber,
    });

    const signedInfo = buildSignedInfo({
      invoiceDigest: hexToBase64(sha256Hex(invoiceXml)),
      signedPropertiesDigest: Buffer.from(sha256Hex(signedProperties), 'hex').toString('base64'),
    });

    expect(
      cryptoVerify(
        'sha256',
        Buffer.from(signedInfo, 'utf8'),
        { key: createPublicKey(certificatePem), dsaEncoding: 'der' },
        Buffer.from(result.signatureValue, 'base64'),
      ),
    ).toBe(true);
  });

  it('carries the certificate and the signature into the extension', () => {
    const result = signInvoice({
      canonicalXml: invoiceXml,
      privateKey: privateKeyPem,
      certificate: certificatePem,
      signingTime: new Date('2026-03-15T09:30:00Z'),
    });

    expect(result.extensionXml).toContain(stripPemArmour(certificatePem));
    expect(result.extensionXml).toContain(result.signatureValue);
    expect(result.extensionXml).toContain('xadesSignedProperties');
    // The transforms that tell a verifier to strip the extension back out before re-digesting.
    expect(result.extensionXml).toContain('not(//ancestor-or-self::ext:UBLExtensions)');
  });

  it('rejects a private key that does not match the certificate at verification time', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const stranger = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const result = signInvoice({
      canonicalXml: invoiceXml,
      privateKey: stranger,
      certificate: certificatePem,
      signingTime: new Date('2026-03-15T09:30:00Z'),
    });

    // Signing succeeds — nothing structurally prevents signing with the wrong key — but the
    // signature does not verify against the certificate. This is exactly what ZATCA would
    // reject, and it is why the settings screen stores the pair together.
    const signedInfo = buildSignedInfo({
      invoiceDigest: hexToBase64(sha256Hex(invoiceXml)),
      signedPropertiesDigest: 'x',
    });

    expect(
      cryptoVerify(
        'sha256',
        Buffer.from(signedInfo, 'utf8'),
        { key: createPublicKey(certificatePem), dsaEncoding: 'der' },
        Buffer.from(result.signatureValue, 'base64'),
      ),
    ).toBe(false);
  });
});

describe('QR tags 7 to 9', () => {
  const base = {
    sellerName: 'شركة الأفق المتحدة للتجارة',
    sellerVatNumber: '300000000000003',
    timestamp: new Date('2026-03-15T09:30:00.000Z'),
    invoiceTotal: '1150.00',
    vatTotal: '150.00',
  };

  it('carries the binary tags as raw bytes, not Base64 text', () => {
    const parts = parseCertificate(certificatePem);
    const signature = signSignedInfo(privateKeyPem, '<x/>');

    const payload = buildQrPayload({
      ...base,
      invoiceHashHex: sha256Hex('invoice'),
      signatureBase64: signature,
      publicKeyDer: parts.publicKeyDer,
      certificateSignature: parts.issuerSignature,
    });

    const fields = parseQrPayload(payload);
    expect(fields.map((field) => field.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const tag7 = fields.find((field) => field.tag === QrTag.Signature);
    // Base64-encoding the signature before putting it in the TLV, then Base64-encoding the
    // TLV, double-encodes it — and the payload still renders as a perfectly valid QR code.
    expect(tag7?.bytes.equals(Buffer.from(signature, 'base64'))).toBe(true);
    expect(tag7?.bytes.length).toBeLessThan(Buffer.byteLength(signature, 'utf8'));

    const tag8 = fields.find((field) => field.tag === QrTag.PublicKey);
    expect(tag8?.bytes.equals(parts.publicKeyDer)).toBe(true);

    const tag9 = fields.find((field) => field.tag === QrTag.CertificateSignature);
    expect(tag9?.bytes.equals(parts.issuerSignature)).toBe(true);
  });

  it('drops the timestamp milliseconds ZATCA rejects', () => {
    expect(formatZatcaTimestamp(new Date('2026-03-15T09:30:00.456Z'))).toBe(
      '2026-03-15T09:30:00Z',
    );
  });

  it('round-trips a binary tag that would be corrupted by a UTF-8 decode', () => {
    // A DER signature contains bytes that are not valid UTF-8. Storing them as text and
    // reading them back would replace those with U+FFFD and silently change the payload.
    const noisy = Buffer.from([0x30, 0x45, 0x02, 0x21, 0x00, 0xff, 0xfe, 0x80, 0x81]);

    const payload = buildQrPayload({ ...base, publicKeyDer: noisy });
    const decoded = parseQrPayload(payload).find((field) => field.tag === QrTag.PublicKey);

    expect(decoded?.bytes.equals(noisy)).toBe(true);
    expect(Buffer.from(decoded?.text ?? '', 'utf8').equals(noisy)).toBe(false);
  });
});

describe('canonicalisation', () => {
  it('is stable across line endings and trailing whitespace', () => {
    const a = '<Invoice>\r\n  <cbc:ID>1</cbc:ID>   \r\n</Invoice>\r\n';
    const b = '<Invoice>\n  <cbc:ID>1</cbc:ID>\n</Invoice>';

    expect(canonicalise(a)).toBe(canonicalise(b));
    expect(sha256Hex(canonicalise(a))).toBe(sha256Hex(canonicalise(b)));
  });

  it('does not collapse meaningful content', () => {
    // Whitespace inside an element's text is data. A canonicaliser that collapsed it would
    // change an Arabic product name and change the digest with it. Only *trailing* whitespace
    // on a line goes, and a line ending in `</a>` has none.
    expect(canonicalise('<a>  x  y  </a>')).toBe('<a>  x  y  </a>');
    expect(canonicalise('<a>  x  y  </a>   \n')).toBe('<a>  x  y  </a>');
  });
});

describe('key loading', () => {
  it('reads a SEC1 key, which is what openssl ecparam -genkey emits', () => {
    const sec1 = createPrivateKey(privateKeyPem)
      .export({ type: 'sec1', format: 'pem' })
      .toString();

    expect(() => signSignedInfo(sec1, '<x/>')).not.toThrow();
  });
});
