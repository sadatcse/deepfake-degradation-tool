import type { Processor } from './types';
import { num } from './types';

/**
 * Saturation reduction.
 *
 * `eq=saturation` scales chroma: 1.0 leaves colour alone, 0.0 is greyscale.
 */
export const saturationProcessor: Processor = (level) => {
  const saturation = Math.max(0, Math.min(3, num(level, 'saturation')));
  const percent = level.params.percent ?? Math.round((saturation - 1) * 100);

  return {
    filters: [`eq=saturation=${saturation}`],
    outputArgs: [],
    params: {
      saturation,
      percent,
      filter: 'eq',
    },
  };
};
