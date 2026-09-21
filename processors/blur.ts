import type { Processor } from './types';
import { num } from './types';

/**
 * Gaussian blur.
 *
 * The catalogue is expressed as a pixel radius (5 / 10 / 20 per the spec).
 * `gblur` takes a standard deviation, so radius is converted with the usual
 * sigma = radius / 3 approximation. Both numbers are recorded in metadata so a
 * later experiment can report either one.
 *
 * `steps` is raised for the heavier levels: gblur approximates a true gaussian
 * by repeated box passes, and a wide sigma needs more passes to stay smooth.
 */
export const blurProcessor: Processor = (level, ctx) => {
  const radius = num(level, 'radius');
  const sigma = Number((radius / 3).toFixed(3));

  // A blur wider than the frame itself is not meaningful; clamp to a quarter of
  // the shorter side so tiny sources do not turn into flat colour.
  const shortSide = Math.min(ctx.video.width ?? Infinity, ctx.video.height ?? Infinity);
  const maxSigma = Number.isFinite(shortSide) ? Math.max(0.5, shortSide / 8) : sigma;
  const appliedSigma = Number(Math.min(sigma, maxSigma).toFixed(3));

  const steps = radius >= 20 ? 3 : radius >= 10 ? 2 : 1;

  return {
    filters: [`gblur=sigma=${appliedSigma}:steps=${steps}`],
    outputArgs: [],
    params: {
      radius,
      sigma: appliedSigma,
      requestedSigma: sigma,
      steps,
      filter: 'gblur',
    },
  };
};
