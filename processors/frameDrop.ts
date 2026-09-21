import type { Processor } from './types';
import { num } from './types';

/**
 * Frame dropping.
 *
 * A frame is kept when `mod(n * percent, 100) >= percent`. That yields exactly
 * the requested drop rate, spreads the dropped frames evenly instead of losing
 * them in bursts, and is fully deterministic - re-running the tool reproduces
 * the same dataset, which a random() based selector would not.
 *
 *   30% -> drops n mod 10 in {0, 4, 7}   (3 of every 10 frames)
 *   10% -> drops n mod 10 == 0           (1 of every 10 frames)
 *    5% -> drops n mod 20 == 0           (1 of every 20 frames)
 *
 * Timestamps are deliberately *not* rebased. Combined with constant-frame-rate
 * output that keeps the original duration and holds the previous frame over
 * each gap, reproducing the stutter of a lossy capture rather than simply
 * producing a shorter clip.
 */
export const frameDropProcessor: Processor = (level, ctx) => {
  const percent = Math.max(0, Math.min(99, num(level, 'percent')));

  if (percent === 0) {
    return {
      filters: [],
      outputArgs: [],
      skip: 'drop percentage is 0%',
      params: { percent },
    };
  }

  // Single quotes protect the commas from the filtergraph parser.
  const expr = `select='gte(mod(n*${percent},100),${percent})'`;

  return {
    filters: [expr],
    outputArgs: [],
    forceCfr: true,
    outputFps: ctx.video.fps ?? undefined,
    params: {
      percent,
      selector: `mod(n*${percent},100) >= ${percent}`,
      deterministic: 'yes',
      durationPreserved: 'yes',
    },
  };
};
