import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATED_CACHE_CONTROL,
  contentSecurityPolicy,
  securityHeaders,
} from '@brandspace/shared';

/**
 * Response security headers — Phase 10 §21.
 *
 * WHY A TEST AND NOT A GLANCE. A CSP is one long string, and every one of its
 * directives is load-bearing in a way that reads as noise: a missing
 * `object-src 'none'` leaves a Flash-era plugin vector open, a missing
 * `base-uri` lets an injected `<base>` redirect every relative script, and a
 * missing `form-action` lets an injected form post a customer's input to
 * somebody else's server. None of those is visible by looking at the string.
 */

const NONCE = 'test-nonce-value';

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const trimmed = part.trim();
      const space = trimmed.indexOf(' ');
      return space === -1 ? [trimmed, ''] : [trimmed.slice(0, space), trimmed.slice(space + 1)];
    }),
  );
}

describe('the content security policy', () => {
  it('carries the request nonce and strict-dynamic', () => {
    // The nonce is what makes the policy hold as the bundle changes:
    // `'strict-dynamic'` lets an admitted script load its own chunks, so a
    // moved file does not need a new host in an allow-list.
    const policy = directives(contentSecurityPolicy({ nonce: NONCE }));
    expect(policy.get('script-src')).toContain(`'nonce-${NONCE}'`);
    expect(policy.get('script-src')).toContain("'strict-dynamic'");
  });

  it('never admits inline SCRIPT', () => {
    const policy = directives(contentSecurityPolicy({ nonce: NONCE }));
    expect(policy.get('script-src')).not.toContain("'unsafe-inline'");
    expect(policy.get('script-src')).not.toContain("'unsafe-eval'");
  });

  it('admits inline STYLE, and only as an attribute', () => {
    /*
     * The honest exception. This product styles through React `style` objects,
     * which become style ATTRIBUTES, and CSP has no nonce mechanism for those.
     * `style-src-attr` scopes the allowance to attributes rather than blessing
     * arbitrary `<style>` blocks, and removing it is a design-system rewrite
     * rather than a security fix.
     */
    const policy = directives(contentSecurityPolicy({ nonce: NONCE }));
    expect(policy.get('style-src-attr')).toBe("'unsafe-inline'");
  });

  it('closes the four directives whose absence is the classic gap', () => {
    const policy = directives(contentSecurityPolicy({ nonce: NONCE }));
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'self'");
    expect(policy.get('form-action')).toBe("'self'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
  });

  it('restricts connect-src to this origin unless one is named', () => {
    expect(directives(contentSecurityPolicy({ nonce: NONCE })).get('connect-src')).toBe("'self'");
    expect(
      directives(
        contentSecurityPolicy({ nonce: NONCE, connectOrigins: ['https://api.example'] }),
      ).get('connect-src'),
    ).toBe("'self' https://api.example");
  });

  it('gives each request its own nonce', () => {
    // Reusing one across responses would make the policy a formality: an
    // attacker who read one page would know the value to forge.
    expect(contentSecurityPolicy({ nonce: 'a' })).not.toBe(contentSecurityPolicy({ nonce: 'b' }));
  });
});

describe('the static policy, for a prerendered site', () => {
  /*
   * WHY THERE ARE TWO POLICIES AT ALL, and it is not a preference. A nonce is
   * minted per request and stamped into the HTML; a page rendered at BUILD time
   * carries none, `'strict-dynamic'` then disables host allow-listing, and the
   * framework's own chunks are all refused. An end-to-end run found this: the
   * public site rendered with no JavaScript whatsoever.
   */
  it('drops the nonce and strict-dynamic, and admits inline instead', () => {
    const policy = directives(contentSecurityPolicy({ nonce: null, rendering: 'static' }));
    expect(policy.get('script-src')).toBe("'self' 'unsafe-inline'");
    expect(policy.get('script-src')).not.toContain('strict-dynamic');
  });

  it('still refuses every cross-origin script, which is the vector that matters', () => {
    // It does not stop an inline injection, and that is the stated cost. It
    // does stop the injection from shipping anything anywhere.
    const policy = directives(contentSecurityPolicy({ nonce: null, rendering: 'static' }));
    expect(policy.get('script-src')).not.toContain('http');
    expect(policy.get('script-src')).not.toContain('*');
  });

  it('keeps every other directive exactly as strict', () => {
    const staticPolicy = directives(contentSecurityPolicy({ nonce: null, rendering: 'static' }));
    const dynamicPolicy = directives(contentSecurityPolicy({ nonce: NONCE }));
    for (const directive of [
      'object-src',
      'base-uri',
      'form-action',
      'frame-ancestors',
      'connect-src',
    ]) {
      expect(staticPolicy.get(directive), directive).toBe(dynamicPolicy.get(directive));
    }
  });
});

describe('the rest of the header set', () => {
  it('sends HSTS in production and never outside it', () => {
    /*
     * Over http it means nothing, and from a developer's machine it would pin
     * `localhost` to https in their browser for two years — a genuinely
     * unpleasant thing to debug.
     */
    expect(securityHeaders({ nonce: NONCE, production: true })).toHaveProperty(
      'Strict-Transport-Security',
    );
    expect(securityHeaders({ nonce: NONCE, production: false })).not.toHaveProperty(
      'Strict-Transport-Security',
    );
  });

  it('keeps the four baseline headers the apps already had', () => {
    const headers = securityHeaders({ nonce: NONCE, production: false });
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });

  it('isolates the browsing context', () => {
    expect(securityHeaders({ nonce: NONCE, production: false })['Cross-Origin-Opener-Policy']).toBe(
      'same-origin',
    );
  });
});

describe('the cache policy behind a session', () => {
  it('sets both private and no-store, because different things read each', () => {
    /*
     * A shared proxy obeys `private`; a browser's back/forward cache obeys
     * `no-store`. The classic disclosure is sign out, press Back, and read the
     * previous customer's invoices on a shared machine — and only one of the
     * two directives prevents it.
     */
    expect(AUTHENTICATED_CACHE_CONTROL).toContain('private');
    expect(AUTHENTICATED_CACHE_CONTROL).toContain('no-store');
    expect(AUTHENTICATED_CACHE_CONTROL).toContain('must-revalidate');
  });
});
