import type { Processor } from './types';
import { num } from './types';

/**
 * Compression artefacts.
 *
 * No video filter at all - the degradation *is* the encode. The CRF returned
 * here replaces the job's base CRF, and the UI surfaces it before processing
 * starts so the operator can see exactly what will be applied.
 */
export const compressionProcessor: Processor = (level) => {
  const crf = Math.max(0, Math.min(51, num(level, 'crf')));

  return {
    filters: [],
    outputArgs: [],
    crf,
    params: {
      crf,
      encoder: 'libx264',
    },
  };
};
