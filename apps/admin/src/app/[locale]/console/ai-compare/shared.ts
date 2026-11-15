import type { CompareSide } from '../../../../server/image-compare';

/** The formats the bench offers: the Studio's square, portrait post and story. */
export const COMPARE_FORMATS: readonly string[] = ['1024x1024', '1080x1350', '1080x1920'];

export type CompareSideView = Omit<CompareSide, 'costMicroMinor'> & {
  /** Micro-minor units of `costCurrency`, as a decimal string (it is a bigint on the server). */
  readonly costMicroMinor: string | null;
};

export interface CompareState {
  readonly error?: 'FORBIDDEN' | 'BRIEF' | 'INVALID' | 'FAILED';
  readonly format?: string;
  readonly quality?: string;
  readonly sides?: readonly CompareSideView[];
}
