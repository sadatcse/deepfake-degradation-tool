import type { DegradationId } from '@/types';
import type { Processor } from './types';

import { blurProcessor } from './blur';
import { noiseProcessor } from './noise';
import { compressionProcessor } from './compression';
import { resolutionProcessor } from './resolution';
import { fpsProcessor } from './fps';
import { frameDropProcessor } from './frameDrop';
import { motionBlurProcessor } from './motionBlur';
import { brightnessProcessor } from './brightness';
import { contrastProcessor } from './contrast';
import { saturationProcessor } from './saturation';

/**
 * The processor registry.
 *
 * Kept separate from `index.ts` so `combined.ts` can import it without a
 * circular dependency (index re-exports combined, combined needs the registry).
 */
const REGISTRY: Record<DegradationId, Processor> = {
  blur: blurProcessor,
  noise: noiseProcessor,
  compression: compressionProcessor,
  low_resolution: resolutionProcessor,
  fps_reduction: fpsProcessor,
  frame_drop: frameDropProcessor,
  motion_blur: motionBlurProcessor,
  brightness: brightnessProcessor,
  contrast: contrastProcessor,
  saturation: saturationProcessor,
};

export function getProcessor(id: DegradationId): Processor {
  const processor = REGISTRY[id];
  if (!processor) throw new Error(`No processor registered for "${id}".`);
  return processor;
}
