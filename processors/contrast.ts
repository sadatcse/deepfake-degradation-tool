import type { Processor } from './types';
import { num } from './types';

/**
 * Contrast reduction.
 *
 * `eq=contrast` is multiplicative around mid-grey: 1.0 leaves the image alone,
 * values below 1.0 flatten the tonal range.
 */
export const contrastProcessor: Processor = (level) => {
  const contrast = Math.max(0, Math.min(2, num(level, 'contrast')));
  const percent = level.params.percent ?? Math.round((contrast - 1) * 100);

  return {
    filters: [`eq=contrast=${contrast}`],
    outputArgs: [],
    params: {
      contrast,
      percent,
      filter: 'eq',
    },
  };
};
