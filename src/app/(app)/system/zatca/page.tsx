import { ZatcaSettings } from '@/components/system/zatca-settings';
import { withPageScope } from '@/lib/api/page';
import { getZatcaConfig } from '@/lib/application/services/zatca-config-service';
import { getComplianceSummary } from '@/lib/application/services/zatca-submission-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'الفوترة الإلكترونية (ZATCA)' };

/**
 * ZATCA device credentials and compliance state.
 *
 * `system.role` authority: installing a CSID gives this deployment the ability to sign invoices
 * in the taxpayer's name, which is authority over the organisation's legal identity rather than
 * over any one document.
 *
 * Every value crossing to the client is a boolean or a public fact read off the certificate.
 * The private key and the secret are decrypted in exactly one place — the signing path — and
 * that place returns to code, never to a response body.
 */
export default async function Page(): Promise<JSX.Element> {
  const { config, summary, canEdit } = await withPageScope(async (context) => ({
    config: await getZatcaConfig(context.tenantId),
    summary: await getComplianceSummary(context.tenantId),
    canEdit: context.permissions.can('system.role', 'update'),
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">الفوترة الإلكترونية (ZATCA)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          المرحلة الثانية — الربط والتكامل. تُنشئ المنظومة لكل فاتورة مبيعات ملف UBL 2.1 وبصمة
          SHA-256 مرتبطة بالفاتورة السابقة (PIH) وعدّاداً متسلسلاً (ICV) ورمز QR. عند تركيب شهادة
          الختم التشفيري تُضاف إليها توقيع ECDSA P-256 وتصبح قابلة للإرسال.
        </p>
      </header>

      <ZatcaSettings
        canEdit={canEdit}
        summary={{
          total: summary.total,
          pending: summary.pending,
          reported: summary.reported,
          cleared: summary.cleared,
          withWarnings: summary.withWarnings,
          failed: summary.failed,
          unsigned: summary.unsigned,
          latestIcv: summary.latestIcv.toString(),
        }}
        config={
          config === null
            ? null
            : {
                environment: config.environment,
                sellerVatNumber: config.sellerVatNumber,
                sellerNameAr: config.sellerNameAr,
                commercialRegNo: config.commercialRegNo,
                streetName: config.streetName,
                buildingNumber: config.buildingNumber,
                citySubdivision: config.citySubdivision,
                cityName: config.cityName,
                postalZone: config.postalZone,
                isActive: config.isActive,
                hasPrivateKey: config.hasPrivateKey,
                hasCertificate: config.hasCertificate,
                hasSecret: config.hasSecret,
                certificateSubject: config.certificateSubject,
                certificateIssuer: config.certificateIssuer,
                certificateSerial: config.certificateSerial,
                certificateExpiresAt:
                  config.certificateExpiresAt?.toISOString().slice(0, 10) ?? null,
                certificateError: config.certificateError,
              }
        }
      />
    </div>
  );
}
