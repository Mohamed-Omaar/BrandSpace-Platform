'use client';

import Link from 'next/link';
import { useState } from 'react';

/**
 * SIGN-IN'S PASSWORD ROW — `Auth.dc.html` line 47 (review of #67).
 *
 * The label with "Forgot password?" on the same line, then the field with the
 * prototype's "Show" inside it (`.pw .show`: 7px in from the trailing edge, a
 * white 10px-radius button at 13px / 800). Show only changes what the field
 * displays; what is posted, and how it is checked, is unchanged.
 */
export function SignInPassword({
  label,
  forgot,
  forgotHref,
  show,
  hide,
}: {
  readonly label: string;
  readonly forgot: string;
  readonly forgotHref: string;
  readonly show: string;
  readonly hide: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="bsp-pw-row">
      <div className="bsp-pw-head">
        <label htmlFor="password">{label}</label>
        <Link href={forgotHref} className="bsp-lnk" data-testid="signin-forgot">
          {forgot}
        </Link>
      </div>
      <div className="bsp-pw">
        <input
          className="bs-control bsp-ltr"
          id="password"
          name="password"
          type={shown ? 'text' : 'password'}
          required
          autoComplete="current-password"
        />
        <button
          type="button"
          className="bsp-pw-show"
          aria-pressed={shown}
          aria-controls="password"
          aria-label={shown ? hide : show}
          data-testid="signin-password-show"
          onClick={() => setShown((previous) => !previous)}
        >
          <span aria-hidden="true">{shown ? hide : show}</span>
        </button>
      </div>
    </div>
  );
}
