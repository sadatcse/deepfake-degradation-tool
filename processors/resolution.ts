import type { Processor } from './types';
import { num } from './types';

/** Round to the nearest even number (H.264 requires even dimensions). */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Low resolution.
 *
 * "480p" is taken to mean *the shorter side* is 480px, so portrait clips are
 * treated the same way landscape ones are. Aspect ratio is always preserved and
 * the source is never upscaled - a 360p source asked for 480p is skipped rather
 * than blown up, because an upscaled copy is not a degradation.
 *
 * When ffprobe could not report dimensions the equivalent decision is pushed
 * into an ffmpeg expression so the guarantees still hold.
 */
export const resolutionProcessor: Processor = (level, ctx) => {
  const target = num(level, 'height');
  const { width, height } = ctx.video;

  if (width === null || height === null || width <= 0 || height <= 0) {
    // Dimensions unknown: clamp inside ffmpeg. min() prevents upscaling and
    // trunc(x/2)*2 keeps the explicit side even; -2 derives the other side.
    const w = `if(gt(iw,ih),-2,trunc(min(${target},iw)/2)*2)`;
    const h = `if(gt(iw,ih),trunc(min(${target},ih)/2)*2,-2)`;
    return {
      filters: [`scale=w='${w}':h='${h}':flags=bicubic`],
      outputArgs: [],
      params: {
        targetShortSide: target,
        mode: 'expression',
        note: 'source dimensions unknown; clamped inside ffmpeg',
      },
    };
  }

  const shortSide = Math.min(width, height);
  if (shortSide <= target) {
    return {
      filters: [],
      outputArgs: [],
      skip: `source short side is ${shortSide}px, already at or below ${target}p (never upscaled)`,
      params: { targetShortSide: target, sourceWidth: width, sourceHeight: height },
    };
  }

  // Pin the short side to the target, derive the long side from the real ratio.
  let outWidth: number;
  let outHeight: number;
  if (width < height) {
    outWidth = even(target);
    outHeight = even((height * target) / width);
  } else {
    outHeight = even(target);
    outWidth = even((width * target) / height);
  }

  return {
    filters: [`scale=${outWidth}:${outHeight}:flags=bicubic`],
    outputArgs: [],
    params: {
      targetShortSide: target,
      sourceWidth: width,
      sourceHeight: height,
      outputWidth: outWidth,
      outputHeight: outHeight,
      scaler: 'bicubic',
    },
  };
};
