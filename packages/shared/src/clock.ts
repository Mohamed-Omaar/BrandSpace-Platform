/** Injected clock so time-dependent logic is testable. Enforced by a lint rule. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  // eslint-disable-next-line no-restricted-syntax -- the one place a real clock is read
  now: () => new Date(),
};

export function fixedClock(instant: Date): Clock {
  return { now: () => new Date(instant.getTime()) };
}
