import QRCode from 'qrcode';
import {
  Field,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';

/**
 * SETTING UP AN AUTHENTICATOR (G4 / Q23, prototype v94 Phase 2B-1, D-333).
 *
 * A QR code to scan, the same key to type in, then a 6-digit code to prove the
 * phone has it. Server-rendered from the enrolment in progress
 * (`SignupService.pendingEnrolment`), so the seed is never put in a URL — it
 * exists in this one response to its own person, and nowhere a log, a Referer
 * or the browser history could keep it.
 *
 * The QR code is a PNG data URL (the security headers allow `data:` images),
 * so no generated markup is injected into the page. Shared by Settings →
 * Security (first enrolment and "New phone") and the page a workspace that
 * requires two-step sends a member to.
 *
 * AN APPROVED DESIGN-SYSTEM EXTENSION: `Field`, the input and button styles,
 * the caption type and the card spacing — nothing new.
 */
export async function MfaEnrolmentPanel({
  locale,
  otpauthUri,
  secret,
  action,
  from,
  labels,
  testId = 'mfa-enrolment',
}: {
  readonly locale: string;
  readonly otpauthUri: string;
  readonly secret: string;
  readonly action: (formData: FormData) => Promise<void>;
  /** Where the confirmation returns on a wrong code. */
  readonly from: 'security' | 'setup';
  readonly labels: {
    readonly scan: string;
    readonly qrAlt: string;
    readonly typeKey: string;
    readonly code: string;
    readonly confirm: string;
  };
  readonly testId?: string;
}) {
  const qr = await QRCode.toDataURL(otpauthUri, {
    margin: 1,
    width: 192,
    errorCorrectionLevel: 'M',
  });
  // The key as people type it: groups of four.
  const typedKey = secret.replace(/(.{4})/g, '$1 ').trim();
  return (
    <form action={action} data-testid={testId} style={{ display: 'grid', gap: spacingTokens.md }}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="from" value={from} />
      <p style={typographyTokens.bodySm}>{labels.scan}</p>
      <img
        src={qr}
        alt={labels.qrAlt}
        width={192}
        height={192}
        data-testid={`${testId}-qr`}
        style={{ background: colorTokens.surface }}
      />
      <div>
        <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted, margin: 0 }}>
          {labels.typeKey}
        </p>
        <code
          data-testid={`${testId}-key`}
          dir="ltr"
          style={{ ...typographyTokens.body, letterSpacing: '0.05em', wordBreak: 'break-all' }}
        >
          {typedKey}
        </code>
      </div>
      <Field label={labels.code} htmlFor={`${testId}-code`}>
        <input
          className="bs-control"
          id={`${testId}-code`}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={6}
          data-testid={`${testId}-code`}
          style={inputStyle()}
        />
      </Field>
      <div>
        <button type="submit" data-testid={`${testId}-confirm`} style={buttonStyle('primary')}>
          {labels.confirm}
        </button>
      </div>
    </form>
  );
}
