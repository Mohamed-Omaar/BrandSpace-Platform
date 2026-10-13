import { describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';

/**
 * CONNECTORS B — the configuration step B adds. Shapes and bounds only; the
 * retention period is the owner's to set from the Control Center.
 */

type Publishing = {
  inbound: { retentionDays: number; purgeBatchSize: number };
};

const publishing = (payload: unknown) => parseConfigPayload('publishing', payload) as Publishing;

describe('connectors B · publishing.inbound — how long verified deliveries are kept', () => {
  it('defaults to 30 days, 500 rows a pass', () => {
    expect(publishing({}).inbound).toEqual({ retentionDays: 30, purgeBatchSize: 500 });
  });

  it('takes the owner’s period within 1–365 days', () => {
    expect(publishing({ inbound: { retentionDays: 7 } }).inbound.retentionDays).toBe(7);
    expect(publishing({ inbound: { retentionDays: 365 } }).inbound.retentionDays).toBe(365);
    expect(() => publishing({ inbound: { retentionDays: 0 } })).toThrow();
    expect(() => publishing({ inbound: { retentionDays: 366 } })).toThrow();
    expect(() => publishing({ inbound: { retentionDays: 1.5 } })).toThrow();
  });

  it('bounds the batch', () => {
    expect(() => publishing({ inbound: { purgeBatchSize: 0 } })).toThrow();
    expect(() => publishing({ inbound: { purgeBatchSize: 10_001 } })).toThrow();
  });
});
