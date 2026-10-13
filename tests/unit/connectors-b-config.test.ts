import { describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';

/**
 * CONNECTORS B — the configuration step B adds. Shapes and bounds only; the
 * retention period is the owner's to set from the Control Center.
 */

type Publishing = {
  inbound: {
    retentionDays: number;
    purgeBatchSize: number;
    processBatchSize: number;
    maxAttempts: number;
  };
};

const publishing = (payload: unknown) => parseConfigPayload('publishing', payload) as Publishing;

describe('connectors B · publishing.inbound — how long verified deliveries are kept', () => {
  it('defaults to 30 days, 500 rows a pass; 50 deliveries acted on per pass, 10 tries each', () => {
    expect(publishing({}).inbound).toEqual({
      retentionDays: 30,
      purgeBatchSize: 500,
      processBatchSize: 50,
      maxAttempts: 10,
    });
  });

  it('bounds how many deliveries are acted on per pass, and how often one is tried', () => {
    expect(publishing({ inbound: { processBatchSize: 1_000 } }).inbound.processBatchSize).toBe(
      1_000,
    );
    expect(() => publishing({ inbound: { processBatchSize: 0 } })).toThrow();
    expect(() => publishing({ inbound: { processBatchSize: 1_001 } })).toThrow();
    expect(publishing({ inbound: { maxAttempts: 1 } }).inbound.maxAttempts).toBe(1);
    expect(() => publishing({ inbound: { maxAttempts: 0 } })).toThrow();
    expect(() => publishing({ inbound: { maxAttempts: 101 } })).toThrow();
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
