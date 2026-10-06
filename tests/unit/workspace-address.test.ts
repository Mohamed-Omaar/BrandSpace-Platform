import { describe, expect, it } from 'vitest';
import { suggestedWorkspaceAddress } from '../../apps/dashboard/src/components/workspace-address';

/** Step 7 (7.1) — the Business step suggests the address instead of stopping on it. */
describe('suggestedWorkspaceAddress', () => {
  const pattern = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

  it('follows the business name, in the field’s own pattern', () => {
    expect(suggestedWorkspaceAddress('Layla Bakery', 'layla@example.local')).toBe('layla-bakery');
    expect(suggestedWorkspaceAddress('  Café Ümit & Sons!  ', 'x@example.local')).toBe(
      'cafe-umit-sons',
    );
    expect(suggestedWorkspaceAddress('Layla Bakery', 'a@b.c')).toMatch(pattern);
  });

  it('uses the account’s address for a name with no Latin letters', () => {
    expect(suggestedWorkspaceAddress('مخبز ليلى', 'layla.hassan@example.local')).toBe(
      'layla-hassan',
    );
  });

  it('keeps within 50 characters and never ends on a dash', () => {
    const long = suggestedWorkspaceAddress(`${'a'.repeat(49)} b`, 'x@example.local');
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long).toMatch(pattern);
  });

  it('suggests nothing when neither gives three characters', () => {
    expect(suggestedWorkspaceAddress('مخبز', 'ab@example.local')).toBe('');
  });
});
