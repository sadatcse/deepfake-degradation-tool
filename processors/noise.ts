import type { Processor } from './types';
import { num } from './types';

/**
 * Additive video noise.
 *
 * `allf=t+u` asks for temporal (a fresh pattern every frame) uniform noise,
 * which is what a noisy sensor produces. A fixed seed keeps runs reproducible -
 * important when the output feeds a detection experiment.
 */
export const noiseProcessor: Processor = (level) => {
  const strength = Math.max(0, Math.min(100, num(level, 'strength')));
  const seed = 20260919;

  return {
    filters: [`noise=alls=${strength}:allf=t+u:all_seed=${seed}`],
    outputArgs: [],
    params: {
      strength,
      flags: 't+u',
      seed,
      filter: 'noise',
    },
  };
};
