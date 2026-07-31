'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AlertTriangle, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ZATCA_ENVIRONMENT_LABELS } from '@/lib/commercial/zatca-labels';
import { apiPost, type ApiError } from '@/lib/utils/api-client';

/**
 * ZATCA device credentials.
 *
 * ## The form never shows a secret, and never asks for one twice
 *
 * The private key and the CSID secret arrive as empty fields even when both are installed —
 * the panel above says *مُركَّب* instead. Rendering the key so the operator can confirm it is
 * "still there" would put the taxpayer's cryptographic identity into a browser cache, a proxy
 * log and any screenshot of this page. Leaving a field blank means "keep what is stored", which
 * is also what makes it possible to correct the VAT number without re-pasting the key.
 *
 * ## Activation is a deliberate, separate act
 *
 * The switch that starts signing real invoices is its own control with its own warning, not a
 * side effect of saving the form. Turning it on with production selected means every invoice
 * posted from this moment carries a cryptographic stamp attributed to this taxpayer.
 */

export interface ZatcaConfigProps {
  readonly environment: string;
  readonly sellerVatNumber: string;
  readonly sellerNameAr: string;
  readonly commercialRegNo: string | null;
  readonly streetName: string | null;
  readonly buildingNumber: string | null;
  readonly citySubdivision: string | null;
  readonly cityName: string | null;
  readonly postalZone: string | null;
  readonly isActive: boolean;
  readonly hasPrivateKey: boolean;
  readonly hasCertificate: boolean;
  readonly hasSecret: boolean;
  readonly certificateSubject: string | null;
  readonly certificateIssuer: string | null;
  readonly certificateSerial: string | null;
  readonly certificateExpiresAt: string | null;
  readonly certificateError: string | null;
}

const ENVIRONMENTS = ['SANDBOX', 'SIMULATION', 'PRODUCTION'] as const;

