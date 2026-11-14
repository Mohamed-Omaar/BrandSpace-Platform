'use client';

import { useEffect, useState } from 'react';

/**
 * ROUND 4 (4.1) — THE TIME ZONE IS THE BROWSER'S, NOT A SIGN-UP QUESTION.
 *
 * The owner's decision: sign-up no longer asks for a zone; the browser's own
 * IANA zone is sent instead, and onboarding step 1 shows it and lets the
 * person change it. D-194 still holds where it matters — the SERVER never
 * invents one: a browser that reports nothing sends an empty value, which the
 * sign-up service refuses exactly as before.
 */
export function detectedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

export function BrowserTimeZoneInput({
  name = 'timezone',
  testId = 'signup-timezone',
}: {
  readonly name?: string;
  readonly testId?: string;
}) {
  const [zone, setZone] = useState('');
  useEffect(() => {
    setZone(detectedTimeZone());
  }, []);
  return <input type="hidden" name={name} value={zone} data-testid={testId} />;
}
