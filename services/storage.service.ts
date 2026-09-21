/**
 * Disk monitoring and output-size estimation.
 *
 * The estimator exists so an operator can find out that 1000 videos will not
 * fit *before* spending six hours discovering it. It models the encode rather
 * than guessing a flat multiplier: output size is driven by pixel count, frame
 * rate, CRF and how compressible the degradation leaves the picture.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiskInfo, Estimate, EstimateBreakdown, OutputKind, VideoMetadata } from '@/types';
import { COMBINED_ID } from '@/types';
import { normalize } from '@/utils/paths';

/* -------------------------------------------------------------------------- */
/* Disk                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Free/total space for the filesystem holding `target`.
 *
 * `fs.statfs` is cross-platform from Node 18.15 (it maps onto
 * GetDiskFreeSpaceEx on Windows), so no shelling out to wmic/df is needed.
 * Walks up to the nearest existing ancestor, because the output folder usually
 * does not exist yet when the user asks for an estimate.
 */
export async function getDiskInfo(target: string): Promise<DiskInfo> {
  let probePath = normalize(target);

  for (let i = 0; i < 40; i += 1) {
    const exists = await fs.stat(probePath).then(() => true).catch(() => false);
    if (exists) break;
    const parent = path.dirname(probePath);
    if (parent === probePath) break;
    probePath = parent;
  }

  try {
    const stats = await fs.statfs(probePath);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    // bavail is space available to this (unprivileged) user, which is the
    // number that actually matters; bfree includes reserved blocks.
    const freeBytes = Number(stats.bavail) * blockSize;
    return {
      path: probePath,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - Number(stats.bfree) * blockSize),
      ok: true,
    };
  } catch (error) {
    return {
      path: probePath,
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      ok: false,
      error: (error as Error).message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Output size estimation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bits per pixel per frame for x264 at CRF 23, medium preset, on typical live
 * action. Halving/doubling every 6 CRF steps is the usual rule of thumb.
 */
const BPP_AT_CRF23 = 0.09;

/** How compressible each degradation leaves the picture, relative to source. */
const COMPLEXITY: Record<OutputKind, number> = {
  blur: 0.55,
  motion_blur: 0.65,
  noise: 2.0,
  compression: 1.0,
  low_resolution: 1.0,
  fps_reduction: 1.0,
  frame_drop: 0.85,
  brightness: 0.95,
  contrast: 0.95,
  saturation: 0.9,
  [COMBINED_ID]: 1.0,
};

const AUDIO_BITRATE_BPS = 128_000;

export interface EstimateInput {
  video: VideoMetadata;
  degradation: OutputKind;
  /** Effective parameters after the processor clamped them. */
  params: Record<string, unknown>;
  crf: number;
}

function numeric(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Estimated size in bytes for one output file.
 *
 * Falls back to a ratio of the source size whenever ffprobe could not supply
 * dimensions or duration, so an unprobeable file still contributes something
 * sensible to the total.
 */
export function estimateOutputBytes(input: EstimateInput): number {
  const { video, degradation, params, crf } = input;

  const duration = video.durationSec;
  const width = numeric(params, 'outputWidth') ?? video.width;
  const height = numeric(params, 'outputHeight') ?? video.height;
  const fps = numeric(params, 'targetFps') ?? video.fps;

  const complexity = COMPLEXITY[degradation] ?? 1.0;

  if (!duration || !width || !height || !fps || duration <= 0) {
    // No probe data: scale the source size by the CRF delta and complexity.
    const crfFactor = 2 ** ((23 - crf) / 6);
    return Math.max(1024, Math.round(video.sizeBytes * Math.min(1.5, crfFactor) * complexity));
  }

  const bpp = BPP_AT_CRF23 * 2 ** ((23 - crf) / 6);
  const videoBitrate = bpp * width * height * fps * complexity;
  const audioBitrate = video.audioCodec ? AUDIO_BITRATE_BPS : 0;
  const bytes = ((videoBitrate + audioBitrate) * duration) / 8;

  // Container overhead, plus a floor so tiny clips are not estimated at zero.
  return Math.max(4096, Math.round(bytes * 1.02));
}

export interface EstimateTaskLike {
  degradation: OutputKind;
  level: string;
  levelLabel: string;
  video: VideoMetadata;
  params: Record<string, unknown>;
  crf: number;
  /** Tasks the planner already resolved as skippable are excluded. */
  willRun: boolean;
}

export function buildEstimate(
  tasks: readonly EstimateTaskLike[],
  videos: readonly VideoMetadata[],
  formula: string,
): Estimate {
  const buckets = new Map<string, EstimateBreakdown>();
  let estimatedOutputBytes = 0;

  for (const task of tasks) {
    if (!task.willRun) continue;
    const bytes = estimateOutputBytes({
      video: task.video,
      degradation: task.degradation,
      params: task.params,
      crf: task.crf,
    });
    estimatedOutputBytes += bytes;

    const key = `${task.degradation}:${task.level}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.outputs += 1;
      existing.estimatedBytes += bytes;
    } else {
      buckets.set(key, {
        degradation: task.degradation,
        level: task.level,
        label: task.levelLabel,
        outputs: 1,
        estimatedBytes: bytes,
      });
    }
  }

  return {
    totalVideos: videos.length,
    totalOutputs: tasks.filter((t) => t.willRun).length,
    inputBytes: videos.reduce((sum, v) => sum + v.sizeBytes, 0),
    estimatedOutputBytes,
    breakdown: [...buckets.values()].sort(
      (a, b) => b.estimatedBytes - a.estimatedBytes || a.label.localeCompare(b.label),
    ),
    formula,
  };
}
