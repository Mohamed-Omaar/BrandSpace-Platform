import { describe, expect, it } from 'vitest';
import { initialsFrom, personInitials } from '../../packages/ui/src/media';

/**
 * Gate 2b review (4i) — a person's initials are Latin in both languages, as
 * the prototype's Arabic screens draw them.
 */
describe('personInitials', () => {
  it('uses a Latin name as it is', () => {
    expect(personInitials('Sara Nabil', 'sara@example.test')).toBe('SN');
  });

  it('falls back to the address when the name has no Latin letters', () => {
    expect(personInitials('ريم القحطاني', 'reema.q@example.test')).toBe('RQ');
  });

  it('uses the address when there is no name', () => {
    expect(personInitials(null, 'omar@example.test')).toBe(initialsFrom('omar@example.test'));
    expect(personInitials('  ', 'omar@example.test')).toBe('OM');
  });

  it('keeps the name only when there is no address', () => {
    expect(personInitials('ريم', null)).toBe(initialsFrom('ريم'));
  });
});
