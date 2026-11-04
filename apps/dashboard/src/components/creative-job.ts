'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * PR 1 (D-597) — FOLLOW ONE IMAGE JOB.
 *
 * An image is a background job: the screen asks its state from a small
 * status route rather than re-rendering the page (`router.refresh()` every
 * few seconds was the staging request storm). Owner rules for a status poll:
 *
 *   - it NEVER SHOWS A WRONG STATE: only what the job's row says. A failed
 *     request keeps the last known state; nothing is guessed from time;
 *   - it PAUSES WHILE THE TAB IS HIDDEN, and asks again as soon as it is
 *     visible;
 *   - it STOPS after `maxMs` with `stale: true`, so the screen says "still
 *     working, refresh to check" instead of polling for ever.
 */
export interface CreativeJobState {
  readonly id: string;
  readonly status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly assetId: string | null;
  readonly attached: boolean;
  readonly failureReason: string | null;
  readonly creditsChargedMilli: string | null;
  readonly formatKey: string;
  readonly contentVariantId: string | null;
}

export interface FollowedJob {
  readonly job: CreativeJobState | null;
  /** A short-lived preview token for the finished image, when it has one. */
  readonly previewToken: string | null;
  /** The finished image's name in the library, when known. */
  readonly name: string | null;
  /** The poll gave up after `maxMs`: the job may still be working. */
  readonly stale: boolean;
}

export const CREATIVE_JOB_POLL_MS = 2_500;
export const CREATIVE_JOB_POLL_MAX_MS = 5 * 60_000;

export function finished(job: CreativeJobState | null): boolean {
  return job?.status === 'SUCCEEDED' || job?.status === 'FAILED';
}

export function useCreativeJob(
  jobId: string | null,
  options: { readonly locale: string; readonly everyMs?: number; readonly maxMs?: number },
): FollowedJob {
  const everyMs = options.everyMs ?? CREATIVE_JOB_POLL_MS;
  const maxMs = options.maxMs ?? CREATIVE_JOB_POLL_MAX_MS;
  const [state, setState] = useState<FollowedJob>({
    job: null,
    previewToken: null,
    name: null,
    stale: false,
  });
  const locale = useRef(options.locale);
  locale.current = options.locale;

  useEffect(() => {
    setState({ job: null, previewToken: null, name: null, stale: false });
    if (!jobId) return;
    let stopped = false;
    let timer = 0;
    const started = Date.now();

    const ask = async (): Promise<boolean> => {
      const response = await fetch(
        `/api/creative/jobs/${encodeURIComponent(jobId)}?locale=${encodeURIComponent(locale.current)}`,
        { cache: 'no-store' },
      ).catch(() => null);
      if (stopped || !response?.ok) return false;
      const payload = (await response.json().catch(() => null)) as {
        job?: CreativeJobState;
        previewToken?: string;
        name?: string;
      } | null;
      if (!payload?.job || stopped) return false;
      const job = payload.job;
      setState({
        job,
        previewToken: payload.previewToken ?? null,
        name: payload.name ?? null,
        stale: false,
      });
      return finished(job);
    };

    const tick = async () => {
      if (stopped) return;
      if (Date.now() - started > maxMs) {
        setState((current) => ({ ...current, stale: true }));
        return;
      }
      if (document.visibilityState === 'hidden') return; // resumed by `onVisible`
      const done = await ask();
      if (!done && !stopped) timer = window.setTimeout(() => void tick(), everyMs);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [jobId, everyMs, maxMs]);

  return state;
}
