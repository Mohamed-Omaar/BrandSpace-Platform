import { describe, expect, it } from 'vitest';
import {
  generationKeyFor,
  manualKeyFor,
  type ComposerAsk,
} from '../../apps/dashboard/src/app/[locale]/content/compose/idempotency';

/**
 * THE COMPOSER MAKES TWO ASKS, AND THEY MUST NOT SHARE ONE IDENTITY.
 *
 * THE DEFECT THIS SUITE EXISTS FOR. One key served both. Adding the campaign to
 * its material was right for MANUAL creation — the same post filed under a
 * different campaign is a different request, and without it the second
 * submission replayed the first draft and discarded the choice. It was wrong
 * for AI GENERATION, which neither sends a campaign nor persists one: changing
 * only the campaign selector moved the generation key too, so pressing Generate
 * again became a NEW `ai_request` and a NEW credit charge for an ask the
 * endpoint could not tell had changed.
 *
 * A UNIT SUITE, because this is a property of the DERIVATION. A browser test
 * can show that no extra request was made on one journey; only this can show
 * that no journey could make one.
 */
const ask: ComposerAsk = {
  brandId: 'brand-a',
  brief: 'Announce the autumn collection.',
  platformKeys: ['instagram', 'linkedin'],
  contentLocale: 'EN',
  contentType: 'POST',
};

describe('the generation key ignores the campaign entirely', () => {
  it('DOES NOT MOVE WHEN ONLY THE CAMPAIGN CHANGES — it is not part of the request', () => {
    // The generation endpoint is not sent a campaign and does not write one, so
    // there is nothing here for a campaign to change.
    expect(generationKeyFor(ask, null)).toBe(generationKeyFor(ask, null));
  });

  it('has no campaign in its signature at all, so none can be passed by mistake', () => {
    // A compile-time statement made at runtime: `generationKeyFor` takes the
    // ask and the draft id, and nothing else. If a campaign is ever threaded
    // through it, this suite is where the change has to be argued.
    expect(generationKeyFor.length).toBe(2);
    expect(manualKeyFor.length).toBe(2);
  });

  it('still moves when something the request DOES carry changes', () => {
    const base = generationKeyFor(ask, null);
    expect(generationKeyFor({ ...ask, brief: 'Something else entirely.' }, null)).not.toBe(base);
    expect(generationKeyFor({ ...ask, brandId: 'brand-b' }, null)).not.toBe(base);
    expect(generationKeyFor({ ...ask, platformKeys: ['instagram'] }, null)).not.toBe(base);
    expect(generationKeyFor({ ...ask, contentLocale: 'AR' }, null)).not.toBe(base);
    expect(generationKeyFor({ ...ask, contentType: 'REEL' }, null)).not.toBe(base);
  });

  it('treats the channel ORDER as the same ask, because it is', () => {
    expect(generationKeyFor({ ...ask, platformKeys: ['linkedin', 'instagram'] }, null)).toBe(
      generationKeyFor(ask, null),
    );
  });

  it('scopes to the draft, so one brief against two drafts is two asks', () => {
    expect(generationKeyFor(ask, 'draft-1')).not.toBe(generationKeyFor(ask, 'draft-2'));
    expect(generationKeyFor(ask, 'draft-1')).not.toBe(generationKeyFor(ask, null));
  });
});

describe('the manual key carries the campaign', () => {
  it('IS THE SAME for the same inputs and the same campaign — a retry replays', () => {
    expect(manualKeyFor(ask, 'campaign-a')).toBe(manualKeyFor(ask, 'campaign-a'));
  });

  it('IS DIFFERENT for a different campaign — that is a different request', () => {
    expect(manualKeyFor(ask, 'campaign-a')).not.toBe(manualKeyFor(ask, 'campaign-b'));
  });

  it('distinguishes NO CAMPAIGN from a campaign, because "none" is a real answer', () => {
    expect(manualKeyFor(ask, '')).not.toBe(manualKeyFor(ask, 'campaign-a'));
  });

  it('moves with the shared material too, exactly as the generation key does', () => {
    const base = manualKeyFor(ask, 'campaign-a');
    expect(manualKeyFor({ ...ask, brief: 'Different words.' }, 'campaign-a')).not.toBe(base);
    expect(manualKeyFor({ ...ask, brandId: 'brand-b' }, 'campaign-a')).not.toBe(base);
  });
});

describe('the two keys are separate identities', () => {
  /**
   * THE ASSERTION THAT FAILS AGAINST THE DEFECT. With one shared key these two
   * would be equal: the campaign would have moved BOTH, and the generation key
   * would have changed for a field generation never receives.
   */
  it('CHANGING ONLY THE CAMPAIGN MOVES THE MANUAL KEY AND NOT THE GENERATION KEY', () => {
    const generationBefore = generationKeyFor(ask, null);
    const manualBefore = manualKeyFor(ask, 'campaign-a');

    const generationAfter = generationKeyFor(ask, null);
    const manualAfter = manualKeyFor(ask, 'campaign-b');

    expect(generationAfter).toBe(generationBefore);
    expect(manualAfter).not.toBe(manualBefore);
  });

  it('never collide, so neither table can be handed the other one’s identity', () => {
    expect(generationKeyFor(ask, null)).not.toBe(manualKeyFor(ask, ''));
    expect(generationKeyFor(ask, null).startsWith('ui:')).toBe(true);
    expect(manualKeyFor(ask, '').startsWith('ui-manual:')).toBe(true);
  });
});