export function ZatcaSettings({
  config,
  canEdit,
  summary,
}: {
  config: ZatcaConfigProps | null;
  canEdit: boolean;
  summary: {
    total: number;
    pending: number;
    reported: number;
    cleared: number;
    withWarnings: number;
    failed: number;
    unsigned: number;
    latestIcv: string;
  };
}): JSX.Element {
  const router = useRouter();

  const [environment, setEnvironment] = useState(config?.environment ?? 'SANDBOX');
  const [sellerVatNumber, setSellerVatNumber] = useState(config?.sellerVatNumber ?? '');
  const [sellerNameAr, setSellerNameAr] = useState(config?.sellerNameAr ?? '');
  const [commercialRegNo, setCommercialRegNo] = useState(config?.commercialRegNo ?? '');
  const [streetName, setStreetName] = useState(config?.streetName ?? '');
  const [buildingNumber, setBuildingNumber] = useState(config?.buildingNumber ?? '');
  const [citySubdivision, setCitySubdivision] = useState(config?.citySubdivision ?? '');
  const [cityName, setCityName] = useState(config?.cityName ?? '');
  const [postalZone, setPostalZone] = useState(config?.postalZone ?? '');

  const [csidCertificate, setCsidCertificate] = useState('');
  const [csidSecret, setCsidSecret] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  const [isActive, setIsActive] = useState(config?.isActive ?? false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  const vatShapeOk = /^3[0-9]{13}3$/.test(sellerVatNumber.trim());

  // Mirrors the CHECK constraint and the service rule, so the button is disabled instead of the
  // request being refused after the operator has filled in eleven fields.
  const willHaveCertificate = csidCertificate.trim() !== '' || (config?.hasCertificate ?? false);
  const willHaveKey = privateKey.trim() !== '' || (config?.hasPrivateKey ?? false);
  const canActivate = willHaveCertificate && willHaveKey;

  const blocked = !vatShapeOk || sellerNameAr.trim() === '' || (isActive && !canActivate);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);

    const result = await apiPost<{ id: string }>('/api/system/zatca', {
      environment,
      sellerVatNumber: sellerVatNumber.trim(),
      sellerNameAr: sellerNameAr.trim(),
      commercialRegNo: commercialRegNo.trim() || null,
      streetName: streetName.trim() || null,
      buildingNumber: buildingNumber.trim() || null,
      citySubdivision: citySubdivision.trim() || null,
      cityName: cityName.trim() || null,
      postalZone: postalZone.trim() || null,
      csidCertificate: csidCertificate.trim() || null,
      csidSecret: csidSecret.trim() || null,
      privateKey: privateKey.trim() || null,
      isActive,
    });

    setSaving(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    // Cleared on success so the secrets do not sit in the DOM after they have been stored.
    setCsidCertificate('');
    setCsidSecret('');
    setPrivateKey('');
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="فواتير إلكترونية" value={summary.total.toLocaleString('en-US')} />
        <Stat
          label="بانتظار الإرسال"
          value={summary.pending.toLocaleString('en-US')}
          tone={summary.pending > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="مرفوضة"
          value={summary.failed.toLocaleString('en-US')}
          tone={summary.failed > 0 ? 'danger' : 'neutral'}
        />
        <Stat label="آخر عدّاد (ICV)" value={summary.latestIcv} />
      </div>

      {summary.unsigned > 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <p>
            <span className="numeric font-medium">{summary.unsigned.toLocaleString('en-US')}</span>{' '}
            فاتورة صادرة بدون توقيع إلكتروني — أُصدرت قبل تركيب شهادة CSID. الفواتير الصادرة بعد
            التفعيل تُوقَّع تلقائياً؛ أما السابقة فلا يمكن توقيعها بأثر رجعي لأن التوقيع يشمل ختماً
            زمنياً لا يجوز تزويره.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="حالة الترخيص"
          description="شهادة الختم التشفيري (CSID) التي تصدرها الهيئة لهذا الجهاز بعد الربط"
          action={
            config?.isActive === true ? (
              <Badge tone="success">
                <ShieldCheck className="me-1 h-3 w-3" aria-hidden="true" />
                مُفعَّل
              </Badge>
            ) : (
              <Badge tone="neutral">
                <ShieldOff className="me-1 h-3 w-3" aria-hidden="true" />
                غير مُفعَّل
              </Badge>
            )
          }
        />
        <CardBody className="space-y-3 text-sm">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Installed label="الشهادة (CSID)" present={config?.hasCertificate ?? false} />
            <Installed label="المفتاح الخاص" present={config?.hasPrivateKey ?? false} />
            <Installed label="المفتاح السري (Secret)" present={config?.hasSecret ?? false} />
            <div className="flex justify-between gap-4 border-b border-border/50 py-1.5">
              <dt className="text-muted-foreground">البيئة</dt>
              <dd>{ZATCA_ENVIRONMENT_LABELS[config?.environment ?? 'SANDBOX']}</dd>
            </div>
          </dl>

          {config?.certificateError !== null && config?.certificateError !== undefined ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              الشهادة المخزَّنة غير قابلة للقراءة: {config.certificateError}
            </p>
          ) : null}

          {config?.certificateSubject !== null && config?.certificateSubject !== undefined ? (
            <dl className="grid gap-x-6 gap-y-1 rounded-md bg-muted/40 p-3 text-xs sm:grid-cols-2">
              <Row label="صاحب الشهادة" value={config.certificateSubject} />
              <Row label="جهة الإصدار" value={config.certificateIssuer ?? '—'} />
              <Row label="الرقم التسلسلي" value={config.certificateSerial ?? '—'} />
              <Row label="تنتهي في" value={config.certificateExpiresAt ?? '—'} />
            </dl>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="بيانات المنشأة"
          description="تُدرَج في ملف UBL 2.1 وفي رمز الاستجابة السريعة لكل فاتورة"
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field
            label="الرقم الضريبي"
            required
            hint="15 رقماً يبدأ وينتهي بالرقم 3"
            error={
              sellerVatNumber !== '' && !vatShapeOk
                ? 'الصيغة غير صحيحة — 15 رقماً يبدأ وينتهي بـ 3.'
                : undefined
            }
          >
            <Input
              numeric
              value={sellerVatNumber}
              maxLength={15}
              disabled={!canEdit}
              onChange={(event) => setSellerVatNumber(event.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field label="اسم المنشأة (عربي)" required>
            <Input
              value={sellerNameAr}
              disabled={!canEdit}
              onChange={(event) => setSellerNameAr(event.target.value)}
            />
          </Field>

          <Field label="السجل التجاري">
            <Input
              numeric
              value={commercialRegNo}
              disabled={!canEdit}
              onChange={(event) => setCommercialRegNo(event.target.value)}
            />
          </Field>

          <Field label="البيئة" hint="الإنتاج يوقّع فواتير حقيقية تُرسَل إلى الهيئة">
            <Select
              value={environment}
              disabled={!canEdit}
              onChange={(event) => setEnvironment(event.target.value)}
              options={ENVIRONMENTS.map((value) => ({
                value,
                label: ZATCA_ENVIRONMENT_LABELS[value] ?? value,
              }))}
            />
          </Field>

          <Field label="الشارع">
            <Input
              value={streetName}
              disabled={!canEdit}
              onChange={(event) => setStreetName(event.target.value)}
            />
          </Field>

          <Field label="رقم المبنى" hint="أربعة أرقام، كما في العنوان الوطني">
            <Input
              numeric
              maxLength={8}
              value={buildingNumber}
              disabled={!canEdit}
              onChange={(event) => setBuildingNumber(event.target.value)}
            />
          </Field>

          <Field label="الحي">
            <Input
              value={citySubdivision}
              disabled={!canEdit}
              onChange={(event) => setCitySubdivision(event.target.value)}
            />
          </Field>

          <Field label="المدينة">
            <Input
              value={cityName}
              disabled={!canEdit}
              onChange={(event) => setCityName(event.target.value)}
            />
          </Field>

          <Field label="الرمز البريدي">
            <Input
              numeric
              maxLength={8}
              value={postalZone}
              disabled={!canEdit}
              onChange={(event) => setPostalZone(event.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="شهادات التشفير"
          description="اتركها فارغة للإبقاء على المُركَّب حالياً — الحقل الفارغ لا يمسح شيئاً"
        />
        <CardBody className="space-y-4">
          <Field
            label="شهادة CSID (Base64 أو PEM)"
            hint={
              config?.hasCertificate === true
                ? 'مُركَّبة. الصق شهادة جديدة لاستبدالها.'
                : 'الشهادة التي تعيدها الهيئة بعد إتمام الربط.'
            }
          >
            <textarea
              rows={4}
              dir="ltr"
              disabled={!canEdit}
              value={csidCertificate}
              onChange={(event) => setCsidCertificate(event.target.value)}
              className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              placeholder="MIID..."
            />
          </Field>

          <Field
            label="المفتاح الخاص EC P-256 (PEM أو Base64)"
            hint={
              config?.hasPrivateKey === true
                ? 'مُركَّب ومشفَّر في قاعدة البيانات (AES-256-GCM). لا يُعرَض أبداً بعد حفظه.'
                : 'المفتاح الذي وُلِّد مع طلب الشهادة (CSR). يُخزَّن مشفَّراً ولا يُعاد عرضه.'
            }
          >
            <textarea
              rows={4}
              dir="ltr"
              disabled={!canEdit}
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
              className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              placeholder="-----BEGIN EC PRIVATE KEY-----"
            />
          </Field>

          <Field
            label="المفتاح السري (CSID Secret)"
            hint={
              config?.hasSecret === true
                ? 'مُركَّب ومشفَّر. يلزم لإرسال الفواتير إلى الهيئة.'
                : 'يُستخدم في مصادقة الطلبات المُرسَلة إلى واجهة الهيئة.'
            }
          >
            <Input
              type="password"
              dir="ltr"
              autoComplete="new-password"
              disabled={!canEdit}
              value={csidSecret}
              onChange={(event) => setCsidSecret(event.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="التفعيل"
          description="عند التفعيل تُوقَّع كل فاتورة جديدة إلكترونياً باسم هذه المنشأة"
        />
        <CardBody className="space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              disabled={!canEdit || !canActivate}
              onChange={(event) => setIsActive(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input"
            />
            <span>
              <span className="font-medium">تفعيل التوقيع الإلكتروني</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {canActivate
                  ? 'كل فاتورة تُرحَّل بعد التفعيل ستحمل توقيعاً تشفيرياً منسوباً لهذه المنشأة، ورمز QR بتسعة وسوم بدل ستة.'
                  : 'يلزم تركيب الشهادة والمفتاح الخاص أولاً — التفعيل بدونهما يُنتج فواتير غير موقَّعة ترفضها الهيئة بعد تسليمها للعميل.'}
              </span>
            </span>
          </label>

          {isActive && environment === 'PRODUCTION' ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              بيئة الإنتاج: الفواتير تُرسَل فعلياً إلى الهيئة ولا يمكن التراجع عن إرسالها.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {error !== null ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error.messageAr}
        </p>
      ) : null}

      {saved ? (
        <p className="rounded-md border border-success/30 bg-success/5 p-3 text-sm text-success">
          حُفظت الإعدادات.
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || blocked}>
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {saving ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          عرض فقط — تعديل بيانات الاعتماد يتطلب صلاحية إدارة الأدوار.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warning' | 'danger';
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === 'danger'
            ? 'numeric mt-1 text-2xl font-semibold text-destructive'
            : tone === 'warning'
              ? 'numeric mt-1 text-2xl font-semibold text-warning'
              : 'numeric mt-1 text-2xl font-semibold'
        }
      >
        {value}
      </p>
    </div>
  );
}

function Installed({ label, present }: { label: string; present: boolean }): JSX.Element {
  return (
    <div className="flex justify-between gap-4 border-b border-border/50 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        {present ? (
          <span className="text-success">مُركَّب</span>
        ) : (
          <span className="text-muted-foreground">غير مُركَّب</span>
        )}
      </dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd dir="ltr" className="truncate font-mono">
        {value}
      </dd>
    </div>
  );
}
