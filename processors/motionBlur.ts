import type { Processor } from './types';
import { num } from './types';

/**
 * Motion blur.
 *
 * `tmix` averages a sliding window of N frames, which is exactly what a longer
 * exposure does: static areas stay sharp, moving ones smear. The output frame
 * rate is unchanged (tmix emits one frame per input frame), so the clip keeps
 * its original duration.
 */
export const motionBlurProcessor: Processor = (level) => {
  const frames = Math.max(2, Math.round(num(level, 'frames')));

  return {
    filters: [`tmix=frames=${frames}:weights='${'1 '.repeat(frames).trim()}'`],
    outputArgs: [],
    params: {
      frames,
      weighting: 'uniform',
      filter: 'tmix',
    },
  };
};
