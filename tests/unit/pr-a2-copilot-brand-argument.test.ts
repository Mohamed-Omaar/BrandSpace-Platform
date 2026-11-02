import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_TOOLS as TOOLS,
  describeArguments,
  findTool,
  modelArguments,
} from '@brandspace/copilot';

/**
 * PR A2 — COPILOT "THAT ITEM NO LONGER EXISTS." FROM HOME AND THE STUDIO.
 *
 * The tool list told the model `approvals.summary arguments: {brandId: uuid}`
 * and never told it the brand's id. A real model filled the argument with an
 * id of its own; the plan builder refused a brand that is not the session's
 * with the 404 shape, and the customer read "That item no longer exists.".
 *
 * Now the model is never asked for `brandId` — the platform sets it — and an
 * argument that is no id at all is the session's brand. A well-formed id of
 * ANOTHER brand is still refused (the isolation suites hold that).
 */
describe('PR A2 — the model is never asked for the brand', () => {
  it('no brand tool lists brandId among the arguments the model writes', () => {
    for (const tool of TOOLS.filter((t) => t.brandScope === 'required')) {
      expect(describeArguments(modelArguments(tool)), tool.key).not.toContain('brandId');
    }
    expect(describeArguments(modelArguments(findTool('approvals.summary')!))).toBe('{}');
  });

  it('the other arguments are still asked for, unchanged', () => {
    const tool = TOOLS.find((t) => t.brandScope === 'required' && t.key.includes('content'))!;
    const full = describeArguments(tool.input);
    const asked = describeArguments(modelArguments(tool));
    expect(full).toContain('brandId');
    expect(asked.length).toBeGreaterThan(2);
    expect(full.replace(/brandId: uuid,? ?/, '')).toBe(asked);
  });

  it('the prompt says the platform sets the brand, and a non-id is the session brand', () => {
    const source = readFileSync('packages/copilot/src/orchestrator.ts', 'utf8');
    expect(source).toContain(
      'Never write "brandId": the platform sets it to this conversation\\\'s brand.',
    );
    expect(source).toContain('describeArguments(modelArguments(tool))');
    expect(source).toMatch(
      /args\['brandId'\] === undefined \|\| !UUID_SHAPE\.test\(String\(args\['brandId'\]\)\)/,
    );
  });
});
