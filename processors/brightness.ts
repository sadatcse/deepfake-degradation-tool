import type { Processor } from './types';
import { num } from './types';

/**
 * Brightness reduction.
 *
 * `eq=brightness` is additive over the normalised [-1, 1] range, so -0.25 is
 * the "-25%" the spec asks for. `eval=frame` is not needed: the value is
 * constant for the whole clip.
 */
export const brightnessProcessor: Processor = (level) => {
  const brightness = Math.max(-1, Math.min(1, num(level, 'brightness')));
  const percent = level.params.percent ?? Math.round(brightness * 100);

  return {
    filters: [`eq=brightness=${brightness}`],
    outputArgs: [],
    params: {
      brightness,
      percent,
      filter: 'eq',
    },
  };
};
