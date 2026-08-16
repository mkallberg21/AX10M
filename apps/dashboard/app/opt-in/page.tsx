'use client';

import { useEffect, useState } from 'react';

/**
 * Merchant opt-in portal. Reads the current terms from GET /billing/terms, collects the account +
 * accounts-payable + payer-track details, and POSTs /billing/opt-in — which signs an Ed25519
 * clickwrap acceptance and enrolls the merchant. No money moves here; the account + signed
 * acceptance are what later authorize the monthly charge/invoice. Safe: the payment method is an
 * opaque processor token (in production a Stripe SetupIntent — the card form never touches us).
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

type FeeSchedule = { feeRate: number; currency: string; paymentTermsDays: number; lateFinanceChargeMonthlyRate: number };
type Terms = { version: string; effectiveAt: string; bodyHash: string; feeSchedule: FeeSchedule; body: string };
type OptInResult = {
  account: { accountId: string; merchantId: string; legalEntityName: string; payerTrack: string; apContactEmail: string; hasPaymentMethod: boolean };
  acceptance: { recordHash: string; termsVersion: string; signingKeyId: string; acceptedAt: string; payerTrack: string };
};

type PayerTrack = 'auto_pay' | 'invoice';

interface FormState {
  merchantId: string;
  legalEntityName: string;
  taxId: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  apContactEmail: string;
  poRequired: boolean;
  poNumber: string;
  payerTrack: PayerTrack;
  paymentMethodRef: string;
  autoPayAuthorized: boolean;
  signerName: string;
  signerTitle: string;
  signerEmail: string;
  acceptTerms: boolean;
}

const EMPTY: FormState = {
  merchantId: '',
  legalEntityName: '',
  taxId: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'US',
  apContactEmail: '',
  poRequired: false,
  poNumber: '',
  payerTrack: 'auto_pay',
  paymentMethodRef: '',
  autoPayAuthorized: false,
  signerName: '',
  signerTitle: '',
  signerEmail: '',
  acceptTerms: false,
};

function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`;
}

export default function OptInPage(): JSX.Element {
  const [terms, setTerms] = useState<Terms | null>(null);
  const [termsErr, setTermsErr] = useState<string | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [f, setF] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OptInResult | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/billing/terms`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setTerms)
      .catch(() => setTermsErr('Could not load the current terms from the API. Is it running?'));
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErrors([]);
    if (!f.acceptTerms) {
      setErrors(['You must accept the terms to enroll.']);
      return;
    }
    setSubmitting(true);
    const payload = {
      merchantId: f.merchantId.trim(),
      legalEntityName: f.legalEntityName.trim(),
      taxId: f.taxId.trim() || undefined,
      billingAddress: { line1: f.line1.trim(), line2: f.line2.trim() || undefined, city: f.city.trim(), region: f.region.trim(), postalCode: f.postalCode.trim(), country: f.country.trim() },
      apContactEmail: f.apContactEmail.trim(),
      poRequired: f.poRequired,
      poNumber: f.poRequired ? f.poNumber.trim() : undefined,
      payerTrack: f.payerTrack,
      paymentMethodRef: f.payerTrack === 'auto_pay' ? f.paymentMethodRef.trim() : undefined,
      autoPayAuthorized: f.payerTrack === 'auto_pay' ? f.autoPayAuthorized : undefined,
      signer: { name: f.signerName.trim(), title: f.signerTitle.trim(), email: f.signerEmail.trim() },
    };
    try {
      const res = await fetch(`${API_BASE}/billing/opt-in`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) {
        setErrors(Array.isArray(data?.errors) ? data.errors : [data?.message || `Request failed (${res.status})`]);
        return;
      }
      setResult(data as OptInResult);
    } catch {
      setErrors([`Could not reach the API at ${API_BASE}. Is it running?`]);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <main className="container">
        <span className="badge">Enrolled</span>
        <h1>You&apos;re set up for billing</h1>
        <p className="subtitle">
          {result.account.legalEntityName} is enrolled on the{' '}
          <strong>{result.account.payerTrack === 'auto_pay' ? 'auto-pay' : 'invoice'}</strong> track. Your acceptance
          of the terms was cryptographically signed and recorded — nothing has been charged.
        </p>
        <div className="success-card">
          <div className="kv-row"><span className="k">Account</span><span>{result.account.accountId}</span></div>
          <div className="kv-row"><span className="k">Merchant</span><span>{result.account.merchantId}</span></div>
          <div className="kv-row"><span className="k">AP invoices go to</span><span>{result.account.apContactEmail}</span></div>
          <div className="kv-row"><span className="k">Terms version</span><span>{result.acceptance.termsVersion}</span></div>
          <div className="kv-row"><span className="k">Signed by key</span><span>{result.acceptance.signingKeyId}</span></div>
          <div className="kv-row" style={{ borderBottom: 'none' }}><span className="k">Signed acceptance</span><span className="mono">{result.acceptance.recordHash}</span></div>
        </div>
        <p className="subtitle" style={{ marginTop: 20 }}>
          <strong>What happens next:</strong> at the end of each month we compute your holdout-proven uplift, issue a
          signed statement, and{' '}
          {result.account.payerTrack === 'auto_pay'
            ? 'auto-charge 12% of the proven amount to your payment method on file.'
            : 'send an invoice (net-14) to your AP inbox above.'}{' '}
          If the holdout hasn&apos;t proven positive uplift, you owe <strong>$0</strong>.
        </p>
        <p style={{ marginTop: 16 }}><a href="/pnl">View your live P&amp;L →</a></p>
      </main>
    );
  }

  return (
    <main className="container">
      <span className="badge">Merchant opt-in</span>
      <h1>Start billing for proven uplift</h1>
      <p className="subtitle">
        Enroll to be billed <strong>12% of the recovery AX10M proves it caused</strong> — measured against your own
        randomized holdout. You&apos;re billed only for uplift we can prove, and <strong>$0</strong> in any month we
        can&apos;t. Enrolling signs the terms; it moves no money.
      </p>

      {termsErr && <div className="errors">{termsErr}</div>}

      {terms && (
        <div className="terms-card">
          <div className="section-title" style={{ marginTop: 0 }}>Your terms — v{terms.version}</div>
          <div className="chips">
            <div className="chip"><span className="chip-v">{pct(terms.feeSchedule.feeRate)}</span><span className="chip-k">of proven uplift</span></div>
            <div className="chip"><span className="chip-v">Net-{terms.feeSchedule.paymentTermsDays}</span><span className="chip-k">payment terms</span></div>
            <div className="chip"><span className="chip-v">{pct(terms.feeSchedule.lateFinanceChargeMonthlyRate)}/mo</span><span className="chip-k">late finance charge</span></div>
            <div className="chip"><span className="chip-v">$0</span><span className="chip-k">until proven</span></div>
          </div>
          <button type="button" className="terms-toggle" onClick={() => setShowTerms((s) => !s)}>
            {showTerms ? 'Hide full terms ▲' : 'Read the full terms ▼'}
          </button>
          {showTerms && <div className="terms-body">{terms.body}</div>}
        </div>
      )}

      {errors.length > 0 && (
        <div className="errors">
          Please fix the following:
          <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <form className="form" onSubmit={submit}>
        <section>
          <div className="section-h">Your company</div>
          <div className="grid-2">
            <div className="field"><label>Legal entity name <span className="req">*</span></label><input value={f.legalEntityName} onChange={(e) => set('legalEntityName', e.target.value)} placeholder="Merchant Inc." /></div>
            <div className="field"><label>Merchant ID <span className="req">*</span></label><input value={f.merchantId} onChange={(e) => set('merchantId', e.target.value)} placeholder="mrc_demo" /><span className="help">Your AX10M merchant identifier (from onboarding).</span></div>
            <div className="field"><label>Tax ID (EIN / VAT)</label><input value={f.taxId} onChange={(e) => set('taxId', e.target.value)} placeholder="12-3456789" /></div>
          </div>
        </section>

        <section>
          <div className="section-h">Billing address</div>
          <div className="grid-2">
            <div className="field full"><label>Address line 1 <span className="req">*</span></label><input value={f.line1} onChange={(e) => set('line1', e.target.value)} placeholder="1 Market St" /></div>
            <div className="field full"><label>Address line 2</label><input value={f.line2} onChange={(e) => set('line2', e.target.value)} placeholder="Suite 400" /></div>
            <div className="field"><label>City <span className="req">*</span></label><input value={f.city} onChange={(e) => set('city', e.target.value)} placeholder="San Francisco" /></div>
            <div className="field"><label>State / region <span className="req">*</span></label><input value={f.region} onChange={(e) => set('region', e.target.value)} placeholder="CA" /></div>
            <div className="field"><label>Postal code <span className="req">*</span></label><input value={f.postalCode} onChange={(e) => set('postalCode', e.target.value)} placeholder="94105" /></div>
            <div className="field"><label>Country <span className="req">*</span></label><input value={f.country} onChange={(e) => set('country', e.target.value.toUpperCase())} maxLength={2} placeholder="US" /><span className="help">2-letter ISO code.</span></div>
          </div>
        </section>

        <section>
          <div className="section-h">Accounts payable</div>
          <div className="grid-2">
            <div className="field full"><label>AP contact email <span className="req">*</span></label><input type="email" value={f.apContactEmail} onChange={(e) => set('apContactEmail', e.target.value)} placeholder="ap@merchant.com" /><span className="help">Every invoice is sent here automatically — no forwarding needed.</span></div>
            <div className="field full">
              <label className="check"><input type="checkbox" checked={f.poRequired} onChange={(e) => set('poRequired', e.target.checked)} /> <span>Our accounts payable requires a PO number on invoices</span></label>
            </div>
            {f.poRequired && <div className="field full"><label>PO number <span className="req">*</span></label><input value={f.poNumber} onChange={(e) => set('poNumber', e.target.value)} placeholder="PO-2026-042" /></div>}
          </div>
        </section>

        <section>
          <div className="section-h">How you&apos;ll pay</div>
          <div className="track">
            <label className={f.payerTrack === 'auto_pay' ? 'on' : ''}>
              <input type="radio" name="track" checked={f.payerTrack === 'auto_pay'} onChange={() => set('payerTrack', 'auto_pay')} />
              <span><span className="t-title">Auto-pay</span><span className="t-desc">We charge your payment method each month. The most seamless option.</span></span>
            </label>
            <label className={f.payerTrack === 'invoice' ? 'on' : ''}>
              <input type="radio" name="track" checked={f.payerTrack === 'invoice'} onChange={() => set('payerTrack', 'invoice')} />
              <span><span className="t-title">Invoice (net-14)</span><span className="t-desc">We invoice your AP department; pay by ACH/wire within 14 days.</span></span>
            </label>
          </div>
          {f.payerTrack === 'auto_pay' && (
            <div className="grid-2" style={{ marginTop: 14 }}>
              <div className="field full"><label>Payment method token <span className="req">*</span></label><input value={f.paymentMethodRef} onChange={(e) => set('paymentMethodRef', e.target.value)} placeholder="pm_..." /><span className="help">In production a secure Stripe card form provides this — <strong>we never see your card number</strong>. Paste a payment-method token here.</span></div>
              <div className="field full"><label className="check"><input type="checkbox" checked={f.autoPayAuthorized} onChange={(e) => set('autoPayAuthorized', e.target.checked)} /> <span>I authorize AX10M to automatically charge this method for each monthly fee.</span></label></div>
            </div>
          )}
        </section>

        <section>
          <div className="section-h">Authorized signer</div>
          <div className="grid-2">
            <div className="field"><label>Full name <span className="req">*</span></label><input value={f.signerName} onChange={(e) => set('signerName', e.target.value)} placeholder="Dana Lee" /></div>
            <div className="field"><label>Title <span className="req">*</span></label><input value={f.signerTitle} onChange={(e) => set('signerTitle', e.target.value)} placeholder="CFO" /></div>
            <div className="field"><label>Email <span className="req">*</span></label><input type="email" value={f.signerEmail} onChange={(e) => set('signerEmail', e.target.value)} placeholder="dana@merchant.com" /></div>
          </div>
        </section>

        <section>
          <label className="check">
            <input type="checkbox" checked={f.acceptTerms} onChange={(e) => set('acceptTerms', e.target.checked)} />
            <span>I have read and, on behalf of the company, agree to the AX10M Recovery Services Agreement{terms ? ` (v${terms.version})` : ''} — 12% of proven uplift, net-14, with a 1.5%/month finance charge on overdue amounts.</span>
          </label>
          <div style={{ marginTop: 18 }}>
            <button className="btn" type="submit" disabled={submitting || !f.acceptTerms}>{submitting ? 'Enrolling…' : 'Accept & enroll'}</button>
          </div>
        </section>
      </form>
    </main>
  );
}
