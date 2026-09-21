/**
 * The processor contract.
 *
 * Every degradation is an independent module that turns a `DegradationLevel`
 * into the ffmpeg fragments needed to realise it. Processors are pure: they do
 * no I/O and spawn nothing, which makes the exact command reproducible and
 * lets the UI show the real filter chain before anything is encoded.
 */

import type { DegradationLevel, VideoMetadata } from '@/types';

export interface ProcessorContext {
  /** Probe data for the source. Fields may be null when ffprobe failed. */
  video: Pick<VideoMetadata, 'width' | 'height' | 'fps' | 'durationSec' | 'audioCodec'>;
  /** CRF applied to degradations that are not "compression" themselves. */
  baseCrf: number;
}

export interface ProcessorOutput {
  /** Ordered fragments joined with "," to form the -vf chain. */
  filters: string[];
  /** Extra output arguments (before the output path). */
  outputArgs: string[];
  /** The parameters actually used, after clamping against the source. */
  params: Record<string, unknown>;
  /** Set when this degradation is meaningless for this source. */
  skip?: string;
  /** Overrides ProcessorContext.baseCrf for this output. */
  crf?: number;
  /** Force constant-frame-rate output (frame drop relies on this). */
  forceCfr?: boolean;
  /** Explicit output frame rate, used together with forceCfr. */
  outputFps?: number;
}

export type Processor = (level: DegradationLevel, ctx: ProcessorContext) => ProcessorOutput;

/** Read a numeric level parameter, failing loudly on a malformed catalogue. */
export function num(level: DegradationLevel, key: string): number {
  const raw = level.params[key];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Level "${level.id}" is missing numeric parameter "${key}".`);
  }
  return value;
}
