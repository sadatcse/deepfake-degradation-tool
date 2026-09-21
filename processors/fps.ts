import type { Processor } from './types';
import { num } from './types';

/**
 * Frame rate reduction.
 *
 * The source rate is detected by ffprobe first. If it already sits at or below
 * the requested rate the task is skipped rather than resampled upwards - the
 * spec is explicit that FPS must never be increased unless asked for.
 */
export const fpsProcessor: Processor = (level, ctx) => {
  const target = num(level, 'fps');
  const sourceFps = ctx.video.fps;

  if (sourceFps !== null && sourceFps > 0 && sourceFps <= target + 0.01) {
    return {
      filters: [],
      outputArgs: [],
      skip: `source is ${sourceFps.toFixed(2)} fps, already at or below ${target} fps (never upscaled)`,
      params: { targetFps: target, sourceFps },
    };
  }

  return {
    filters: [`fps=${target}`],
    outputArgs: [],
    outputFps: target,
    params: {
      targetFps: target,
      sourceFps: sourceFps ?? 'unknown',
      filter: 'fps',
    },
  };
};
